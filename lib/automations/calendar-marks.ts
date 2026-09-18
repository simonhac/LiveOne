/**
 * Matching runs to the slots that asked for them, and naming what a decided slot came to — the pure
 * half of the calendar feed's account of the past.
 *
 * DB-free, for `exercise.ts`'s reason: every interesting case is a clock case and none of them are
 * testable against a real clock.
 *
 * 🛑 The window is `exercise.ts`'s OWN attribution tolerance, imported rather than restated. A feed
 * that used its own numbers would eventually disagree with the evaluator about whose run a start
 * was — publishing a disagreement inside LiveOne as a fact about the generator.
 *
 * 🛑 **Nothing here infers a verdict from silence.** A slot is ⛔️ because the evaluator RECORDED
 * that it came to nothing, never because the feed re-expanded today's schedule over last month and
 * found no run. That distinction is the whole reason the past is built from records: edit a
 * schedule and the expansion moves, so a verdict derived from it moves with it — which is how a
 * 9 a.m. run came to be published as a 7 a.m. one.
 */
import { ATTRIBUTION_LEAD_MS, ATTRIBUTION_TAIL_MS } from "./exercise";
import type { ExerciseOutcome } from "@/lib/db/planetscale/schema";

/**
 * ✅ it ran · ⏭️ it was deliberately not started · ⛔️ it should have started and did not.
 *
 * `null` means "nothing to say", and is NOT a fourth verdict: no past event is published at all,
 * so the occurrence simply does not appear.
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
 * What a RECORDED decision comes to, as one glyph.
 *
 * Deliberately total and deliberately dull: the evaluator already decided, and this only translates.
 * There is no clock and no run in the signature, because both questions belong elsewhere — a run
 * that happened is published as itself (see the route), so a slot event exists precisely when no run
 * answered for the slot.
 *
 * `waiting` is never stored (`recordSlotOutcome` refuses it) and returns null if a hand-written row
 * ever carries one, so an unfinished slot cannot be published as a failure.
 */
export function markForOutcome(outcome: ExerciseOutcome): SlotMark {
  switch (outcome) {
    // Deliberately not started: the engine had already run enough, or the battery was too full to
    // load it. Only the evaluator's own record can tell this from a plain failure.
    case "satisfied":
    case "skipped-full":
      return "⏭️";
    case "waiting":
      return null;
    // `missed`, `missed-running`, `aborted-unloaded` — and `fired`/`aborted-complete` that no run
    // ever answered for, which is a dispatch that achieved nothing.
    default:
      return "⛔️";
  }
}

/**
 * Match runs to slots, ONE EACH.
 *
 * 🛑 **One run per slot, and the partition is the point.** An earlier version asked two separate
 * questions — "which run does this slot show" (the first in the window) and "which runs did some
 * slot claim" (ALL of them in any window) — and a second start inside one grace window fell down
 * the gap between the answers: the slot showed the first run's duration and the restart was
 * published nowhere at all. A generator that had to be started twice is precisely the morning a
 * subscriber wants to see. Now a slot claims exactly one run and the restart stands on its own.
 *
 * 🛑 Call this ONCE PER DETECTOR, over EVERY rule's slots together — never once per rule and again
 * over the union. Two rules on one generator with overlapping grace windows gave two different
 * answers that way: each rule's own pass showed it the earliest run in its window (the same run,
 * for both), while the union pass claimed two, and the second run vanished from the feed entirely.
 *
 * Earliest slot first, which is deliberate rather than optimal: two slots with different grace
 * windows can be matched more completely by a different assignment. It is the rule a reader can
 * follow, and nothing here has enough slots to notice the difference.
 *
 * 🛑 Time order, and NOT "recorded slots first". A recorded slot and the occurrence today's schedule
 * expands to can be two versions of one morning competing for one run — but that is a SAME-RULE
 * problem and the caller resolves it there, by dropping the stale expansion before it ever gets
 * here (see the route). A global precedence fixes it by breaking something else: a recorded slot on
 * one rule would pre-empt an unrecorded slot on ANOTHER, taking the only run that one could reach
 * and mislabelling a perfectly ordinary start as unscheduled.
 */
export function attributeRuns<T extends RunLike>(
  runs: T[],
  slots: MarkableSlot[],
): Map<string, T> {
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

  return bySlot;
}
