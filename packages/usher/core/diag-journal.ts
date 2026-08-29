/**
 * Collector core — the diagnostic journal (temporary, env-gated).
 *
 * A trimmed sibling of the blackbox: appends arbitrary JSON records to a daily append-only JSONL
 * file `<dir>/YYYY-MM-DD.jsonl` (UTC day) on the persistent volume, gzipping completed days on the
 * roll. Used by musher's MUSHER_DIAGNOSTICS mode to durably capture the FULL DeepSea register dump
 * (all ~94 regs, raw words + decoded value + sentinel reason) on EVERY poll — data that would
 * otherwise be lost to Fly's ephemeral log buffer.
 *
 * Failure posture (same as the blackbox): a broken/full disk DEGRADES journaling (one warning,
 * appends become no-ops) and NEVER throws into the collector loop. Records never contain auth
 * material.
 *
 * ⚠️ SIZING: capture is continuous, not run-gated. A record is ~8.8 KB, so at the temporary 15-second
 * cadence (2026-08-10, chasing the genset's start trigger) that is ~5,760 records ≈ 52 MB/day
 * uncompressed. `maxBytes` (default 100 MB) caps the whole directory, purging OLDEST first.
 *
 * Rolled days compress FAR harder than the "roughly a tenth" rule of thumb this comment used to
 * quote: measured on real days, 2.28 MB → 21 KB, a ratio of ~106:1. That is not luck. A record is
 * ~100 register names with mostly unchanging raw arrays, and the string "not-available/not-
 * configured/not-fitted" alone recurs ~44 times per record and identically across every record of
 * the day; gzip's 32 KB window spans ~4 consecutive records, so it matches nearly all of it. Only
 * batteryV, controllerTime and engineRunTime actually move.
 *
 * So the live day file (~52 MB) dominates the cap and the entire compressed history costs ~0.5 MB
 * a day: steady state at 15 s is roughly THREE MONTHS of history, not the ~11 days a tenfold
 * compression estimate implies. The cap is therefore insurance, not an active constraint — it is
 * unlikely to purge anything before diagnostics are switched off. Still a temporary debugging aid:
 * unset MUSHER_DIAGNOSTICS when the investigation is done.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureWritableDir, gzipFile, listSorted } from "./disk";

const isJsonl = (n: string) => n.endsWith(".jsonl");
/** Both the live day file and the rolled/compressed ones count toward the cap. */
const isJournalFile = (n: string) => n.endsWith(".jsonl") || n.endsWith(".jsonl.gz");

/** Default directory cap. Oldest files go first; the file being written is never purged. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/** Appends between cap sweeps. At 15 s that is ~1 h, so the cap can overshoot by ~2 MB. */
const SWEEP_EVERY_APPENDS = 240;

export interface DiagJournalOptions {
  log?: (m: string) => void;
  /** injectable clock (tests) */
  now?: () => number;
  /** hard cap on the whole diag dir in bytes; default 100 MB */
  maxBytes?: number;
}

export class DiagJournal {
  private enabled = true;
  private warnedDisabled = false;
  private currentDay: string | undefined;
  /** serializes appends + rolls so a day-change can't interleave with a write */
  private queue: Promise<void> = Promise.resolve();

  /** appends since the last cap sweep */
  private sinceSweep = 0;

  private constructor(
    private readonly dir: string,
    private readonly log: (m: string) => void,
    private readonly now: () => number,
    private readonly maxBytes: number,
  ) {}

  /** Create the journal (mkdir + write probe). Returns null — degrade, don't throw — if unwritable. */
  static async create(
    dir: string,
    opts: DiagJournalOptions = {},
  ): Promise<DiagJournal | null> {
    const log = opts.log ?? (() => {});
    if (!(await ensureWritableDir(dir))) {
      log(`diag-journal: ${dir} is not writable — diagnostic capture DISABLED`);
      return null;
    }
    const dj = new DiagJournal(
      dir,
      log,
      opts.now ?? Date.now,
      opts.maxBytes ?? DEFAULT_MAX_BYTES,
    );
    const today = dj.dayOf(dj.now());
    await dj.compressStale(today); // tidy any rolled day from a previous run
    await dj.enforceCap(today); // and bring an over-cap dir back inside it at boot
    return dj;
  }

  private dayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /** Append one record. Serialized; never throws; no-op while disabled. */
  append(record: unknown): Promise<void> {
    this.queue = this.queue.then(() => this.doAppend(record)).catch(() => {}); // doAppend logs; keep the chain alive
    return this.queue;
  }

  private async doAppend(record: unknown): Promise<void> {
    if (!this.enabled) return;
    const day = this.dayOf(this.now());
    try {
      if (this.currentDay !== day) {
        await this.compressStale(day);
        this.currentDay = day;
        this.sinceSweep = SWEEP_EVERY_APPENDS; // a fresh day just rolled — sweep now, not in an hour
      }
      await fs.appendFile(
        path.join(this.dir, `${day}.jsonl`),
        JSON.stringify(record) + "\n",
      );
      if (++this.sinceSweep >= SWEEP_EVERY_APPENDS) {
        this.sinceSweep = 0;
        await this.enforceCap(day); // best-effort; never throws
      }
    } catch (e) {
      this.enabled = false;
      if (!this.warnedDisabled) {
        this.warnedDisabled = true;
        this.log(
          `diag-journal: write failed (${
            e instanceof Error ? e.message : String(e)
          }) — diagnostic capture DISABLED (collection continues)`,
        );
      }
    }
  }

  /** gzip every completed (non-`today`) .jsonl so a finished day is small + easy to fetch. */
  private async compressStale(today: string): Promise<void> {
    const stale = (await listSorted(this.dir, isJsonl)).filter(
      (n) => n !== `${today}.jsonl`,
    );
    for (const name of stale) {
      try {
        await gzipFile(path.join(this.dir, name));
        this.log(`diag-journal: rolled + compressed ${name}`);
      } catch {
        /* leave the file for the next pass */
      }
    }
  }

  /**
   * Hold the directory under `maxBytes` by deleting OLDEST first. Filenames are ISO dates and
   * `listSorted` is name-ascending, so lexical order IS chronological order.
   *
   * `today`'s live file is never deleted — it is the one being appended to, and losing it would
   * throw away the newest data to satisfy a cap. So if today alone exceeds the cap we log once and
   * accept the overshoot rather than doing something destructive; at 46 MB/day against a 100 MB cap
   * that cannot happen, but the cadence is config and the cap is an option, so don't assume it.
   *
   * Best-effort throughout: GC must never break the collector loop, so every step swallows.
   */
  private async enforceCap(today: string): Promise<void> {
    try {
      const active = `${today}.jsonl`;
      const names = await listSorted(this.dir, isJournalFile); // oldest → newest
      const sized: { name: string; size: number }[] = [];
      let total = 0;
      for (const name of names) {
        try {
          const { size } = await fs.stat(path.join(this.dir, name));
          sized.push({ name, size });
          total += size;
        } catch {
          /* vanished between list and stat — ignore */
        }
      }
      if (total <= this.maxBytes) return;

      const before = total;
      let purged = 0;
      for (const { name, size } of sized) {
        if (total <= this.maxBytes) break;
        if (name === active) continue;
        try {
          await fs.unlink(path.join(this.dir, name));
          total -= size;
          purged++;
        } catch {
          /* leave it; the next sweep retries */
        }
      }
      const mb = (b: number) => (b / 1e6).toFixed(1);
      if (purged > 0) {
        this.log(
          `diag-journal: over the ${mb(this.maxBytes)} MB cap at ${mb(before)} MB — purged ${purged} oldest file(s), now ${mb(total)} MB`,
        );
      } else {
        this.log(
          `diag-journal: over the ${mb(this.maxBytes)} MB cap at ${mb(before)} MB but only today's file remains — not purging it`,
        );
      }
    } catch {
      /* GC is best-effort — never break the collector loop */
    }
  }
}
