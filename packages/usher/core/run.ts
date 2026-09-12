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

import { recordProductionRead } from "./trial-monitor";
import { buildReadings } from "./build";
import type { Source } from "./source";
import type { Pusher, PushOutcome } from "./pusher";
import type { Blackbox } from "./blackbox";
import type { Spool } from "./spool";
import { CONTROL_MANIFEST, type RunSupervisor } from "./control";
import type { Courier } from "./courier";
import { delay, withTimeout } from "../lib/async";

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
  /**
   * Where delivered batches go. When present the tick HANDS OFF and returns — the push no longer
   * sits on the poll loop's critical path, so a slow receiver can't cost us readings (it cost ~45
   * on 2026-09-11). Absent = push inline, which is what `--once` and the tests want: they need the
   * outcome back synchronously.
   */
  courier?: Courier;
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
  /**
   * Poll AND push period while the supervisor reports `inTransition()` — the engine is starting or
   * stopping. Undefined or 0 disables the fast bracket entirely.
   *
   * 🛑 Both cadences, deliberately. It is not enough to deliver faster: a transition is only worth
   * watching at 5 s if the rpm being delivered was READ 5 s ago, and the observation is also what
   * opens and closes the window in the first place.
   */
  transitionIntervalMs?: number;
  /** wake on wall-clock multiples of the period (default true) */
  alignToBoundary?: boolean;
  /**
   * Set BY `runEntryLoop`: end the current sleep and tick now. Lets the control route turn a
   * command into a delivery immediately rather than waiting out the boundary (0–15 s at musher's
   * cadence), which is the difference between a tile that moves on the press and one that doesn't.
   * Absent until the loop is running, so every caller must treat it as optional.
   */
  wake?: () => void;
}

export interface RunOptions {
  /** hard cap on a single tick (read+build+push); a hung read/push is aborted so the loop advances */
  tickTimeoutMs?: number;
  log?: (m: string) => void;
  /** run each entry exactly one tick then return (for testing / --once) */
  once?: boolean;
  /** called after each tick with the entry + result — feeds the inspector's UsherState */
  onTick?: (entry: ScheduledEntry, result: TickResult) => void;
  /**
   * Called at the TOP of each tick, before any work. The watchdog needs this rather than onTick:
   * onTick fires only when a tick COMPLETES, and completion is exactly what a stall removes.
   */
  onTickStart?: (entry: ScheduledEntry) => void;
}

/** Default hard cap on a tick. Well above a normal read+push (~1s), well below any poll interval. */
export const DEFAULT_TICK_TIMEOUT_MS = 30_000;

/**
 * Bounds on the tick's non-device awaits. None of these collaborators THROW — they are all written
 * to degrade quietly — but "never settles" is a different failure from "fails", and an unbounded
 * await on one hangs the poll loop for the life of the process. See the 2026-09-11 wedge.
 */
const RECOVERY_TIMEOUT_MS = 10_000; // source.reset() on the read-error path
const STORE_TIMEOUT_MS = 10_000; // blackbox append / spool enqueue (a wedged volume)

/** Outcome of one tick for a single entry. */
export interface TickResult {
  name: string;
  siteId: string;
  /** readings COLLECTED this tick (0 = all n/a), or null on read error — see `delivered` */
  count: number | null;
  /** whether the source reported itself "running"/active this tick — drives the POLL cadence */
  active: boolean;
  /** the same question for delivery (see Source.isDeliveryActive); defaults to `active` */
  deliveryActive: boolean;
  /** ISO time of the tick */
  at: string;
  /**
   * Whether this tick was delivered (journalled to the blackbox + pushed). False on a poll-only
   * tick — the device was read, but the push cadence said "not yet". Undefined when the tick
   * errored or had nothing to send.
   */
  delivered?: boolean;
  /**
   * Whether the push succeeded. Undefined when there was nothing to push — and also whenever the
   * batch was handed to a courier (`queued`), because the answer is not known yet by design. Use
   * the courier's onResult for delivery outcomes.
   */
  pushOk?: boolean;
  /** the batch was handed to the courier rather than pushed inline; `pushOk` will be undefined */
  queued?: boolean;
  /** whether a failed push's batch was durably spooled for later re-send */
  spooled?: boolean;
  /** error message if the tick failed (read/build/push threw or timed out) */
  error?: string;
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

  /**
   * Get a batch delivered. Shared by the happy path and the control-only error path — they had
   * drifted, and only one of them spooled.
   *
   * With a courier this HANDS OFF and returns immediately, so the poll cadence is independent of
   * the receiver. Without one it pushes inline and reports the real outcome, which is what `--once`
   * and the tests need.
   */
  async function deliver(
    batch: ReturnType<typeof buildReadings>,
    hasDeviceReadings: boolean,
  ): Promise<{
    outcome?: PushOutcome;
    spooled?: boolean;
    queued?: boolean;
  }> {
    if (entry.courier) {
      entry.courier.submit({
        siteId: source.siteId,
        sessionLabel,
        measurementTime,
        readings: batch,
        hasDeviceReadings,
      });
      return { queued: true };
    }
    const outcome = await pusher.store(batch, {
      sessionLabel,
      measurementTime,
    });
    if (outcome !== "transient") return { outcome, spooled: undefined };
    try {
      const ok =
        (await withTimeout(
          Promise.resolve(
            spool?.enqueue({
              siteId: source.siteId,
              sessionLabel,
              measurementTime,
              readings: batch,
              spooledAt: new Date().toISOString(),
            }),
          ),
          STORE_TIMEOUT_MS,
          `spool enqueue exceeded ${STORE_TIMEOUT_MS}ms`,
        )) ?? false;
      return { outcome, spooled: ok };
    } catch (e) {
      log(`[${source.name}] ${e instanceof Error ? e.message : String(e)}`);
      return { outcome, spooled: false };
    }
  }

  const supervisor = entry.supervisor ?? null;
  let readings: ReturnType<typeof buildReadings>;
  let active = false;
  let deliveryActive = false;
  let readError: string | undefined;
  try {
    const readStarted = performance.now();
    const values = await withTimeout(
      source.read(),
      timeoutMs,
      `tick exceeded ${timeoutMs}ms (hung read)`,
    ).then(
      (values) => {
        recordProductionRead(
          source.siteId,
          performance.now() - readStarted,
          true,
        );
        return values;
      },
      (error) => {
        recordProductionRead(
          source.siteId,
          performance.now() - readStarted,
          false,
          error,
        );
        throw error;
      },
    );
    // The supervisor learns the engine's ACTUAL state from the poll (fn 33 clears only our latch —
    // input A can keep the engine running; only observation tells the two apart).
    supervisor?.observeValues(values);
    active = source.isRunning?.(values) ?? false;
    deliveryActive = source.isDeliveryActive?.(values) ?? active;
    readings = buildReadings(source.manifest, values);
    try {
      source.capture?.(measurementTime, readings);
    } catch {
      log("trial capture unavailable");
    }
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
    log(`[${source.name}] tick error: ${readError}`);
    // Drop any cached connection so the next tick reconnects (a hung/dead socket won't self-heal).
    // BOUNDED: reset() is implemented by exactly one source (musher), it goes through that source's
    // device mutex, and it ends in its own `.catch(() => {})` — so it can only ever hang, never
    // throw. An unbounded await here hangs the tick, and with it the entry's whole run loop.
    try {
      await withTimeout(
        Promise.resolve(source.reset?.()),
        RECOVERY_TIMEOUT_MS,
        `reset exceeded ${RECOVERY_TIMEOUT_MS}ms`,
      );
    } catch {
      /* best-effort */
    }
    if (!supervisor)
      return {
        ...base,
        count: null,
        active: false,
        deliveryActive: false,
        error: readError,
      };
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
      deliveryActive: false,
      error: readError,
    };
    if (!shouldDeliver(false)) return { ...result, delivered: false };
    // Spool these like any other batch. They used to be pushed and DISCARDED on "transient" — yet
    // a control-only batch during an outage is the most valuable thing the hub emits
    // (`controlState: "stop-failing"` during the very Modbus failure that caused it). Not
    // journalled, though: the blackbox is a record of device readings, and there are none.
    // hasDeviceReadings: false — these are only the synthetic control-plane points.
    const { outcome, spooled, queued } = await deliver(readings, false);
    return {
      ...result,
      delivered: true,
      pushOk: queued ? undefined : outcome === "ok",
      spooled,
      queued,
    };
  }

  if (readings.length === 0) {
    log(`[${source.name}] no readings this tick (all n/a)`);
    return { ...base, count: 0, active, deliveryActive };
  }

  // Poll-only tick: the device was read (and the source journalled whatever it journals), but the
  // push cadence says this one isn't delivered. Return before the blackbox so the flight recorder
  // stays a record of DELIVERIES — otherwise a fast poll cadence would inflate it just as much as
  // it would inflate the receiver, which is the thing we are avoiding.
  if (!shouldDeliver(deliveryActive)) {
    return {
      ...base,
      count: readings.length,
      active,
      deliveryActive,
      delivered: false,
    };
  }

  // Journal BEFORE pushing — the blackbox records what was collected, not what was delivered.
  // Bounded for the same reason as reset(): append() never throws, but a wedged volume makes it
  // never SETTLE, which hangs the tick just as effectively. Losing a journal line beats losing
  // the collector.
  try {
    await withTimeout(
      Promise.resolve(
        blackbox?.append({
          at: new Date().toISOString(),
          siteId: source.siteId,
          sessionLabel,
          measurementTime,
          count: readings.length,
          readings,
        }),
      ),
      STORE_TIMEOUT_MS,
      `blackbox append exceeded ${STORE_TIMEOUT_MS}ms`,
    );
  } catch (e) {
    log(`[${source.name}] ${e instanceof Error ? e.message : String(e)}`);
  }

  const { outcome, spooled, queued } = await deliver(readings, true);

  return {
    ...base,
    count: readings.length,
    active,
    deliveryActive,
    delivered: true,
    queued,
    // Handed off: the outcome is not known yet, and saying "ok" here would be a lie the heartbeat
    // and the inspector would both believe. The courier reports it when it happens.
    pushOk: queued ? undefined : outcome === "ok",
    spooled,
    error: queued
      ? undefined
      : outcome === "ok"
        ? undefined
        : outcome === "transient"
          ? spooled
            ? "push failed (batch spooled for re-send)"
            : "push failed (spool unavailable — batch dropped)"
          : "push rejected by receiver (4xx) — batch dropped",
  };
}

/**
 * Is this tick delivered to gusher, or read-only?
 *
 * Three edges beat the ordinary push period, and each exists because sitting on the fact for the
 * rest of that period would be perverse:
 *  1. the genset started or stopped — the whole reason for polling faster than we push;
 *  2. a command moved the supervisor's state — a start, stop, extend, or failed stop;
 *  3. the engine is mid-transition, where EVERY tick goes (the 5 s bracket).
 * Otherwise it is wall-clock elapsed time since the last delivery, never "every Nth tick": a slow,
 * timed-out or errored poll must not drag the push schedule with it.
 *
 * Pure, and separate from the loop, because it is the piece with interacting clauses — the loop
 * around it is just a timer.
 */
export function shouldDeliverTick(input: {
  /** whether the source reported itself running THIS tick */
  active: boolean;
  /** …and last tick. `undefined` = no successful read yet, so there is no edge to see. */
  wasActive: boolean | undefined;
  /** the supervisor's stateVersion now, and at the last delivery. Both undefined = no supervisor. */
  controlVersion: number | undefined;
  lastControlVersion: number | undefined;
  /** the supervisor says the engine is starting or stopping (and a bracket is configured) */
  inTransition: boolean;
  sinceDeliveredMs: number;
  idlePushMs: number;
  activePushMs: number;
  /**
   * Slack on the "is it due yet" comparison, normally half a poll period.
   *
   * 🛑 Without it a push period that is an exact multiple of the poll period lands one whole tick
   * late, every time. `sinceDeliveredMs` is measured from the END of the previous delivery, which
   * is past its tick boundary by the cost of the tick, while ticks arrive ON the boundary — so the
   * due tick is always a little short and delivery slips to the next one: a 60 s push cadence on a
   * 15 s poll delivered every 75 s, and a 300 s one every 315 s. Half a period is comfortably more
   * than any plausible tick cost and comfortably less than a whole tick, so it corrects the slip
   * without ever delivering a tick early.
   *
   * The slip is far smaller now that the courier owns the push (the tick is a read, not a read plus
   * up to ~74 s of retries) — but it is not zero, so the tolerance stays.
   */
  toleranceMs?: number;
}): boolean {
  if (input.wasActive !== undefined && input.active !== input.wasActive)
    return true;
  if (input.controlVersion !== input.lastControlVersion) return true;
  if (input.inTransition) return true;
  const dueMs = input.active ? input.activePushMs : input.idlePushMs;
  return input.sinceDeliveredMs >= dueMs - (input.toleranceMs ?? 0);
}

/**
 * Run `fn` forever, restarting it with backoff if it ever throws.
 *
 * `runEntryLoop` is a `for(;;)` whose body is wrapped in try/catch at every point we thought could
 * throw — but "every point we thought of" is the same assumption that produced the 2026-09-11
 * wedge. If anything outside those guards throws, that entry's promise rejects, and before this
 * existed the rejection propagated through `Promise.all` into `startUsher`'s `.catch`, which logged
 * one line and left the process serving the inspector happily with ZERO collectors. A silent death
 * with an HTTP server still answering is the worst shape of failure here, so the loop restarts
 * instead.
 *
 * Backoff so a deterministic construction error (a bad host, a missing manifest) cannot spin.
 */
export async function runWithRestart(
  fn: () => Promise<void>,
  opts: {
    label: string;
    log: (m: string) => void;
    minDelayMs?: number;
    maxDelayMs?: number;
    /** stop after this many restarts (tests only; production runs forever) */
    maxRestarts?: number;
  },
): Promise<void> {
  const minDelayMs = opts.minDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;
  let delayMs = minDelayMs;
  let restarts = 0;
  for (;;) {
    try {
      await fn();
      return; // a clean return (--once) is not a crash
    } catch (e) {
      if (opts.maxRestarts !== undefined && restarts >= opts.maxRestarts)
        throw e;
      restarts++;
      opts.log(
        `[${opts.label}] loop crashed: ${e instanceof Error ? e.message : String(e)} — restarting in ${delayMs}ms`,
      );
      await delay(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

/** Run one scheduled entry's independent loop forever: tick → wait its own period → repeat. */
async function runEntryLoop(
  entry: ScheduledEntry,
  log: (m: string) => void,
  tickTimeoutMs?: number,
  onTick?: (entry: ScheduledEntry, result: TickResult) => void,
  onTickStart?: (entry: ScheduledEntry) => void,
): Promise<void> {
  const idleMs = entry.intervalMs;
  const activeMs = entry.activeIntervalMs ?? idleMs;
  const idlePushMs = entry.pushIntervalMs ?? idleMs;
  const activePushMs = entry.activePushIntervalMs ?? idlePushMs;
  const transitionMs = entry.transitionIntervalMs ?? 0;
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

  // Ends the current sleep early. Published on the entry so the control route can reach it through
  // the globalThis registry — see `ScheduledEntry.wake`.
  let wakeResolve: (() => void) | null = null;
  entry.wake = () => wakeResolve?.();

  for (;;) {
    const tickStart = Date.now();
    try {
      onTickStart?.(entry);
    } catch {
      /* a watchdog hook must never break the loop */
    }
    const result = await tickOnce(entry, log, tickTimeoutMs, (active) =>
      shouldDeliverTick({
        active,
        wasActive,
        controlVersion: entry.supervisor?.stateVersion,
        lastControlVersion,
        inTransition: Boolean(transitionMs && entry.supervisor?.inTransition()),
        sinceDeliveredMs: Date.now() - lastDeliveredAt,
        idlePushMs,
        activePushMs,
        // Half a poll period of slack — see `shouldDeliverTick`. Measured against the poll cadence
        // that produced THIS tick, so it is always smaller than the gap to the next one.
        toleranceMs: Math.floor((active ? activeMs : idleMs) / 2),
      }),
    );
    if (result.delivered) {
      lastDeliveredAt = Date.now();
      lastControlVersion = entry.supervisor?.stateVersion;
    }
    // 🛑 The DELIVERY sense, because `wasActive` exists to feed the edge test in
    // `shouldDeliverTick` — comparing it against a differently-defined `active` would manufacture a
    // phantom edge (and an extra push) at the moment musher's diagnostic hold expires.
    if (result.count !== null) wasActive = result.deliveryActive;
    try {
      onTick?.(entry, result);
    } catch {
      /* an inspector hook must never break the loop */
    }
    // Backlog recovery used to live here, gated on this tick's pushOk. It now belongs to the
    // courier, which is the thing that actually knows when the receiver acked — and, unlike this
    // loop, cannot be wedged out of existence (on 2026-09-11 that stranded 46 batches for 4 h 49 m).
    // Without a courier (--once, tests) there is no backlog worth chasing.
    // The transition bracket outranks both ordinary cadences: it is the one window where the
    // interesting thing is happening between ticks rather than at them.
    const periodMs =
      transitionMs && entry.supervisor?.inTransition()
        ? transitionMs
        : result.active
          ? activeMs
          : idleMs;
    const waitMs = align
      ? msUntilNextBoundary(periodMs, Date.now())
      : Math.max(0, periodMs - (Date.now() - tickStart));
    await sleepOrWake(waitMs, (resolve) => {
      wakeResolve = resolve;
    });
    wakeResolve = null;
  }
}

/**
 * Sleep `ms`, or until whoever holds the resolver ends it early — `publish` hands the resolver out
 * before the wait begins. A plain `sleep` cannot be cut short, and the timer is cleared on an early
 * wake so a woken loop leaves nothing pending behind it.
 */
function sleepOrWake(
  ms: number,
  publish: (resolve: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; // a wake racing the timer must not resolve twice
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    publish(finish);
  });
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
        // Named on its own, because it is the one cadence that is neither the poll nor the push but
        // both — and this line is where an operator confirms a deploy actually armed the bracket.
        const transition = e.transitionIntervalMs
          ? ` transition ${e.transitionIntervalMs / 1000}s`
          : "";
        return `${e.source.name} poll ${poll}${push}${transition}`;
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
  // Each entry runs its own independent, never-resolving loop, each restarted on its own if it
  // ever throws. allSettled, not all: one entry dying must not reject the whole set — that is the
  // path by which a single bad source could take every collector down with it.
  await Promise.allSettled(
    entries.map((e) =>
      runWithRestart(
        () =>
          runEntryLoop(
            e,
            log,
            opts.tickTimeoutMs,
            opts.onTick,
            opts.onTickStart,
          ),
        { label: e.source.name, log },
      ),
    ),
  );
}
