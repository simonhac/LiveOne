/**
 * Collector core — the diagnostic journal (temporary, env-gated).
 *
 * A trimmed sibling of the blackbox: appends arbitrary JSON records to a daily append-only JSONL
 * file `<dir>/YYYY-MM-DD.jsonl` (UTC day) on the persistent volume, gzipping completed days on the
 * roll. Used by musher's MUSHER_DIAGNOSTICS mode to durably capture the FULL DeepSea register dump
 * (all ~94 regs, raw words + decoded value + sentinel reason) during a generator run + a short
 * post-run tail — data that would otherwise be lost to Fly's ephemeral log buffer.
 *
 * Failure posture (same as the blackbox): a broken/full disk DEGRADES journaling (one warning,
 * appends become no-ops) and NEVER throws into the collector loop. Unlike the blackbox there is no
 * disk-GC here — the data is tiny (~150 KB/run) and the whole thing is temporary — but appends stop
 * cleanly if the disk fills. Records never contain auth material.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureWritableDir, gzipFile, listSorted } from "./disk";

const isJsonl = (n: string) => n.endsWith(".jsonl");

export interface DiagJournalOptions {
  log?: (m: string) => void;
  /** injectable clock (tests) */
  now?: () => number;
}

export class DiagJournal {
  private enabled = true;
  private warnedDisabled = false;
  private currentDay: string | undefined;
  /** serializes appends + rolls so a day-change can't interleave with a write */
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    private readonly log: (m: string) => void,
    private readonly now: () => number,
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
    const dj = new DiagJournal(dir, log, opts.now ?? Date.now);
    await dj.compressStale(dj.dayOf(dj.now())); // tidy any rolled day from a previous run
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
      }
      await fs.appendFile(
        path.join(this.dir, `${day}.jsonl`),
        JSON.stringify(record) + "\n",
      );
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
}
