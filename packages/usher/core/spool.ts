/**
 * Collector core — the spool: durable buffer of UNDELIVERED batches.
 *
 * A batch lands here only when its push finally fails with a TRANSIENT outcome (network/5xx/429
 * after retries) — never on a 4xx reject. One file per batch (`<spooledAtMs>-<seq>-<siteId>.json`,
 * atomic write), deleted the moment a re-send is acked, so the spool is normally empty. Re-sends
 * are safe: the gush receiver is idempotent on `(systemId, pointId, measurementTime)`.
 *
 * Never-fill guard: the spool may grow to at most SPOOL_MAX_DISK_FRAC (75%) of the filesystem's
 * capacity; past that, the OLDEST unsent batches are dropped with a loud log (they remain
 * recoverable from the blackbox journal). Files never contain the apiKey — it's re-attached from
 * env at send time.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PushReading } from "@liveone/protocol";
import {
  ensureWritableDir,
  atomicWrite,
  diskSpace as defaultDiskSpace,
  listSorted,
  bytesOf,
  type DiskSpaceFn,
} from "./disk";

/** One spooled (undelivered) batch. NO auth material on disk. */
export interface SpooledBatch {
  siteId: string;
  sessionLabel: string;
  measurementTime: string;
  readings: PushReading[];
  /** ISO time the batch was spooled */
  spooledAt: string;
}

/** Re-send outcome, mirroring Pusher.store(): ok = acked, transient = still down, rejected = 4xx. */
export type SpoolSendOutcome = "ok" | "transient" | "rejected";
export type SpoolSend = (batch: SpooledBatch) => Promise<SpoolSendOutcome>;

export interface SpoolStats {
  files: number;
  bytes: number;
  /** spooledAt of the oldest unsent batch */
  oldestAt?: string;
  diskFreeFrac?: number;
}

export interface DrainResult {
  sent: number;
  dropped: number;
  remaining: number;
}

/** The spool may occupy at most this fraction of the filesystem's capacity. */
export const SPOOL_MAX_DISK_FRAC = 0.75;
/** Max batches re-sent per drain call, so a big backlog can't stall the collector cadence. */
export const SPOOL_DRAIN_BUDGET = 50;

const isBatchFile = (n: string) => n.endsWith(".json");
const sanitize = (siteId: string) => siteId.replace(/[^a-zA-Z0-9_-]/g, "_");

export interface SpoolOptions {
  log?: (m: string) => void;
  now?: () => number;
  diskSpaceFn?: DiskSpaceFn;
  maxDiskFrac?: number;
}

export class Spool {
  private seq = 0;
  private readonly draining = new Set<string>();
  private lastStats: SpoolStats = { files: 0, bytes: 0 };

  private constructor(
    private readonly dir: string,
    private readonly log: (m: string) => void,
    private readonly now: () => number,
    private readonly space: DiskSpaceFn,
    private readonly maxDiskFrac: number,
  ) {}

  /** Create the spool dir (probe write). Returns null — degrade, don't throw — if unwritable. */
  static async create(
    dir: string,
    opts: SpoolOptions = {},
  ): Promise<Spool | null> {
    const log = opts.log ?? (() => {});
    if (!(await ensureWritableDir(dir))) {
      log(`spool: ${dir} is not writable — outage buffering DISABLED`);
      return null;
    }
    const spool = new Spool(
      dir,
      log,
      opts.now ?? Date.now,
      opts.diskSpaceFn ?? defaultDiskSpace,
      opts.maxDiskFrac ?? SPOOL_MAX_DISK_FRAC,
    );
    await spool.refreshStats();
    return spool;
  }

  /** Buffer one undelivered batch. Returns false (logged) if it couldn't be persisted. */
  async enqueue(batch: SpooledBatch): Promise<boolean> {
    const data = JSON.stringify(batch);
    try {
      await this.enforceCap(Buffer.byteLength(data));
      const name = `${this.now()}-${this.seq++}-${sanitize(batch.siteId)}.json`;
      await atomicWrite(path.join(this.dir, name), data);
      this.log(
        `spool: buffered ${batch.readings.length} reading(s) for ${batch.siteId} (${name})`,
      );
      await this.refreshStats();
      return true;
    } catch (e) {
      this.log(
        `spool: FAILED to buffer batch for ${batch.siteId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  }

  /** Drop oldest batches until the spool (plus the incoming write) fits under the disk cap. */
  private async enforceCap(incomingBytes: number): Promise<void> {
    const s = await this.space(this.dir);
    if (!s) return; // no probe → can't enforce; the write itself will surface ENOSPC
    const maxBytes = s.capacityBytes * this.maxDiskFrac;
    const names = await listSorted(this.dir, isBatchFile);
    let bytes = await bytesOf(this.dir, names);
    while (bytes + incomingBytes > maxBytes && names.length > 0) {
      const victim = names.shift()!;
      const file = path.join(this.dir, victim);
      const size = (await fs.stat(file).catch(() => null))?.size ?? 0;
      await fs.unlink(file).catch(() => {});
      bytes -= size;
      this.log(
        `spool: over ${this.maxDiskFrac * 100}% of disk — DROPPED oldest unsent batch ${victim} (still in the blackbox journal)`,
      );
    }
  }

  /**
   * Re-send this site's spooled batches, oldest first, up to `budget`. Ack → delete; 4xx reject →
   * delete + loud log (kept in blackbox); transient → stop (receiver still down). Re-entrancy
   * guarded per site so overlapping ticks can't double-send.
   */
  async drain(
    siteId: string,
    send: SpoolSend,
    budget: number = SPOOL_DRAIN_BUDGET,
  ): Promise<DrainResult> {
    const suffix = `-${sanitize(siteId)}.json`;
    const mine = (n: string) => n.endsWith(suffix);
    if (this.draining.has(siteId)) {
      return {
        sent: 0,
        dropped: 0,
        remaining: (await listSorted(this.dir, mine)).length,
      };
    }
    this.draining.add(siteId);
    try {
      let sent = 0;
      let dropped = 0;
      const names = (await listSorted(this.dir, mine)).slice(0, budget);
      for (const name of names) {
        const file = path.join(this.dir, name);
        let batch: SpooledBatch;
        try {
          batch = JSON.parse(await fs.readFile(file, "utf8")) as SpooledBatch;
        } catch {
          await fs.unlink(file).catch(() => {});
          this.log(`spool: unreadable batch file ${name} — deleted`);
          dropped++;
          continue;
        }
        const outcome = await send(batch);
        if (outcome === "transient") break; // receiver still down — try again next drain
        await fs.unlink(file).catch(() => {});
        if (outcome === "ok") {
          sent++;
        } else {
          dropped++;
          this.log(
            `spool: batch ${name} permanently rejected by the receiver — dropped (still in the blackbox journal)`,
          );
        }
      }
      const remaining = (await listSorted(this.dir, mine)).length;
      if (sent > 0 || dropped > 0) {
        this.log(
          `spool: drained ${sent} batch(es) for ${siteId}${
            dropped ? `, dropped ${dropped}` : ""
          } — ${remaining} remaining`,
        );
      }
      await this.refreshStats();
      return { sent, dropped, remaining };
    } finally {
      this.draining.delete(siteId);
    }
  }

  private async refreshStats(): Promise<void> {
    try {
      const names = await listSorted(this.dir, isBatchFile);
      const oldestMs = names.length
        ? Number(names[0].split("-", 1)[0])
        : undefined;
      this.lastStats = {
        files: names.length,
        bytes: await bytesOf(this.dir, names),
        oldestAt:
          oldestMs && Number.isFinite(oldestMs)
            ? new Date(oldestMs).toISOString()
            : undefined,
        diskFreeFrac: (await this.space(this.dir))?.freeFrac,
      };
    } catch {
      /* stats are best-effort */
    }
  }

  /** Cached stats from the last enqueue/drain — sync so the inspector view stays sync. */
  statsSync(): SpoolStats {
    return this.lastStats;
  }
}
