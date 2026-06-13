/**
 * Dynamic, latency-minimizing poll scheduler for OpenElectricity regions.
 *
 * NEM 5-minute intervals (labelled by END in liveone) publish ~1–3 min after the
 * interval ends, sometimes later. Instead of a fixed 5-min cadence, we learn each
 * region's publish delay `D` (EWMA) and only poll inside the expected arrival window,
 * then go quiet until the next interval is due. The minutely cron drives this (≤~1 min
 * worst-case latency); a per-window attempt cap keeps us off the API when data is late.
 *
 * State lives in KV (no schema change). `decidePoll`/`applyObservation` are pure so they
 * can be unit-tested without KV or a clock.
 */

import { kv, kvKey } from "@/lib/kv";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointReadingsAgg5m } from "@/lib/db/planetscale/schema";
import { desc, eq } from "drizzle-orm";

const FIVE_MIN_MS = 5 * 60 * 1000;

export const DEFAULT_DELAY_SEC = 150; // initial guess (~2.5 min)
export const MIN_DELAY_SEC = 60;
export const MAX_DELAY_SEC = 300;
export const EWMA_ALPHA = 0.3;
export const MARGIN_SEC = 30; // poll a touch before the expected landing
export const MAX_POLLS_PER_INTERVAL = 4; // rate-limit guard within one 5-min window

/** Live-poll lookback in steady state: re-pull the last 15 min (≈3 intervals) so the
 *  just-published interval lands and recent revisions heal. A known gap overrides this. */
export const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;
/** Cap on how far back a single live poll reaches to auto-heal a gap after an outage.
 *  24 h ≈ 288 intervals — well under the API's per-request cap, so it fits in one fetch. */
export const MAX_AUTOHEAL_MS = 24 * 60 * 60 * 1000;

export interface OeSchedState {
  /** EWMA of observed publish delay, seconds. */
  delaySec: number;
  /** Newest interval-END (ms) we have captured. */
  lastSeenIntervalEndMs: number;
  /** The interval-END this window's attempt counter belongs to. */
  windowIntervalEndMs: number;
  /** Poll attempts made within the current window. */
  pollsThisWindow: number;
}

export interface PollDecision {
  shouldPoll: boolean;
  reason: string;
  /** When the next poll is expected to be productive (ms epoch). Informational. */
  nextPollMs: number;
  /** State to persist (window resets, attempt increments, delay backoff). */
  newState: OeSchedState;
}

function floor5(ms: number): number {
  return Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Start of the window a live poll should request. Normally `DEFAULT_LOOKBACK_MS` before
 * `baseMs`, but if we're behind (a gap after an outage) it reaches back to the last interval
 * we captured — capped at `MAX_AUTOHEAL_MS` so one poll can't pull an unbounded backlog.
 * Larger gaps are filled by the backfill route / bulk ingestor. Pure/testable.
 */
export function adaptiveLookbackStartMs(
  baseMs: number,
  lastSeenIntervalEndMs: number,
  defaultLookbackMs: number = DEFAULT_LOOKBACK_MS,
  maxAutohealMs: number = MAX_AUTOHEAL_MS,
): number {
  const defaultStart = baseMs - defaultLookbackMs;
  const gapStart =
    lastSeenIntervalEndMs > 0 ? lastSeenIntervalEndMs : defaultStart;
  return Math.max(baseMs - maxAutohealMs, Math.min(defaultStart, gapStart));
}

/**
 * Pure scheduling decision. `lastClosedEndMs` is the most recent 5-min boundary that has
 * already ended (= the interval whose data we want next).
 */
export function decidePoll(args: {
  now: Date;
  state: OeSchedState;
}): PollDecision {
  const nowMs = args.now.getTime();
  const state: OeSchedState = { ...args.state };
  const lastClosedEndMs = floor5(nowMs);

  // Roll the per-window attempt counter when we enter a new interval.
  if (state.windowIntervalEndMs !== lastClosedEndMs) {
    state.windowIntervalEndMs = lastClosedEndMs;
    state.pollsThisWindow = 0;
  }

  const delayMs = state.delaySec * 1000;
  const marginMs = MARGIN_SEC * 1000;

  // Already captured the latest closed interval → sleep until the NEXT one is expected.
  if (state.lastSeenIntervalEndMs >= lastClosedEndMs) {
    const nextPollMs = lastClosedEndMs + FIVE_MIN_MS + delayMs - marginMs;
    return {
      shouldPoll: false,
      reason: `up to date through ${isoOf(lastClosedEndMs)}`,
      nextPollMs,
      newState: state,
    };
  }

  // Missing the latest closed interval — but is its data expected to be published yet?
  const expectedArrivalMs = lastClosedEndMs + delayMs - marginMs;
  if (nowMs < expectedArrivalMs) {
    return {
      shouldPoll: false,
      reason: `awaiting ${isoOf(lastClosedEndMs)} (~${state.delaySec}s publish delay)`,
      nextPollMs: expectedArrivalMs,
      newState: state,
    };
  }

  // In the arrival window but persistently late → back off to next interval, nudge D up.
  if (state.pollsThisWindow >= MAX_POLLS_PER_INTERVAL) {
    state.delaySec = clamp(state.delaySec + 30, MIN_DELAY_SEC, MAX_DELAY_SEC);
    const nextPollMs =
      lastClosedEndMs + FIVE_MIN_MS + state.delaySec * 1000 - marginMs;
    return {
      shouldPoll: false,
      reason: `${isoOf(lastClosedEndMs)} overdue; backing off (delay→${state.delaySec}s)`,
      nextPollMs,
      newState: state,
    };
  }

  state.pollsThisWindow += 1;
  return {
    shouldPoll: true,
    reason: `arrival window for ${isoOf(lastClosedEndMs)} (attempt ${state.pollsThisWindow})`,
    nextPollMs: nowMs + 60_000, // retry next minute if this attempt misses
    newState: state,
  };
}

/**
 * Pure EWMA update applied after a NEW interval is captured. Re-pulls of an already-seen
 * interval (revisions) don't move the estimate. Returns the same reference when unchanged.
 */
export function applyObservation(
  state: OeSchedState,
  capturedIntervalEndMs: number,
  observedAtMs: number,
): OeSchedState {
  if (capturedIntervalEndMs <= state.lastSeenIntervalEndMs) return state;
  const observed = clamp(
    (observedAtMs - capturedIntervalEndMs) / 1000,
    MIN_DELAY_SEC,
    MAX_DELAY_SEC,
  );
  const delaySec = Math.round(
    EWMA_ALPHA * observed + (1 - EWMA_ALPHA) * state.delaySec,
  );
  return { ...state, delaySec, lastSeenIntervalEndMs: capturedIntervalEndMs };
}

function stateKey(systemId: number): string {
  return kvKey(`oe:sched:system:${systemId}`);
}

/** Load KV state, or seed it (delay default + lastSeen from the newest stored interval). */
export async function loadState(systemId: number): Promise<OeSchedState> {
  const existing = await kv.get<OeSchedState>(stateKey(systemId));
  if (existing && typeof existing.delaySec === "number") return existing;

  let lastSeenIntervalEndMs = 0;
  try {
    const rows = await requirePlanetscaleDb()
      .select({ intervalEnd: pointReadingsAgg5m.intervalEnd })
      .from(pointReadingsAgg5m)
      .where(eq(pointReadingsAgg5m.systemId, systemId))
      .orderBy(desc(pointReadingsAgg5m.intervalEnd))
      .limit(1);
    if (rows[0]?.intervalEnd) {
      lastSeenIntervalEndMs = new Date(rows[0].intervalEnd).getTime();
    }
  } catch {
    // Best-effort seed; default delay still drives a sane first poll.
  }

  return {
    delaySec: DEFAULT_DELAY_SEC,
    lastSeenIntervalEndMs,
    windowIntervalEndMs: 0,
    pollsThisWindow: 0,
  };
}

export async function saveState(
  systemId: number,
  state: OeSchedState,
): Promise<void> {
  await kv.set(stateKey(systemId), state);
}

/** Record a freshly-captured interval, updating the learned delay (EWMA). */
export async function recordObservation(args: {
  systemId: number;
  capturedIntervalEndMs: number;
  observedAtMs: number;
}): Promise<void> {
  const state = await loadState(args.systemId);
  const next = applyObservation(
    state,
    args.capturedIntervalEndMs,
    args.observedAtMs,
  );
  if (next !== state) await saveState(args.systemId, next);
}
