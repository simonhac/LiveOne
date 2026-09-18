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
import type {
  ExerciseArmedContext,
  ExerciseOutcome,
} from "@/lib/db/planetscale/schema";
import type { Slot } from "./recurrence";

/**
 * Why a slot is not ours to act on — the two cases mean different things to the caller.
 *
 * `dealt-with` is terminal for that slot, so it is the answer that may also retire a spent rule.
 * `predates-rule` is not: the rule simply has not started yet, and disabling it there would kill a
 * schedule for having been written before its own first occurrence.
 */
export type NotDueReason = "dealt-with" | "predates-rule";

/**
 * Is this slot still ours to act on, and if not, why?
 *
 * 🛑 `lastTriggeredRunStart` is a WATERMARK, not a record of one slot. It is a single timestamp
 * column, so a watermark is the only thing it can express — and reading it as set membership (an
 * exact `===`) is how removing a consumed occurrence re-armed an earlier one: two slots inside one
 * grace window both get dealt with, the key holds the LATER one, and an EXDATE on that later slot
 * makes `previousOccurrence` return the earlier slot, which no longer matches the key and is still
 * inside grace. The engine then starts for an occurrence it had already handled.
 *
 * `<=` says what the column means: everything up to and including this instant is dealt with. Every
 * terminal outcome consumes (`fired`, `satisfied`, `missed`, `missed-running`) and `waiting`
 * deliberately does not, so the watermark advances exactly when the slot is genuinely closed out.
 * What it gives up is an `rdate` added EARLIER than the last consumed slot ever firing, which is
 * the right answer rather than a regression: that occurrence is in the past and already superseded.
 *
 * The slot instant is computed rather than observed, so it cannot drift the way a run's
 * `start_time` does — the comparison stays exact arithmetic either way.
 */
export function isDue(args: {
  slot: Slot;
  lastTriggeredRunStartMs: number | null;
  createdAtMs: number;
}): { due: true } | { due: false; reason: NotDueReason } {
  // 🛑 The null guard is explicit and must stay that way. `slot.atMs <= null` coerces the null to 0
  // in JS, so a bare `<=` would answer "not due" for EVERY slot on a rule that has never fired.
  if (
    args.lastTriggeredRunStartMs !== null &&
    args.slot.atMs <= args.lastTriggeredRunStartMs
  )
    return { due: false, reason: "dealt-with" };
  // `previousOccurrence` happily returns a slot from before the automation was created, and
  // reporting that as a missed exercise would be blaming the rule for a week it did not exist.
  if (args.slot.atMs < args.createdAtMs)
    return { due: false, reason: "predates-rule" };
  return { due: true };
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

/** One dispatch this rule made: when we asked, and for how long. */
export interface CommandedRun {
  requestedAtMs: number;
  /** The commanded duration in minutes; null if the command carried no value. */
  minutes: number | null;
}

/**
 * How far either side of a command a run may start and still be counted as that command's doing.
 *
 * LEAD covers a detector boundary rounding a start slightly before the command that caused it;
 * TAIL covers crank, a restart under the latch, and the hub releasing a touch late.
 *
 * Both are generous on purpose, because the two errors are not symmetric — and note the direction,
 * which is the opposite of the intuitive one. Over-attributing DISCARDS a run from the evidence, so
 * the rule is less likely to be satisfied and exercises the engine again: an unnecessary run.
 * Under-attributing counts our own exercise as evidence and SKIPS the next one, letting the engine
 * wet-stack — the failure this whole feature exists to prevent. So when in doubt, claim the run.
 *
 * EXPORTED because the calendar feed asks the same question of a SLOT that this asks of a command —
 * "did this run start close enough to count as that one's doing" — and the two answers must not be
 * allowed to drift. A feed that marked a slot ⛔️ while the evaluator had counted the very same run
 * as the slot's own would be reporting a disagreement inside LiveOne as a fact about the generator.
 */
export const ATTRIBUTION_LEAD_MS = 120_000;
export const ATTRIBUTION_TAIL_MS = 300_000;

/**
 * Was this run started by one of OUR OWN dispatches?
 *
 * 🛑 The `unless` window means "runtime over the last week APART FROM the run we started". Without
 * this the rule satisfies itself: a 30-minute exercise yields ~30 loaded minutes (measured on prod
 * — ramp is negligible, a commanded 10-minute run produced ~10 loaded minutes), which clears a
 * `minMinutes: 30` bar and skips the FOLLOWING week. The result is a generator exercised every
 * other Thursday by a rule that reads as weekly.
 *
 * Attribution is by START instant, not overlap: a run already under way when we commanded is not
 * ours, and `decideExercise`'s open-run branch is what handles that case.
 */
export function isSelfCommandedRun(
  runStartMs: number,
  commands: CommandedRun[],
): boolean {
  return commands.some((c) => {
    // A zero-minute command is a STOP — on the run-request point it releases the hub's latch. It
    // cannot have started anything, so letting it claim a run would discount somebody else's work
    // for the crime of starting just after we stopped ours.
    if (c.minutes === 0) return false;
    const from = c.requestedAtMs - ATTRIBUTION_LEAD_MS;
    const to =
      c.requestedAtMs + (c.minutes ?? 0) * 60_000 + ATTRIBUTION_TAIL_MS;
    return runStartMs >= from && runStartMs <= to;
  });
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

/**
 * Has a run WE started stopped being loaded?
 *
 * 🛑 Evaluated on EVERY tick from `settleMinutes` to the end of the run, not once at the settle
 * mark. `runMinutes` is passed in rather than inferred so the caller owns the clock, per this
 * module's no-`Date.now()` rule — but the continuous part is the point. On 2026-09-17 the engine
 * read 1.58 kW at minute 10, cleared a 1.5 kW floor, and then ran 16 more minutes between 0.18 and
 * 0.61 kW; a one-shot check at the settle mark passes exactly the run worth aborting.
 *
 * Conservative in the opposite direction from `longestLoadedStretch`, and deliberately so: that one
 * shortens a stretch when unsure, this one declines to abort when unsure. A window with NO samples
 * is not an abort — missing telemetry is not an observation of low load, and stopping an engine on
 * an absence would make a WireGuard hiccup look like a policy decision.
 */
export function shouldAbortRun(
  samples: LoadedSample[],
  runMinutes: number,
  opts: { minLoadKw: number; settleMinutes: number; sustainMinutes: number },
): boolean {
  if (runMinutes < opts.settleMinutes) return false;

  const valued = samples.filter((s) => s.value !== null);
  if (valued.length === 0) return false;

  // The window must actually SPAN the sustain period. A single sample, or a burst inside one
  // minute, says nothing about the last `sustainMinutes` — and would abort on one stray reading.
  const first = Math.min(...valued.map((s) => s.tMs));
  const last = Math.max(...valued.map((s) => s.tMs));
  if ((last - first) / 60_000 < opts.sustainMinutes - 1) return false;

  return valued.every((s) => importKw(s.value as number) < opts.minLoadKw);
}

export interface ExerciseInputs {
  slot: Slot;
  graceMinutes: number;
  /**
   * The bar the evidence must clear to count as "already exercised".
   *
   * Undefined when the rule has NO skip condition (`trigger.unless` absent) — an unconditional
   * rule runs whenever it is due. Deliberately absent rather than a number chosen to be
   * unreachable: an unreachable threshold is a lie that gets rendered, and it was rendered, to
   * every subscriber of the area's calendar feed.
   */
  minMinutes?: number;
  /** The best loaded stretch found inside the lookback, if any. Always null without a skip condition. */
  evidence: LoadedStretch | null;
  /** True when the run detector currently has an open interval. */
  openRun: boolean;
  /** Runs in the lookback that were weighed (i.e. not our own). */
  runsConsidered?: number;
  /** Runs in the lookback discounted as started by this rule — see `isSelfCommandedRun`. */
  runsExcluded?: number;
  /**
   * The readiness gate, when one is configured: the state of charge read at the slot and the
   * ceiling it must be under. `socPercent: null` means the gate is configured but unreadable.
   */
  readiness?: { socPercent: number | null; maxSocPercent: number };
  /** The decision already on the row, so the per-slot tick counters can advance. */
  prior?: ExerciseArmedContext | null;
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
  extra?: {
    reason?: string;
    evidence?: LoadedStretch | null;
    final?: boolean;
    runsConsidered?: number;
    runsExcluded?: number;
    socPercent?: number | null;
    abortedAt?: number;
    /**
     * The context this row already carried, so the tick counters can advance.
     *
     * Carried forward only while the SLOT is the same; a new slot starts a new count, which is what
     * makes "seen due N times" a statement about one occurrence rather than about the rule's life.
     */
    prior?: ExerciseArmedContext | null;
    /**
     * `count` — this tick SAW the slot due, so advance the counter. The default, and what every
     * decision branch wants.
     *
     * `carry` — preserve the slot's counters untouched. Supervision uses this: stopping a run is
     * not another tick that found the slot due, and incrementing there would inflate the one number
     * whose whole job is to say how many ticks looked at an outstanding slot.
     */
    tickMode?: "count" | "carry";
  },
): ExerciseArmedContext {
  const ctx: ExerciseArmedContext = {
    kind: "exercise",
    slotAt: slot.atMs,
    outcome,
    at: nowMs,
  };
  if (extra?.reason) ctx.reason = extra.reason;
  if (extra?.final) ctx.final = true;
  // Recorded even when zero: "no runs to weigh" and "one run, discounted as ours" are the two
  // readings of an empty `evidence`, and only these tell them apart on the record.
  if (extra?.runsConsidered !== undefined)
    ctx.runsConsidered = extra.runsConsidered;
  if (extra?.runsExcluded !== undefined) ctx.runsExcluded = extra.runsExcluded;
  if (extra?.socPercent !== undefined && extra.socPercent !== null)
    ctx.socPercent = extra.socPercent;
  if (extra?.abortedAt !== undefined) ctx.abortedAt = extra.abortedAt;

  const prior = extra?.prior;
  const sameSlot = prior != null && prior.slotAt === slot.atMs;
  if (extra?.tickMode === "carry") {
    // Carry only what exists; inventing a count here would claim a sighting that never happened.
    if (sameSlot && prior.firstSeenAt !== undefined)
      ctx.firstSeenAt = prior.firstSeenAt;
    if (sameSlot && prior.ticks !== undefined) ctx.ticks = prior.ticks;
  } else {
    ctx.firstSeenAt = sameSlot ? (prior.firstSeenAt ?? prior.at) : nowMs;
    ctx.ticks = sameSlot ? (prior.ticks ?? 1) + 1 : 1;
  }
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
 *  1. Already exercised → done, whatever else is true. Cheapest and most common outcome. A rule
 *     with no skip condition never reaches this branch: it has no bar and no evidence.
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
  const counts = {
    runsConsidered: input.runsConsidered,
    runsExcluded: input.runsExcluded,
    prior: input.prior,
  };

  // Both halves are required: without a skip condition there is no bar to clear, and the lookback
  // that would produce `evidence` is never run.
  if (
    evidence !== null &&
    input.minMinutes !== undefined &&
    evidence.minutes >= input.minMinutes
  )
    return {
      kind: "consume",
      context: exerciseContext(slot, "satisfied", nowMs, {
        evidence,
        ...counts,
      }),
    };

  if (nowMs > slot.atMs + input.graceMinutes * 60_000) {
    const lateBy = Math.round((nowMs - slot.atMs) / 60_000);
    return {
      kind: "consume",
      context: exerciseContext(
        slot,
        input.openRun ? "missed-running" : "missed",
        nowMs,
        {
          evidence,
          ...counts,
          // 🛑 A `missed` used to carry no reason at all, which is what made the 2026-09-12 slot
          // opaque for days. Say how long the grace window was, how far past it we are, and — with
          // `ticks` — whether anything ever looked at the slot while it was still actionable.
          reason:
            `grace of ${input.graceMinutes} min expired; ${lateBy} min past the slot` +
            (input.openRun ? ", and a run was in progress" : ""),
        },
      ),
    };
  }

  // 🛑 CONSUMES the slot rather than waiting. Inside the grace window the state of charge only goes
  // UP — the gate exists because solar refills the battery through the morning — so retrying until
  // grace expires could not succeed and would only turn a clean "skipped, too full" into a "missed".
  // An unreadable SoC does NOT block: it degrades to starting, because failing to exercise the
  // engine is the worse outcome and a silent sensor should not quietly retire the feature.
  const readiness = input.readiness;
  if (
    readiness &&
    readiness.socPercent !== null &&
    readiness.socPercent >= readiness.maxSocPercent
  )
    return {
      kind: "consume",
      context: exerciseContext(slot, "skipped-full", nowMs, {
        evidence,
        ...counts,
        socPercent: readiness.socPercent,
        reason:
          `battery at ${readiness.socPercent.toFixed(1)}% (gate ${readiness.maxSocPercent}%) — ` +
          `nothing to load the engine with`,
      }),
    };

  if (input.openRun)
    return {
      kind: "wait",
      context: exerciseContext(slot, "waiting", nowMs, {
        reason: "a run is already in progress",
        evidence,
        ...counts,
      }),
    };

  return { kind: "dispatch" };
}
