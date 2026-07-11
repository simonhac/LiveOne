/**
 * Collector core — the run loop. Polls each source on a fixed interval and pushes its readings to
 * gusher. Tolerates per-tick errors (a failed read/push is logged and skipped — the next tick sends
 * fresh data), so brief Starlink drops don't kill the collector.
 */

import { buildReadings } from "./build";
import type { Source } from "./source";
import type { Pusher } from "./pusher";

export interface Entry {
  source: Source;
  pusher: Pusher;
}

export interface RunOptions {
  intervalMs: number;
  log?: (m: string) => void;
  /** stop after one tick (for testing) */
  once?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one tick for a single entry: read → build → push. Returns readings count (or null on error). */
export async function tickOnce(
  { source, pusher }: Entry,
  log: (m: string) => void,
): Promise<number | null> {
  const tickStart = Date.now();
  const measurementTime = new Date(tickStart).toISOString();
  try {
    const values = await source.read();
    const readings = buildReadings(source.manifest, values);
    if (readings.length === 0) {
      log(`[${source.name}] no readings this tick (all n/a)`);
      return 0;
    }
    await pusher.store(readings, {
      sessionLabel: `${source.name}/${tickStart}`,
      measurementTime,
    });
    return readings.length;
  } catch (e) {
    log(
      `[${source.name}] tick error: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export async function runLoop(
  entries: Entry[],
  opts: RunOptions,
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  log(
    `collector: ${entries.length} source(s) [${entries.map((e) => e.source.name).join(", ")}], ` +
      `interval ${opts.intervalMs / 1000}s`,
  );
  for (;;) {
    const tickStart = Date.now();
    await Promise.all(entries.map((e) => tickOnce(e, log)));
    if (opts.once) return;
    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(0, opts.intervalMs - elapsed));
  }
}
