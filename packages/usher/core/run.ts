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
import { CONTROL_MANIFEST, type RunSupervisor } from "./control";

export interface Entry {
  source: Source;
  pusher: Pusher;
  /** flight recorder — every collected batch is journalled before the push (null = disabled) */
  blackbox?: Blackbox | null;
  /** durable buffer for batches whose push transiently failed (null = disabled) */
  spool?: Spool | null;
  /**
   * The device's run supervisor (control-enabled sources only). tickOnce feeds it each poll's
   * observation and merges its synthetic control_* points into the reading set — HERE, not inside
   * read(), so `control_state: "stop-failing"` still reaches LiveOne during the very Modbus outage
   * that blocks the poll.
   */
  supervisor?: RunSupervisor | null;
}

/**
 * An entry with its OWN cadences. Each scheduled entry runs an independent loop, so sources with
 * different cadences coexist (e.g. musher 15 s poll / 5 min push; fusher 1 min).
 *
 * POLL ≠ PUSH, in two separate senses:
 *  - a source may poll its device faster INTERNALLY (fusher's Site self-polls every 2 s), and
 *  - the loop may poll faster than it DELIVERS (`pushIntervalMs` > `intervalMs`).
 * The second is what lets musher journal the full register dump every 15 s while LiveOne keeps
 * receiving one reading every 5 minutes.
 */
export interface ScheduledEntry extends Entry {
  /** idle POLL period (ms) — how often the loop reads the source */
  intervalMs: number;
  /** faster poll period while the source reports isRunning (defaults to intervalMs) */
  activeIntervalMs?: number;
  /**
   * Idle PUSH period (ms) — how often a poll is delivered to gusher. Defaults to `intervalMs`
   * (deliver every poll: the historical behaviour). Undelivered ticks still READ the device, so
   * anything the source records internally — musher's diagnostic journal — keeps full poll
   * resolution while deliveries stay rare.
   */
  pushIntervalMs?: number;
  /** push period while the source reports isRunning (defaults to pushIntervalMs) */
  activePushIntervalMs?: number;
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
  /** readings COLLECTED this tick (0 = all n/a), or null on read error — see `delivered` */
  count: number | null;
  /** whether the source reported itself "running"/active this tick */
  active: boolean;
  /** ISO time of the tick */
  at: string;
  /**
   * Whether this tick was delivered (journalled to the blackbox + pushed). False on a poll-only
   * tick — the device was read, but the push cadence said "not yet". Undefined when the tick
   * errored or had nothing to send.
   */
  delivered?: boolean;
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
  /**
   * Decides, AFTER the read (so it can see whether the source is running), whether this tick is
   * delivered. Returning false means read-only: the source still saw the device and recorded
   * whatever it records internally, but nothing is blackboxed or pushed. Defaults to always.
   */
  shouldDeliver: (active: boolean) => boolean = () => true,
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

  const supervisor = entry.supervisor ?? null;
  let readings: ReturnType<typeof buildReadings>;
  let active = false;
  let readError: string | undefined;
  try {
    const values = await withTimeout(
      source.read(),
      timeoutMs,
      `tick exceeded ${timeoutMs}ms (hung read)`,
    );
    // The supervisor learns the engine's ACTUAL state from the poll (fn 33 clears only our latch —
    // input A can keep the engine running; only observation tells the two apart).
    supervisor?.observeValues(values);
    active = source.isRunning?.(values) ?? false;
    readings = buildReadings(source.manifest, values);
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
    log(`[${source.name}] tick error: ${readError}`);
    // Drop any cached connection so the next tick reconnects (a hung/dead socket won't self-heal).
    try {
      await source.reset?.();
    } catch {
      /* best-effort */
    }
    if (!supervisor)
      return { ...base, count: null, active: false, error: readError };
    readings = []; // fall through: the control-plane points below still get delivered
  }

  // Merge the synthetic control-plane points. Deliberately AFTER the read/catch: these must
  // survive a failed device read (a stop-retry loop during an outage is exactly what LiveOne
  // most needs to see).
  if (supervisor) {
    readings.push(
      ...buildReadings(CONTROL_MANIFEST, supervisor.syntheticValues()),
    );
  }

  if (readError) {
    // Control-only tick: the device read failed but the supervisor's points still flow.
    const result = {
      ...base,
      count: null as null,
      active: false,
      error: readError,
    };
    if (!shouldDeliver(false)) return { ...result, delivered: false };
    const outcome = await pusher.store(readings, {
      sessionLabel,
      measurementTime,
    });
    return { ...result, delivered: true, pushOk: outcome === "ok" };
  }

  if (readings.length === 0) {
    log(`[${source.name}] no readings this tick (all n/a)`);
    return { ...base, count: 0, active };
  }

  // Poll-only tick: the device was read (and the source journalled whatever it journals), but the
  // push cadence says this one isn't delivered. Return before the blackbox so the flight recorder
  // stays a record of DELIVERIES — otherwise a fast poll cadence would inflate it just as much as
  // it would inflate the receiver, which is the thing we are avoiding.
  if (!shouldDeliver(active)) {
    return { ...base, count: readings.length, active, delivered: false };
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
    delivered: true,
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
  const idlePushMs = entry.pushIntervalMs ?? idleMs;
  const activePushMs = entry.activePushIntervalMs ?? idlePushMs;
  const align = entry.alignToBoundary ?? true;

  // Delivery is scheduled on WALL-CLOCK elapsed time, not "every Nth tick": a slow, timed-out or
  // errored poll must not drag the push schedule with it. 0 = never delivered, so the first tick
  // always goes.
  let lastDeliveredAt = 0;
  // Previous running state, for the transition push. undefined until the first successful read, so
  // process start is not itself treated as a transition (the first tick delivers anyway).
  let wasActive: boolean | undefined;
  // Previous control stateVersion — a command (start/stop/extend/stop-failure) is an edge exactly
  // like a genset start: it delivers within one poll rather than waiting out the push period.
  let lastControlVersion = entry.supervisor?.stateVersion;

  for (;;) {
    const tickStart = Date.now();
    const result = await tickOnce(entry, log, tickTimeoutMs, (active) => {
      // Deliver immediately when the genset starts or stops. The whole reason for polling faster
      // than we push is to catch that edge, and it would be perverse to see it within one poll and
      // then sit on it for the rest of the push period.
      if (wasActive !== undefined && active !== wasActive) return true;
      if (
        entry.supervisor &&
        entry.supervisor.stateVersion !== lastControlVersion
      )
        return true;
      const dueMs = active ? activePushMs : idlePushMs;
      return Date.now() - lastDeliveredAt >= dueMs;
    });
    if (result.delivered) {
      lastDeliveredAt = Date.now();
      lastControlVersion = entry.supervisor?.stateVersion;
    }
    if (result.count !== null) wasActive = result.active;
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
      .map((e) => {
        const poll =
          `${e.intervalMs / 1000}s` +
          (e.activeIntervalMs && e.activeIntervalMs !== e.intervalMs
            ? `/${e.activeIntervalMs / 1000}s active`
            : "");
        const pushMs = e.pushIntervalMs ?? e.intervalMs;
        const activePushMs = e.activePushIntervalMs ?? pushMs;
        const decoupled =
          pushMs !== e.intervalMs ||
          activePushMs !== (e.activeIntervalMs ?? e.intervalMs);
        const push = decoupled
          ? ` push ${pushMs / 1000}s` +
            (activePushMs !== pushMs ? `/${activePushMs / 1000}s active` : "")
          : "";
        return `${e.source.name} poll ${poll}${push}`;
      })
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
