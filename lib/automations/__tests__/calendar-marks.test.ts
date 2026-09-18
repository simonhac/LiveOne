/**
 * The calendar feed's outcome marking, without a database or a route.
 *
 * What these pin is the EDGES of the attribution window and the one-run-per-slot matching, because
 * that is where the feed can say something false about a generator: a run published twice, or one
 * that belongs to a slot and yet appears nowhere at all.
 *
 * The glyphs themselves are a total mapping from a RECORDED outcome — the feed never infers a
 * verdict from silence, so there is no clock in that half any more.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ATTRIBUTION_LEAD_MS,
  ATTRIBUTION_TAIL_MS,
} from "@/lib/automations/exercise";
import {
  attributeRuns,
  attributionSlackMs,
  markForOutcome,
  slotWindow,
} from "@/lib/automations/calendar-marks";

const SLOT = Date.parse("2026-09-17T09:00:00+10:00");
const GRACE = 180;
const WINDOW_END = SLOT + GRACE * 60_000 + ATTRIBUTION_TAIL_MS;
const LONG_AFTER = WINDOW_END + 86_400_000;

describe("slotWindow", () => {
  it("is the evaluator's own tolerances, spanning the whole grace window", () => {
    expect(slotWindow(SLOT, GRACE)).toEqual({
      fromMs: SLOT - ATTRIBUTION_LEAD_MS,
      toMs: WINDOW_END,
    });
  });

  it("a zero grace is still a window — lead and tail alone", () => {
    expect(slotWindow(SLOT, 0)).toEqual({
      fromMs: SLOT - ATTRIBUTION_LEAD_MS,
      toMs: SLOT + ATTRIBUTION_TAIL_MS,
    });
  });
});

describe("attributionSlackMs", () => {
  it("spans a whole window, so no cutoff can separate a slot from its run", () => {
    const window = slotWindow(SLOT, GRACE);
    expect(attributionSlackMs(GRACE)).toBe(window.toMs - window.fromMs);
  });
});

describe("markForOutcome", () => {
  it("⏭️ for the two outcomes that mean DELIBERATELY not started", () => {
    expect(markForOutcome("satisfied")).toBe("⏭️");
    expect(markForOutcome("skipped-full")).toBe("⏭️");
  });

  it("⛔️ for every outcome that came to nothing", () => {
    for (const outcome of [
      "missed",
      "missed-running",
      "aborted-unloaded",
      // A dispatch no run ever answered for. When a run DID answer, the run is published as itself
      // and no slot event is built at all — so reaching here means nothing ran.
      "fired",
      "aborted-complete",
    ] as const)
      expect(markForOutcome(outcome)).toBe("⛔️");
  });

  it("🛑 says nothing about `waiting` — an unfinished slot is not a failure", () => {
    // `recordSlotOutcome` refuses to store one, so this only guards a hand-written row.
    expect(markForOutcome("waiting")).toBe(null);
  });
});

describe("attributeRuns", () => {
  /** A slot keyed the way the route keys one: rule id, then occurrence. */
  const slot = (atMs: number, graceMinutes = GRACE, rule = "au_a") => ({
    key: `${rule}:${atMs}`,
    atMs,
    graceMinutes,
  });
  const slots = [slot(SLOT)];
  /** What no slot claimed — the route's unscheduled list, derived the way the route derives it. */
  const leftovers = <T>(runs: T[], claimed: Map<string, T>) =>
    runs.filter((r) => ![...claimed.values()].includes(r));

  it("gives a slot its run", () => {
    const run = { startMs: SLOT + 30_000 };
    expect(attributeRuns([run], slots)).toEqual(new Map([[slots[0].key, run]]));
  });

  it("leaves everything else unclaimed", () => {
    const july = { startMs: SLOT - 60 * 86_400_000 };
    const claimed = attributeRuns([july], slots);
    expect(claimed.size).toBe(0);
    expect(leftovers([july], claimed)).toEqual([july]);
  });

  it("🛑 a SECOND run in the same window is left for its own event", () => {
    // The slot used to show the first run while the partition swallowed every run in the window,
    // so a generator that had to be started twice published one run and hid the other.
    const first = { startMs: SLOT + 60_000 };
    const restart = { startMs: SLOT + 40 * 60_000 };
    const claimed = attributeRuns([first, restart], slots);
    expect(claimed.get(slots[0].key)).toBe(first);
    expect(leftovers([first, restart], claimed)).toEqual([restart]);
  });

  it("🛑 two overlapping slots cannot both rest on the same start", () => {
    const second = slot(SLOT + 60 * 60_000);
    const run = { startMs: SLOT + 90 * 60_000 }; // inside BOTH windows
    const claimed = attributeRuns([run], [slots[0], second]);
    expect(claimed.get(slots[0].key)).toBe(run);
    expect(claimed.has(second.key)).toBe(false);
  });

  it("serves slots in time order however they arrive", () => {
    const earlier = slot(SLOT - 7 * 86_400_000);
    const run = { startMs: earlier.atMs + 60_000 };
    // The later slot is listed FIRST; the run still belongs to the earlier one.
    const claimed = attributeRuns([run], [slots[0], earlier]);
    expect(claimed.get(earlier.key)).toBe(run);
    expect(claimed.has(slots[0].key)).toBe(false);
  });

  it("🛑 ONE rule's history never pre-empts ANOTHER rule's slot", () => {
    // Why the record-beats-expansion precedence lives in the route, scoped to a single rule, and
    // not here as a global sort. Rule A (tight grace, no record) can only reach the 09:00 start;
    // rule B (wide grace, recorded) can reach either. Serving records first hands 09:00 to B, and
    // A — which had one candidate — is left with nothing while a perfectly ordinary start is
    // published as unscheduled. Time order matches both.
    const tight = slot(SLOT - 60_000, 1, "au_a");
    const wide = slot(SLOT, 180, "au_b");
    const first = { startMs: SLOT };
    const second = { startMs: SLOT + 10 * 60_000 };
    const claimed = attributeRuns([first, second], [tight, wide]);
    expect(claimed.get(tight.key)).toBe(first);
    expect(claimed.get(wide.key)).toBe(second);
  });

  it("🛑 keys by RULE and occurrence, so simultaneous slots of two rules stay distinct", () => {
    // A standing weekly exercise and a one-off on the same generator, at the same instant. An
    // instant-keyed result merges them and one rule silently wears the other's run.
    const weekly = slot(SLOT, GRACE, "au_a");
    const oneOff = slot(SLOT, GRACE, "au_b");
    const run = { startMs: SLOT + 60_000 };
    const claimed = attributeRuns([run], [weekly, oneOff]);
    expect(claimed.size).toBe(1);
    expect(claimed.get(weekly.key)).toBe(run);
  });

  it("documents the greedy policy: earliest slot first, not the most matches", () => {
    // A long-grace slot takes the earlier run even though yielding it would let a tight-grace slot
    // match too. Earliest-first is the rule a reader can follow; maximum-cardinality matching is
    // not, and nothing here has enough slots to notice.
    const wide = slot(SLOT, 180, "au_a");
    const narrow = slot(SLOT + 60 * 60_000, 1, "au_b");
    const early = { startMs: narrow.atMs };
    const late = { startMs: narrow.atMs + 60 * 60_000 };
    const claimed = attributeRuns([early, late], [wide, narrow]);
    expect(claimed.get(wide.key)).toBe(early);
    expect(claimed.has(narrow.key)).toBe(false);
    expect(leftovers([early, late], claimed)).toEqual([late]);
  });

  it("with no slots at all, nothing is claimed", () => {
    const runs = [{ startMs: SLOT }, { startMs: SLOT + 86_400_000 }];
    expect(attributeRuns(runs, []).size).toBe(0);
  });

  it("a run inside ANY slot's window is claimed, not just the nearest", () => {
    const later = slot(SLOT + 7 * 86_400_000);
    const run = { startMs: later.atMs + 60_000 };
    expect(attributeRuns([run], [slots[0], later]).size).toBe(1);
  });
});
