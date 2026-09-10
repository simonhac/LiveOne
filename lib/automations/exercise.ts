/**
 * The pure half of the scheduled-exercise trigger: when is a run due, and has the engine already
 * done enough work to make one unnecessary.
 *
 * DB-free, `nowMs` INJECTED, `Date.now()` banned — the `decide.ts` discipline, for the same reason:
 * every interesting case here is a clock case (a slot that has just passed, a grace window about to
 * expire, a daylight-saving transition), and none of them are testable against a real clock.
 *
 * Type-only import from the schema, so this module stays cheap to import.
 */
import { fromDate } from "@internationalized/date";
import type {
  AutomationWeekday,
  ExerciseArmedContext,
  ExerciseOutcome,
  ExerciseSchedule,
} from "@/lib/db/planetscale/schema";

/** Aligned to `getUTCDay()`, so `WEEKDAY_AT[dow]` is the key for that day. */
const WEEKDAY_AT: readonly AutomationWeekday[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/**
 * How far back `currentSlot` will look for the most recent slot.
 *
 * Eight days, not seven: a weekly schedule's previous occurrence is exactly seven days back, and
 * looking only seven would make finding it depend on whether today's slot time has passed yet.
 */
const LOOKBACK_DAYS = 8;

/** A scheduled occurrence, as an absolute instant. */
export interface Slot {
  atMs: number;
}

/**
 * The most recent scheduled slot at or before `nowMs`, or null if there is none in the lookback.
 *
 * 🛑 The schedule is LOCAL WALL CLOCK, so this walks back over local calendar days and only then
 * converts to an instant. Doing it the other way round (subtracting 24h from an instant) drifts by
 * an hour across a daylight-saving change, which is exactly when a weekly rule would silently move.
 */
export function currentSlot(
  schedule: ExerciseSchedule,
  timezone: string,
  nowMs: number,
): Slot | null {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const wanted = new Set(schedule.weekdays);
  const today = fromDate(new Date(nowMs), timezone);

  for (let back = 0; back < LOOKBACK_DAYS; back++) {
    const day = back === 0 ? today : today.subtract({ days: back });
    // Weekday from the already-zoned calendar date via UTC math — the `lib/date-utils.ts` idiom.
    // NOT `getDayOfWeek`, which is locale-relative and would put the week's first day elsewhere.
    const dow = new Date(
      Date.UTC(day.year, day.month - 1, day.day),
    ).getUTCDay();
    if (!wanted.has(WEEKDAY_AT[dow])) continue;

    const atMs = day
      .set({ hour, minute, second: 0, millisecond: 0 })
      .toDate()
      .getTime();
    if (atMs <= nowMs) return { atMs };
  }
  return null;
}

/**
 * Is this slot still ours to act on?
 *
 * Two ways it is not: we have already dealt with it (exact match — a slot instant is computed, not
 * observed, so it cannot drift the way a run's start_time does), or it predates the rule itself.
 * The second matters because `currentSlot` happily returns a slot from before the automation was
 * created, and reporting that as a missed exercise would be blaming the rule for a week it did not
 * exist.
 */
export function isDue(args: {
  slot: Slot;
  lastTriggeredRunStartMs: number | null;
  createdAtMs: number;
}): boolean {
  if (args.slot.atMs === args.lastTriggeredRunStartMs) return false;
  if (args.slot.atMs < args.createdAtMs) return false;
  return true;
}

/**
 * Raw watts on the grid-facing point → kW of IMPORT.
 *
 * At off-grid Daylesford the generator is wired where the grid would be, and the Selectronic
 * signs that point negative when the house is drawing from it. Export (positive) is not generator
 * load, so it clamps to zero rather than going negative.
 */
export function importKw(rawW: number): number {
  return Math.max(0, -rawW) / 1000;
}

export interface LoadedSample {
  tMs: number;
  value: number | null;
}

export interface LoadedStretch {
  startMs: number;
  endMs: number;
  minutes: number;
  peakKw: number;
}

export interface StretchOptions {
  minLoadKw: number;
  dipToleranceSeconds: number;
  /** No samples at all for longer than this ends the stretch. */
  gapBreakMs?: number;
}

const DEFAULT_GAP_BREAK_MS = 300_000;

/**
 * The longest continuous run of real load in `samples`, or null if there is none.
 *
 * Deliberately CONSERVATIVE — every ambiguous case shortens the stretch rather than extending it.
 * Under-reporting costs an unnecessary exercise run; over-reporting skips a needed one and lets the
 * engine keep wet-stacking, which is the failure this whole feature exists to prevent.
 *
 * Two different things can interrupt a stretch and they are NOT the same:
 *  - a DIP: samples are present and below the threshold. We know the engine was idling. Bridged
 *    only up to `dipToleranceSeconds`.
 *  - a GAP: no samples at all. We know nothing. Bridged up to `gapBreakMs`.
 * A null value is a gap, not a dip: it is missing data, not an observation of low load.
 */
export function longestLoadedStretch(
  samples: LoadedSample[],
  opts: StretchOptions,
): LoadedStretch | null {
  const dipMs = opts.dipToleranceSeconds * 1000;
  const gapMs = opts.gapBreakMs ?? DEFAULT_GAP_BREAK_MS;
  const ordered = [...samples].sort((a, b) => a.tMs - b.tMs);

  let best: LoadedStretch | null = null;
  let startMs: number | null = null;
  let lastLoadedMs = 0;
  let peakKw = 0;
  let sawDip = false;

  const close = () => {
    if (startMs === null) return;
    const minutes = (lastLoadedMs - startMs) / 60_000;
    if (best === null || minutes > best.minutes)
      best = { startMs, endMs: lastLoadedMs, minutes, peakKw };
    startMs = null;
  };

  for (const s of ordered) {
    if (s.value === null) continue; // a gap contributes nothing either way
    const kw = importKw(s.value);

    if (kw < opts.minLoadKw) {
      sawDip = true;
      continue;
    }

    if (startMs === null) {
      startMs = s.tMs;
      lastLoadedMs = s.tMs;
      peakKw = kw;
      sawDip = false;
      continue;
    }

    // Whether this counts as a bridgeable interruption depends on which kind it was.
    const limit = sawDip ? dipMs : gapMs;
    if (s.tMs - lastLoadedMs > limit) {
      close();
      startMs = s.tMs;
    }
    lastLoadedMs = s.tMs;
    peakKw = Math.max(peakKw, kw);
    sawDip = false;
  }
  close();

  return best;
}

export interface ExerciseInputs {
  slot: Slot;
  graceMinutes: number;
  minMinutes: number;
  /** The best loaded stretch found inside the lookback, if any. */
  evidence: LoadedStretch | null;
  /** True when the run detector currently has an open interval. */
  openRun: boolean;
}

export type ExerciseDecision =
  | { kind: "dispatch" }
  | { kind: "consume"; context: ExerciseArmedContext }
  | { kind: "wait"; context: ExerciseArmedContext };

/** Build the stored decision log entry. */
export function exerciseContext(
  slot: Slot,
  outcome: ExerciseOutcome,
  nowMs: number,
  extra?: { reason?: string; evidence?: LoadedStretch | null },
): ExerciseArmedContext {
  const ctx: ExerciseArmedContext = {
    kind: "exercise",
    slotAt: slot.atMs,
    outcome,
    at: nowMs,
  };
  if (extra?.reason) ctx.reason = extra.reason;
  if (extra?.evidence)
    ctx.evidence = {
      minutes: extra.evidence.minutes,
      peakKw: extra.evidence.peakKw,
      endedAt: extra.evidence.endMs,
    };
  return ctx;
}

/**
 * What to do about a slot that `isDue` has already said is ours.
 *
 * Order matters and is not arbitrary:
 *  1. Already exercised → done, whatever else is true. Cheapest and most common outcome.
 *  2. Grace expired → write it off. Checked BEFORE the open-run case so that a generator that runs
 *     for the entire grace window cannot leave the slot due forever.
 *  3. A run is in progress → wait, and do NOT consume the slot. A `set_value` while the hub holds
 *     the latch recomputes the stop deadline from now, which would truncate whatever longer run
 *     the owner (or another rule) actually asked for.
 *  4. Otherwise dispatch.
 */
export function decideExercise(
  input: ExerciseInputs,
  nowMs: number,
): ExerciseDecision {
  const { slot, evidence } = input;

  if (evidence !== null && evidence.minutes >= input.minMinutes)
    return {
      kind: "consume",
      context: exerciseContext(slot, "satisfied", nowMs, { evidence }),
    };

  if (nowMs > slot.atMs + input.graceMinutes * 60_000)
    return {
      kind: "consume",
      context: exerciseContext(
        slot,
        input.openRun ? "missed-running" : "missed",
        nowMs,
        { evidence },
      ),
    };

  if (input.openRun)
    return {
      kind: "wait",
      context: exerciseContext(slot, "waiting", nowMs, {
        reason: "a run is already in progress",
        evidence,
      }),
    };

  return { kind: "dispatch" };
}
