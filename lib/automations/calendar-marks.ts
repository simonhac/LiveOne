/**
 * What happened to a scheduled slot, as one glyph — the pure half of the calendar feed's outcome
 * marking.
 *
 * DB-free and `nowMs` INJECTED, for `exercise.ts`'s reason: every rule here is a clock rule (a slot
 * still inside its grace window, a slot whose window has just closed) and none of them are testable
 * against a real clock.
 *
 * 🛑 The window is `exercise.ts`'s OWN attribution tolerance, imported rather than restated. A feed
 * that used its own numbers would eventually mark a slot ⛔️ while the evaluator had already counted
 * the same run as that slot's doing — publishing a disagreement inside LiveOne as a fact about the
 * generator.
 */
import { ATTRIBUTION_LEAD_MS, ATTRIBUTION_TAIL_MS } from "./exercise";
import type { ExerciseOutcome } from "@/lib/db/planetscale/schema";

/**
 * ✅ it ran · ⏭️ it was deliberately not started · ⛔️ it should have started and did not.
 *
 * `null` means "nothing to say" — a future slot, one still inside its grace window, or one we
 * cannot honestly judge — and is NOT a fourth verdict: the feed emits no override for it, leaving
 * the occurrence rendered by the master VEVENT exactly as before.
 */
export type SlotMark = "✅" | "⏭️" | "⛔️" | null;

/** Everything the marker needs about a run. A real `derived_intervals` row satisfies it. */
export interface RunLike {
  startMs: number;
}

export interface SlotWindow {
  fromMs: number;
  toMs: number;
}

/** A scheduled occurrence and the window its rule allows a start in. */
export interface MarkableSlot {
  /**
   * The caller's own handle for this occurrence, and what the result is keyed by.
   *
   * 🛑 NOT the instant. Two rules on one generator — a standing weekly exercise and a one-off — can
   * have occurrences at the same moment, and an instant-keyed result silently merges them.
   */
  key: string;
  atMs: number;
  graceMinutes: number;
}

/**
 * When a run must have STARTED to count as this slot's.
 *
 * Lead covers a detector boundary rounding a start slightly before the slot; the tail runs to the
 * end of the grace window — the whole period the evaluator would still have dispatched in — plus
 * the same tolerance for crank and a late hub.
 */
export function slotWindow(slotAtMs: number, graceMinutes: number): SlotWindow {
  return {
    fromMs: slotAtMs - ATTRIBUTION_LEAD_MS,
    toMs: slotAtMs + graceMinutes * 60_000 + ATTRIBUTION_TAIL_MS,
  };
}

/**
 * How far before a history cutoff a slot can sit and still explain a run inside it.
 *
 * Exact rather than a round number: it is the slot's own window, backwards. A feed that expanded
 * occurrences only from its cutoff would drop the slot a run just inside the cutoff belongs to, and
 * then publish that run as "unscheduled" — a false statement built out of an arbitrary boundary.
 */
export function attributionSlackMs(graceMinutes: number): number {
  return graceMinutes * 60_000 + ATTRIBUTION_LEAD_MS + ATTRIBUTION_TAIL_MS;
}

function startsInWindow(run: RunLike, window: SlotWindow): boolean {
  return run.startMs >= window.fromMs && run.startMs <= window.toMs;
}

/**
 * The glyph for one slot. Rules in order, and the order is the whole logic:
 *
 *  1. **A run started in the window → ✅**, whatever the record says. The subscriber's question is
 *     "did the generator run", and a human starting it at the right time answers that as well as a
 *     dispatch does. It also covers `aborted-complete` — supervision stopping a run that had
 *     already done its work is a run that happened.
 *  2. **`satisfied` or `skipped-full` → ⏭️.** Deliberately not started: the engine had already run
 *     enough, or the battery was too full to load it. Only the evaluator's own record can say this
 *     — from the runs alone it is indistinguishable from rule 3.
 *  3. **Past the window with neither → ⛔️**, but only where a failure is a thing we can actually
 *     claim. See `enabled` below.
 *  4. Otherwise **null** — the future, or a slot still inside its grace window and genuinely
 *     undecided.
 */
export function markForSlot(args: {
  slotAtMs: number;
  graceMinutes: number;
  nowMs: number;
  /** The run this slot claims, if any — see `attributeRuns`. */
  run: RunLike | null;
  outcome: ExerciseOutcome | null;
  /**
   * Is the rule enabled NOW?
   *
   * 🛑 Only consulted to SUPPRESS an inferred ⛔️, never to produce one. A disabled rule is not
   * evaluated at all, so its occurrences leave no record and no run — which is exactly the shape
   * this function otherwise reads as "should have started and did not". A rule switched off for a
   * month would accrue a wall of red for weeks nothing was ever going to happen in.
   *
   * The flag is only a proxy — it says what is true now, not what was true then — which is why it
   * cannot suppress a RECORDED failure. The evaluator writing `missed` for a slot proves the rule
   * was live at the time, and that verdict stands however the rule was switched afterwards. What
   * goes is only the verdict inferred from SILENCE, which is the one silence cannot support.
   */
  enabled: boolean;
}): SlotMark {
  const window = slotWindow(args.slotAtMs, args.graceMinutes);
  if (args.run && startsInWindow(args.run, window)) return "✅";
  if (args.outcome === "satisfied" || args.outcome === "skipped-full")
    return "⏭️";
  if (args.nowMs > window.toMs) {
    if (args.outcome !== null) return "⛔️";
    return args.enabled ? "⛔️" : null;
  }
  return null;
}

/**
 * Match runs to slots, ONE EACH, and hand back what nothing claimed.
 *
 * The leftovers are what the feed publishes as unscheduled runs, which is what makes the backfill a
 * property of the feed rather than a one-off script: a manual start next month appears by itself.
 *
 * 🛑 **One run per slot, and the partition is the point.** An earlier version asked two separate
 * questions — "which run does this slot show" (the first in the window) and "which runs did some
 * slot claim" (ALL of them in any window) — and a second start inside one grace window fell down
 * the gap between the answers: the slot showed the first run's duration and the restart was
 * published nowhere at all. A generator that had to be started twice is precisely the morning a
 * subscriber wants to see. Now a slot claims exactly one run and the restart is simply unscheduled,
 * which is what it is.
 *
 * Slots are served in time order, each taking the earliest run it can still have, so two slots
 * whose windows overlap cannot both rest on the same start.
 *
 * 🛑 Call this ONCE PER DETECTOR, over EVERY rule's slots together — never once per rule and again
 * over the union. Two rules on one generator with overlapping grace windows gave two different
 * answers that way: each rule's own pass showed it the earliest run in its window (the same run,
 * for both), while the union pass claimed two, and the second run vanished from the feed entirely.
 * One matching, one set of leftovers.
 *
 * Greedy, earliest slot first, which is deliberate rather than optimal: two slots with different
 * grace windows can be matched more completely by a different assignment (a long-grace slot taking
 * the later run so a zero-grace slot can have the earlier one). Earliest-first is the rule a reader
 * can follow; maximum-cardinality matching is not, and nothing here has enough slots to notice.
 */
export function attributeRuns<T extends RunLike>(
  runs: T[],
  slots: MarkableSlot[],
): { bySlot: Map<string, T>; unattributed: T[] } {
  const ordered = [...runs].sort((a, b) => a.startMs - b.startMs);
  const claimed = new Set<T>();
  const bySlot = new Map<string, T>();

  for (const slot of [...slots].sort((a, b) => a.atMs - b.atMs)) {
    const window = slotWindow(slot.atMs, slot.graceMinutes);
    const run = ordered.find(
      (r) => !claimed.has(r) && startsInWindow(r, window),
    );
    if (!run) continue;
    claimed.add(run);
    bySlot.set(slot.key, run);
  }

  return {
    bySlot,
    unattributed: ordered.filter((r) => !claimed.has(r)),
  };
}
