/**
 * The pure decision core of the charge-limit evaluator.
 *
 * DB-free with `nowMs` INJECTED and `Date.now()` banned — exactly `lib/run-tracking/detect.ts`'s
 * shape, so every row of the decision table is table-testable without a database, a clock, or a
 * vendor.
 *
 * ## The two things this file exists to get right
 *
 * 1. 🛑 **The kWh limit is a DELTA, never an absolute.** The Tesla counter a point-sourced limit
 *    follows (`charge_energy_added`) is energy-above-plug-in-baseline, measured over 3,871
 *    archived payloads: monotonic within a charging leg, but it decays with vampire drain while
 *    plugged in idle and does NOT reset on a top-up restart — only at the first charge start after
 *    a REPLUG. A car re-entering `Charging` on an overnight top-up already reads ~42 kWh against a
 *    ~46 ceiling. An absolute "stop at 20 kWh" would therefore fire instantly, every night. So a
 *    point source snapshots `{baselineKwh, baselineAt}` at ARM time and compares `counter −
 *    baseline`.
 * 2. 🛑 **`start_time` is not a stable key.** `recomputeIntervalsForWindow` is a bounded
 *    delete-and-reinsert and the EV detector's `boundaryMode:'midpoint'` moves an OPEN run's start
 *    between ticks, so "already fired" for a derivation source is a TOLERANCE comparison
 *    (≥ the detector's `delayOffSeconds`, 300 s for EV). For a point source there is no run at all
 *    — the anchor is `armed_at`, a value we wrote ourselves, and the comparison is EXACT. A
 *    tolerance there would be a bug: fire at T, disarm, user restarts, re-arm at T+3 min — a 300 s
 *    tolerance would compare two FIXED timestamps 180 s apart and suppress the new arming forever.
 *
 * Note the deliberate semantic asymmetry: a point source measures "since armed", a derivation
 * source "since run start". For a standing rule they coincide (arming happens within a tick of the
 * session starting); for a `once` created mid-session they differ, because a cable session's total
 * so far is simply unknowable from this counter — that is the whole baseline story.
 */
import type {
  AutomationArmedContext,
  AutomationMode,
} from "@/lib/db/planetscale/schema";

export type SourceStatus = "active" | "inactive" | "unknown";

export interface SourceState {
  status: SourceStatus;
  /** derivation: the open run's startMs (null unless active). point: always null — anchor is armedAt. */
  runStartMs: number | null;
  /** derivation: the open run's energy_kwh (null = unpriceable; only the minutes leg can fire). */
  runKwh: number | null;
  /** point: latest counter reading within the lookback (null = counter unknown this tick). */
  counter: { valueKwh: number; atMs: number } | null;
  /** derivation: max(det.detect.delayOffMs, ANCHOR_TOLERANCE_FLOOR_MS). point: 0 (exact). */
  anchorToleranceMs: number;
}

export interface DecisionInputs {
  mode: AutomationMode;
  sourceKind: "derivation" | "point";
  afterMinutes: number | null;
  afterKwh: number | null;
  armedAtMs: number | null;
  armedContext: AutomationArmedContext | null;
  lastTriggeredRunStartMs: number | null;
}

export type Decision =
  | { kind: "none" }
  | { kind: "arm"; armedContext: AutomationArmedContext | null }
  | { kind: "disarm"; disable: boolean }
  | { kind: "fire"; anchorMs: number }
  /** Counted in the summary; writes nothing. */
  | { kind: "already-fired" };

/** ≥ 2× the 12-minute idle poll cadence, so an idle car's last counter sample is still visible. */
export const POINT_LOOKBACK_MS = 30 * 60_000;
/** 5× the 2-minute charging cadence: a `1` older than this is a poll outage, not a live charge. */
export const ACTIVE_FRESH_MS = 10 * 60_000;
/** Floor for the derivation anchor tolerance — the EV detector's delayOffSeconds. */
export const ANCHOR_TOLERANCE_FLOOR_MS = 300_000;
/**
 * How far BELOW the armed baseline the counter must land to mean "the cable session changed while
 * we weren't looking". The worst observed vampire saw is ~3.5 kWh (42.5 ↔ 46.0, worst single step
 * −0.42), so 5 clears drain with margin, while a real per-cable-session reset from a large
 * baseline drops tens of kWh.
 */
export const RESET_EPSILON_KWH = 5;

/**
 * Classify a point source from its two latest samples.
 *
 * A stale `1` maps to `unknown`, NOT `active`: a poll outage mid-charge must neither fire a limit
 * nor kill one. A `0` at any age inside the lookback is `inactive` — the dangerous direction is
 * stale-1 (which would fire on a car that may have stopped hours ago), not stale-0 (which fails
 * safe by disarming).
 */
export function pointSourceState(
  counter: { valueKwh: number; atMs: number } | null,
  active: { value: number; atMs: number } | null,
  nowMs: number,
): SourceState {
  let status: SourceStatus = "unknown";
  if (active) {
    if (active.value === 0) status = "inactive";
    else if (nowMs - active.atMs <= ACTIVE_FRESH_MS) status = "active";
  }
  return {
    status,
    runStartMs: null,
    runKwh: null,
    counter,
    anchorToleranceMs: 0,
  };
}

export function decideAutomation(
  a: DecisionInputs,
  src: SourceState,
  nowMs: number,
): Decision {
  const armed = a.armedAtMs != null;

  if (!armed) {
    if (src.status === "active") {
      if (a.sourceKind === "point") {
        // No counter reading yet and a kWh leg to serve ⇒ refuse to arm. Arming without a
        // baseline would leave the cap silently unenforced for the whole session.
        if (!src.counter) return a.afterKwh != null ? { kind: "none" } : { kind: "arm", armedContext: null };
        return {
          kind: "arm",
          armedContext: {
            baselineKwh: src.counter.valueKwh,
            // The baseline's timestamp is the READING's, not nowMs — it is when the counter
            // actually said that.
            baselineAt: src.counter.atMs,
          },
        };
      }
      return { kind: "arm", armedContext: null };
    }
    if (src.status === "inactive") {
      // A `once` is "this session". If there is no session, there is nothing for it to latch
      // onto — and latching onto a FUTURE one (a stale limit stopping a charge weeks later) is
      // the worse surprise. So it self-disables rather than waiting.
      return a.mode === "once"
        ? { kind: "disarm", disable: true }
        : { kind: "none" };
    }
    return { kind: "none" }; // unknown
  }

  // ── Armed ──────────────────────────────────────────────────────────────────────────────────
  if (src.status === "unknown") return { kind: "none" }; // never fire AND never disarm on stale data

  if (src.status === "inactive") {
    // Session ended without hitting the limit. (A fired `once` is already disabled and never
    // reaches here.)
    return { kind: "disarm", disable: a.mode === "once" };
  }

  // active
  if (a.sourceKind === "point") {
    const baseline = a.armedContext?.baselineKwh;
    // 🛑 Counter-reset check FIRST, before already-fired. A sleeping car emits no samples, so
    // unplug→replug→charge-start can cross as stale-1 → unknown → fresh active with the rule
    // still armed from the OLD cable session. A standing rule that fired in that old session
    // holds `lastTriggeredRunStart === armedAt`, so already-fired would otherwise pin it
    // armed-and-suppressed (kWh leg dead against a stale baseline, minutes leg suppressed) for
    // the entire new session.
    if (
      src.counter &&
      baseline != null &&
      baseline - src.counter.valueKwh > RESET_EPSILON_KWH
    ) {
      return { kind: "disarm", disable: a.mode === "once" };
    }
  }

  const anchorMs =
    a.sourceKind === "point" ? a.armedAtMs! : (src.runStartMs ?? null);
  if (anchorMs == null) return { kind: "none" };

  if (a.lastTriggeredRunStartMs != null) {
    const fired =
      a.sourceKind === "point"
        ? a.lastTriggeredRunStartMs === anchorMs
        : Math.abs(anchorMs - a.lastTriggeredRunStartMs) <=
          src.anchorToleranceMs;
    if (fired) return { kind: "already-fired" };
  }

  const elapsedMs = nowMs - anchorMs;
  if (a.afterMinutes != null && elapsedMs >= a.afterMinutes * 60_000)
    return { kind: "fire", anchorMs };

  if (a.afterKwh != null) {
    const delta =
      a.sourceKind === "point"
        ? src.counter && a.armedContext?.baselineKwh != null
          ? // Clamp the vampire sag: a counter drifting below its baseline is drain, not
            // negative dispensed energy.
            Math.max(0, src.counter.valueKwh - a.armedContext.baselineKwh)
          : null
        : src.runKwh;
    if (delta != null && delta >= a.afterKwh) return { kind: "fire", anchorMs };
  }

  return { kind: "none" };
}
