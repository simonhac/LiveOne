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
import type { Blackbox } from "./blackbox";
import type { Spool } from "./spool";

export interface Entry {
  source: Source;
  pusher: Pusher;
  /** flight recorder — every collected batch is journalled before the push (null = disabled) */
  blackbox?: Blackbox | null;
  /** durable buffer for batches whose push transiently failed (null = disabled) */
  spool?: Spool | null;
}

/**
 * An entry with its OWN push cadence. Each scheduled entry runs an independent loop, so sources with
 * different cadences coexist (e.g. musher 5 min/1 min; fusher 1 min). Poll ≠ push: a source may poll
 * its device faster internally (fusher's Site self-polls every 2 s) — `intervalMs` here is the PUSH
 * period at which the run-loop harvests + pushes.
 */
export interface ScheduledEntry extends Entry {
  /** idle push period (ms) */
  intervalMs: number;
  /** faster push period while the source reports isRunning (defaults to intervalMs) */
  activeIntervalMs?: number;
  /** wake on wall-clock multiples of the period (default true) */
  alignToBoundary?: boolean;
}

export interface RunOptions {
  /** hard cap on a single tick (read+build+push); a hung read/push is aborted so the loop advances */
  tickTimeoutMs?: number;
  log?: (m: string) => void;
  /** run each entry exactly one tick then return (for testing / --once) */
  once?: boolean;
  /** called after each tick with the entry + result — feeds the inspector's UsherState */
  onTick?: (entry: ScheduledEntry, result: TickResult) => void;
}

/** Default hard cap on a tick. Well above a normal read+push (~1s), well below any poll interval. */
export const DEFAULT_TICK_TIMEOUT_MS = 30_000;

/** Outcome of one tick for a single entry. */
export interface TickResult {
  name: string;
  siteId: string;
  /** readings pushed this tick (0 = all n/a), or null on read/push error */
  count: number | null;
  /** whether the source reported itself "running"/active this tick */
  active: boolean;
  /** ISO time of the tick */
  at: string;
  /** whether the push succeeded (undefined when there was nothing to push) */
  pushOk?: boolean;
  /** whether a failed push's batch was durably spooled for later re-send */
  spooled?: boolean;
  /** error message if the tick failed (read/build/push threw or timed out) */
  error?: string;
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

/**
 * Run one tick for a single entry: read → journal → push (→ spool on transient failure).
 *
 * The hard timeout covers the DEVICE read (a Modbus read on a silently-dead socket can hang
 * forever); the push is self-bounded (per-attempt fetch timeout + capped retries in Pusher), and
 * must stay OUTSIDE the tick timeout so a slow receiver can't abort the tick between "journalled"
 * and "spooled" — that window is exactly where an outage would silently drop the batch.
 */
export async function tickOnce(
  entry: Entry,
  log: (m: string) => void,
  timeoutMs: number = DEFAULT_TICK_TIMEOUT_MS,
): Promise<TickResult> {
  const { source, pusher, blackbox, spool } = entry;
  const tickStart = Date.now();
  const measurementTime = new Date(tickStart).toISOString();
  const sessionLabel = `${source.name}/${tickStart}`;
  const base = {
    name: source.name,
    siteId: source.siteId,
    at: measurementTime,
  };

  let readings: ReturnType<typeof buildReadings>;
  let active: boolean;
  try {
    const values = await withTimeout(
      source.read(),
      timeoutMs,
      `tick exceeded ${timeoutMs}ms (hung read)`,
    );
    active = source.isRunning?.(values) ?? false;
    readings = buildReadings(source.manifest, values);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`[${source.name}] tick error: ${error}`);
    // Drop any cached connection so the next tick reconnects (a hung/dead socket won't self-heal).
    try {
      await source.reset?.();
    } catch {
      /* best-effort */
    }
    return { ...base, count: null, active: false, error };
  }

  if (readings.length === 0) {
    log(`[${source.name}] no readings this tick (all n/a)`);
    return { ...base, count: 0, active };
  }

  // Journal BEFORE pushing — the blackbox records what was collected, not what was delivered.
  await blackbox?.append({
    at: new Date().toISOString(),
    siteId: source.siteId,
    sessionLabel,
    measurementTime,
    count: readings.length,
    readings,
  });

  const outcome = await pusher.store(readings, {
    sessionLabel,
    measurementTime,
  });
  let spooled: boolean | undefined;
  if (outcome === "transient") {
    spooled =
      (await spool?.enqueue({
        siteId: source.siteId,
        sessionLabel,
        measurementTime,
        readings,
        spooledAt: new Date().toISOString(),
      })) ?? false;
  }

  return {
    ...base,
    count: readings.length,
    active,
    pushOk: outcome === "ok",
    spooled,
    error:
      outcome === "ok"
        ? undefined
        : outcome === "transient"
          ? spooled
            ? "push failed (batch spooled for re-send)"
            : "push failed (spool unavailable — batch dropped)"
          : "push rejected by receiver (4xx) — batch dropped",
  };
}

/** Run one scheduled entry's independent loop forever: tick → wait its own period → repeat. */
async function runEntryLoop(
  entry: ScheduledEntry,
  log: (m: string) => void,
  tickTimeoutMs?: number,
  onTick?: (entry: ScheduledEntry, result: TickResult) => void,
): Promise<void> {
  const idleMs = entry.intervalMs;
  const activeMs = entry.activeIntervalMs ?? idleMs;
  const align = entry.alignToBoundary ?? true;
  for (;;) {
    const tickStart = Date.now();
    const result = await tickOnce(entry, log, tickTimeoutMs);
    try {
      onTick?.(entry, result);
    } catch {
      /* an inspector hook must never break the loop */
    }
    // The receiver just acked → it's healthy: re-send any spooled backlog (budget-bounded so a
    // big outage backlog flushes over a few ticks without stalling the cadence).
    if (result.pushOk && entry.spool) {
      try {
        await entry.spool.drain(entry.source.siteId, (b) =>
          entry.pusher.store(b.readings, {
            sessionLabel: b.sessionLabel,
            measurementTime: b.measurementTime,
          }),
        );
      } catch {
        /* drain must never break the loop */
      }
    }
    const periodMs = result.active ? activeMs : idleMs;
    const waitMs = align
      ? msUntilNextBoundary(periodMs, Date.now())
      : Math.max(0, periodMs - (Date.now() - tickStart));
    await sleep(waitMs);
  }
}

export async function runLoop(
  entries: ScheduledEntry[],
  opts: RunOptions = {},
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  log(
    `usher: ${entries.length} source(s) [${entries
      .map(
        (e) =>
          `${e.source.name}@${e.intervalMs / 1000}s` +
          (e.activeIntervalMs && e.activeIntervalMs !== e.intervalMs
            ? `/${e.activeIntervalMs / 1000}s active`
            : ""),
      )
      .join(", ")}]`,
  );
  if (opts.once) {
    // One tick per entry, then return.
    const results = await Promise.all(
      entries.map((e) => tickOnce(e, log, opts.tickTimeoutMs)),
    );
    entries.forEach((e, i) => opts.onTick?.(e, results[i]));
    return;
  }
  // Each entry runs its own independent, never-resolving loop.
  await Promise.all(
    entries.map((e) => runEntryLoop(e, log, opts.tickTimeoutMs, opts.onTick)),
  );
}
