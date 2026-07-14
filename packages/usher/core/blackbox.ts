/**
 * Collector core — the blackbox flight recorder.
 *
 * Journals EVERY collected batch (whether or not the push succeeds) to a daily append-only JSONL
 * file: `<dir>/YYYY-MM-DD.jsonl` (UTC day). At the day roll — and at startup — completed days are
 * immediately gzipped (`.jsonl.gz`, ~15×). The archive is history, not the buffer (that's the
 * spool), so GC may prune it freely: when the filesystem drops below 10% free, the oldest archives
 * are deleted until we're back over the line.
 *
 * Failure posture: a broken/full disk DEGRADES journaling (one warning, appends become no-ops) and
 * never throws into the collector loop. The periodic maintain() re-probes and re-enables when the
 * disk recovers. Records never contain the apiKey.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PushReading } from "@liveone/protocol";
import {
  ensureWritableDir,
  diskSpace as defaultDiskSpace,
  gzipFile,
  listSorted,
  bytesOf,
  type DiskSpaceFn,
} from "./disk";

/** One journal line: a batch as collected (pre-push, no auth material). */
export interface BlackboxRecord {
  /** wall-clock ISO time the batch was journalled */
  at: string;
  siteId: string;
  sessionLabel: string;
  measurementTime: string;
  count: number;
  readings: PushReading[];
}

export interface BlackboxStats {
  enabled: boolean;
  files: number;
  bytes: number;
  oldestDay?: string;
  newestDay?: string;
  /** free fraction of the underlying filesystem at the last maintain() */
  diskFreeFrac?: number;
}

/** GC until the filesystem has at least this fraction free. */
export const BLACKBOX_MIN_FREE_FRAC = 0.1;
/** Log a low-disk warning when free space crosses below these fractions. */
const WARN_FREE_FRACS = [0.25, 0.15];

const isJsonl = (n: string) => n.endsWith(".jsonl");
const isArchive = (n: string) => n.endsWith(".jsonl.gz");

export interface BlackboxOptions {
  log?: (m: string) => void;
  /** injectable clock (tests) */
  now?: () => number;
  /** injectable disk-space probe (tests) */
  diskSpaceFn?: DiskSpaceFn;
}

export class Blackbox {
  private enabled = true;
  private warnedDisabled = false;
  private currentDay: string | undefined;
  /** serializes appends + rolls so a day-change can't interleave with a write */
  private queue: Promise<void> = Promise.resolve();
  private lastWarnFrac: number | undefined;
  private lastStats: BlackboxStats = { enabled: true, files: 0, bytes: 0 };

  private constructor(
    private readonly dir: string,
    private readonly log: (m: string) => void,
    private readonly now: () => number,
    private readonly space: DiskSpaceFn,
  ) {}

  /** Create the journal (mkdir + write probe). Returns null — degrade, don't throw — if unwritable. */
  static async create(
    dir: string,
    opts: BlackboxOptions = {},
  ): Promise<Blackbox | null> {
    const log = opts.log ?? (() => {});
    if (!(await ensureWritableDir(dir))) {
      log(`blackbox: ${dir} is not writable — journaling DISABLED`);
      return null;
    }
    const bb = new Blackbox(
      dir,
      log,
      opts.now ?? Date.now,
      opts.diskSpaceFn ?? defaultDiskSpace,
    );
    await bb.maintain(); // compress any stale day files from a previous run + GC + stats
    return bb;
  }

  private dayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /** Append one batch record. Serialized; never throws; no-op while disabled. */
  append(record: BlackboxRecord): Promise<void> {
    this.queue = this.queue.then(() => this.doAppend(record)).catch(() => {}); // doAppend already logs; keep the chain alive
    return this.queue;
  }

  private async doAppend(record: BlackboxRecord): Promise<void> {
    if (!this.enabled) return;
    const day = this.dayOf(this.now());
    try {
      if (this.currentDay !== day) {
        await this.compressStale(day);
        this.currentDay = day;
      }
      await fs.appendFile(
        path.join(this.dir, `${day}.jsonl`),
        JSON.stringify(record) + "\n",
      );
    } catch (e) {
      this.disable(e);
    }
  }

  private disable(cause: unknown): void {
    this.enabled = false;
    if (!this.warnedDisabled) {
      this.warnedDisabled = true;
      this.log(
        `blackbox: write failed (${
          cause instanceof Error ? cause.message : String(cause)
        }) — journaling DISABLED (collection continues; will re-probe on maintenance)`,
      );
    }
  }

  /** gzip every completed (non-`today`) .jsonl. Failures leave the file for the next pass. */
  private async compressStale(today: string): Promise<void> {
    const stale = (await listSorted(this.dir, isJsonl)).filter(
      (n) => n !== `${today}.jsonl`,
    );
    for (const name of stale) {
      try {
        await gzipFile(path.join(this.dir, name));
        this.log(`blackbox: rolled + compressed ${name}`);
      } catch (e) {
        this.log(
          `blackbox: failed to compress ${name} (will retry): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  /** Delete oldest archives until the filesystem is back above the free-space floor. */
  private async gcIfNeeded(): Promise<void> {
    let s = await this.space(this.dir);
    while (s && s.freeFrac < BLACKBOX_MIN_FREE_FRAC) {
      const archives = await listSorted(this.dir, isArchive);
      if (archives.length === 0) break; // nothing left to free — spool/others own the rest
      const victim = archives[0];
      await fs.unlink(path.join(this.dir, victim)).catch(() => {});
      this.log(
        `blackbox: disk below ${BLACKBOX_MIN_FREE_FRAC * 100}% free — deleted oldest archive ${victim}`,
      );
      s = await this.space(this.dir);
    }
  }

  private warnLowDisk(freeFrac: number): void {
    for (const threshold of WARN_FREE_FRACS) {
      const wasAbove =
        this.lastWarnFrac === undefined || this.lastWarnFrac >= threshold;
      if (freeFrac < threshold && wasAbove) {
        this.log(
          `blackbox: LOW DISK — ${(freeFrac * 100).toFixed(1)}% free (warning threshold ${threshold * 100}%)`,
        );
        break;
      }
    }
    this.lastWarnFrac = freeFrac;
  }

  /**
   * Periodic upkeep (5-min timer + startup): compress completed days, GC to the free-space floor,
   * refresh cached stats, and re-enable journaling if a previously-broken disk recovered.
   */
  async maintain(): Promise<void> {
    try {
      if (!this.enabled && (await ensureWritableDir(this.dir))) {
        this.enabled = true;
        this.warnedDisabled = false;
        this.log("blackbox: disk recovered — journaling re-enabled");
      }
      await this.compressStale(this.dayOf(this.now()));
      await this.gcIfNeeded();
    } catch {
      /* maintenance must never throw into the loop */
    }
    await this.refreshStats();
  }

  private async refreshStats(): Promise<void> {
    try {
      const names = await listSorted(
        this.dir,
        (n) => isJsonl(n) || isArchive(n),
      );
      const s = await this.space(this.dir);
      if (s) this.warnLowDisk(s.freeFrac);
      this.lastStats = {
        enabled: this.enabled,
        files: names.length,
        bytes: await bytesOf(this.dir, names),
        oldestDay: names[0]?.slice(0, 10),
        newestDay: names[names.length - 1]?.slice(0, 10),
        diskFreeFrac: s?.freeFrac,
      };
    } catch {
      /* stats are best-effort */
    }
  }

  /** Cached stats from the last maintain() — sync so the inspector view stays sync. */
  statsSync(): BlackboxStats {
    return this.lastStats;
  }
}
