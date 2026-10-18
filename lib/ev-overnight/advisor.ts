/**
 * EV-overnight advisor — the streaming trigger. Pure: samples in, state + at most one advice out; the
 * clock is the sample's own timestamp (`decide.ts`'s injected-`nowMs` shape).
 *
 * It fires when BOTH hold, each with its own hysteresis:
 *
 * - **the car is charging**: EV ≥ `evOnW` for `evOnSamples` consecutive samples. A session is tracked
 *   from the first sample ≥ `evOffW` until `sessionGapMs` passes without one, and its energy integrated,
 *   so the message can say how much the car will have had IN TOTAL.
 * - **the trigger condition**, one of:
 *   - `battery-feeding-car` (default) — the home battery discharging ≥ `feedW` for `evOnSamples` samples
 *     while the car charges. This is the harm itself rather than its usual cause, and it fires as soon as
 *     the sun can no longer keep up. Chosen over `sun-down` on the pilot-site back-test (Jul–Oct 2026): a
 *     median 125 min of notice before the advised stop vs 85, and 21 run-down nights caught vs 17 — a
 *     charge started before sunset has usually drained the battery by half before solar reads ~zero.
 *   - `sun-down` — MEASURED rather than astronomical: solar < `sunDownEnterW` for `sunDownEnterSamples`
 *     samples enters; only solar > `sunUpExitW` leaves. Measured because dull evenings count and no area
 *     location is needed. While the car charges the inverter is not curtailing, so solar reads true.
 *
 * …and only inside the evening window (`windowFromMin`–`windowToMin`, local), so a heavily overcast
 * midday never reads as night. One advice per charging session — a second session later the same night
 * is a new decision and is advised again.
 */
import type { BatteryParams, Profile, Solution } from "./model";
import { localParts, nightSlot, solveStopTime } from "./model";

type AdvisorTrigger = "sun-down" | "battery-feeding-car";

export interface AdvisorConfig {
  tz: string;
  trigger: AdvisorTrigger;
  evOnW: number;
  evOnSamples: number;
  evOffW: number;
  sessionGapMs: number;
  sunDownEnterW: number;
  sunDownEnterSamples: number;
  sunUpExitW: number;
  /** `battery-feeding-car`: battery discharge (W) that counts as feeding the car. */
  feedW: number;
  /** Local minute-of-day the evening window opens (inclusive) and closes (exclusive, next morning). */
  windowFromMin: number;
  windowToMin: number;
  bufferPct: number;
}

export const DEFAULT_ADVISOR_CONFIG: Omit<AdvisorConfig, "tz"> = {
  trigger: "battery-feeding-car",
  evOnW: 1500,
  evOnSamples: 2,
  evOffW: 100,
  sessionGapMs: 15 * 60_000,
  sunDownEnterW: 150,
  sunDownEnterSamples: 3,
  sunUpExitW: 400,
  feedW: 1000,
  windowFromMin: 15 * 60,
  windowToMin: 4 * 60,
  /**
   * Above the floor. The 7-night typical profile under-stated an EV-free night's need by > 5% SoC on
   * 2% of pilot-site nights (> 3%: 7%), excluding nights the battery exported to the grid in the dark.
   */
  bufferPct: 5,
};

/** A live reading. `t` is when it was taken. */
export interface LiveSample {
  t: number;
  soc: number | null;
  solarW: number | null;
  evW: number | null;
  /** + = discharging. Only the `battery-feeding-car` trigger reads it. */
  batteryW?: number | null;
}

export interface AdvisorState {
  evRun: number;
  feedRun: number;
  lowSolarRun: number;
  sunDown: boolean;
  session: {
    startMs: number;
    lastOnMs: number;
    lastMs: number;
    kwh: number;
  } | null;
  /** Session start times already advised (the dedupe key). */
  advised: number[];
}

export const INITIAL_ADVISOR_STATE: AdvisorState = {
  evRun: 0,
  feedRun: 0,
  lowSolarRun: 0,
  sunDown: false,
  session: null,
  advised: [],
};

export interface Advice {
  atMs: number;
  night: string;
  socPct: number;
  evW: number;
  sessionStartMs: number;
  sessionKwhSoFar: number;
  profileNights: string[];
  solution: Solution;
}

export interface AdvisorContext {
  config: AdvisorConfig;
  battery: BatteryParams;
  /** The typical night to advise against for `night` (built from nights strictly before it). */
  profileFor: (night: string) => Profile | null;
}

const MAX_INTEGRATE_MS = 10 * 60_000;

export function stepAdvisor(
  state: AdvisorState,
  s: LiveSample,
  ctx: AdvisorContext,
): { state: AdvisorState; advice: Advice | null } {
  const c = ctx.config;
  const evW = s.evW ?? 0;
  const solarW = s.solarW;

  // EV session bookkeeping.
  let session = state.session;
  if (session && s.t - session.lastOnMs > c.sessionGapMs) session = null;
  if (evW >= c.evOffW) {
    if (!session)
      session = { startMs: s.t, lastOnMs: s.t, lastMs: s.t, kwh: 0 };
    else {
      const dt = Math.min(s.t - session.lastMs, MAX_INTEGRATE_MS);
      session = {
        ...session,
        lastOnMs: s.t,
        lastMs: s.t,
        kwh: session.kwh + (evW * dt) / 3_600_000_000,
      };
    }
  } else if (session) session = { ...session, lastMs: s.t };
  const evRun = evW >= c.evOnW ? state.evRun + 1 : 0;
  const feedRun =
    evW >= c.evOnW && (s.batteryW ?? 0) >= c.feedW ? state.feedRun + 1 : 0;

  // Sun-down hysteresis. A missing solar reading holds the current state.
  let { lowSolarRun, sunDown } = state;
  if (solarW !== null) {
    if (solarW > c.sunUpExitW) {
      lowSolarRun = 0;
      sunDown = false;
    } else if (solarW < c.sunDownEnterW) {
      lowSolarRun += 1;
      if (lowSolarRun >= c.sunDownEnterSamples) sunDown = true;
    }
  }

  const next: AdvisorState = {
    ...state,
    evRun,
    feedRun,
    lowSolarRun,
    sunDown,
    session,
  };
  const triggered =
    c.trigger === "sun-down" ? sunDown : feedRun >= c.evOnSamples;
  const { minute } = localParts(s.t, c.tz);
  const inWindow = minute >= c.windowFromMin || minute < c.windowToMin;
  if (
    !session ||
    evRun < c.evOnSamples ||
    !triggered ||
    !inWindow ||
    s.soc === null ||
    state.advised.includes(session.startMs)
  )
    return { state: next, advice: null };

  const { night } = nightSlot(s.t, c.tz);
  const profile = ctx.profileFor(night);
  if (!profile) return { state: next, advice: null };
  const solution = solveStopTime({
    nowMs: s.t,
    tz: c.tz,
    socPct: s.soc,
    evW,
    battery: ctx.battery,
    bufferPct: c.bufferPct,
    profile,
  });
  return {
    state: { ...next, advised: [...state.advised.slice(-20), session.startMs] },
    advice: {
      atMs: s.t,
      night,
      socPct: s.soc,
      evW,
      sessionStartMs: session.startMs,
      sessionKwhSoFar: session.kwh,
      profileNights: profile.nights,
      solution,
    },
  };
}
