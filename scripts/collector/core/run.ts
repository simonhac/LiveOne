/**
 * Collector core — the run loop. Polls each source and pushes its readings to gusher. Tolerates
 * per-tick errors (a failed read/push is logged and skipped — the next tick sends fresh data), so
 * brief Starlink drops don't kill the collector.
 *
 * Cadence: when `alignToBoundary` is set, ticks fire on wall-clock boundaries of the chosen period
 * (e.g. every 5 min on :00/:05). If any source reports `isRunning`, the faster `activeIntervalMs`
 * period is used instead (e.g. 1 min while the generator runs). Boundary alignment governs only WHEN
 * we wake — each reading is stamped with its ACTUAL read time, never snapped back to the boundary.
 */

import { buildReadings } from "./build";
import type { Source } from "./source";
import type { Pusher } from "./pusher";

export interface Entry {
  source: Source;
  pusher: Pusher;
}

export interface RunOptions {
  /** the idle / default poll period */
  intervalMs: number;
  /** when a source reports `isRunning`, poll this fast instead (defaults to intervalMs) */
  activeIntervalMs?: number;
  /** sleep to the next wall-clock multiple of the chosen period rather than a fixed delay */
  alignToBoundary?: boolean;
  /** hard cap on a single tick (read+build+push); a hung read/push is aborted so the loop advances */
  tickTimeoutMs?: number;
  log?: (m: string) => void;
  /** stop after one tick (for testing) */
  once?: boolean;
}

/** Default hard cap on a tick. Well above a normal read+push (~1s), well below any poll interval. */
export const DEFAULT_TICK_TIMEOUT_MS = 30_000;

/** Outcome of one tick for a single entry. */
export interface TickResult {
  name: string;
  /** readings pushed this tick (0 = all n/a), or null on read/push error */
  count: number | null;
  /** whether the source reported itself "running"/active this tick */
  active: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reject after `ms` if `p` hasn't settled. Guards the loop against a read/push that hangs forever
 * (e.g. a Modbus read on a silently-dead socket whose library timeout never fires). The late
 * settlement of `p` is swallowed so it can't surface as an unhandled rejection.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  p.catch(() => {}); // don't let a post-timeout rejection become unhandled
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * ms until the next wall-clock multiple of `periodMs`. On an exact boundary this returns a full
 * period (so we don't double-fire). Epoch-ms multiples of 1/5 min land on local :00/:05 for
 * whole-hour UTC offsets (e.g. Victoria).
 */
export function msUntilNextBoundary(periodMs: number, now: number): number {
  const rem = now % periodMs;
  return rem === 0 ? periodMs : periodMs - rem;
}

/** Run one tick for a single entry: read → build → push, under a hard timeout. */
export async function tickOnce(
  { source, pusher }: Entry,
  log: (m: string) => void,
  timeoutMs: number = DEFAULT_TICK_TIMEOUT_MS,
): Promise<TickResult> {
  const tickStart = Date.now();
  const measurementTime = new Date(tickStart).toISOString();
  try {
    const doTick = (async (): Promise<TickResult> => {
      const values = await source.read();
      const active = source.isRunning?.(values) ?? false;
      const readings = buildReadings(source.manifest, values);
      if (readings.length === 0) {
        log(`[${source.name}] no readings this tick (all n/a)`);
        return { name: source.name, count: 0, active };
      }
      await pusher.store(readings, {
        sessionLabel: `${source.name}/${tickStart}`,
        measurementTime,
      });
      return { name: source.name, count: readings.length, active };
    })();
    return await withTimeout(
      doTick,
      timeoutMs,
      `tick exceeded ${timeoutMs}ms (hung read/push)`,
    );
  } catch (e) {
    log(
      `[${source.name}] tick error: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Drop any cached connection so the next tick reconnects (a hung/dead socket won't self-heal).
    try {
      await source.reset?.();
    } catch {
      /* best-effort */
    }
    return { name: source.name, count: null, active: false };
  }
}

export async function runLoop(
  entries: Entry[],
  opts: RunOptions,
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const idleMs = opts.intervalMs;
  const activeMs = opts.activeIntervalMs ?? idleMs;
  log(
    `collector: ${entries.length} source(s) [${entries.map((e) => e.source.name).join(", ")}], ` +
      `interval ${idleMs / 1000}s` +
      (activeMs !== idleMs ? ` (${activeMs / 1000}s while active)` : "") +
      (opts.alignToBoundary ? ", boundary-aligned" : ""),
  );
  for (;;) {
    const tickStart = Date.now();
    const results = await Promise.all(
      entries.map((e) => tickOnce(e, log, opts.tickTimeoutMs)),
    );
    if (opts.once) return;
    const anyActive = results.some((r) => r.active);
    const periodMs = anyActive ? activeMs : idleMs;
    const waitMs = opts.alignToBoundary
      ? msUntilNextBoundary(periodMs, Date.now())
      : Math.max(0, periodMs - (Date.now() - tickStart));
    await sleep(waitMs);
  }
}
