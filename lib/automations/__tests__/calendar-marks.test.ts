/**
 * The calendar feed's outcome marking, without a database or a route.
 *
 * What these pin is the ORDER of the rules and the EDGES of the window, because both are where the
 * feed can say something false about a generator: a slot marked ⛔️ that the evaluator had already
 * counted as run, a run published twice, or — the one a review found — a run that belongs to a slot
 * and yet appears nowhere at all.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ATTRIBUTION_LEAD_MS,
  ATTRIBUTION_TAIL_MS,
} from "@/lib/automations/exercise";
import {
  attributeRuns,
  attributionSlackMs,
  markForSlot,
  slotWindow,
} from "@/lib/automations/calendar-marks";

const SLOT = Date.parse("2026-09-17T09:00:00+10:00");
const GRACE = 180;
const WINDOW_END = SLOT + GRACE * 60_000 + ATTRIBUTION_TAIL_MS;
const LONG_AFTER = WINDOW_END + 86_400_000;

const mark = (over: Partial<Parameters<typeof markForSlot>[0]> = {}) =>
  markForSlot({
    slotAtMs: SLOT,
    graceMinutes: GRACE,
    nowMs: LONG_AFTER,
    run: null,
    outcome: null,
    enabled: true,
    ...over,
  });

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

describe("markForSlot", () => {
  it("✅ when the slot's run started in the window", () => {
    expect(mark({ run: { startMs: SLOT + 60_000 } })).toBe("✅");
  });

  it("is INCLUSIVE of both window edges, and excludes a millisecond outside either", () => {
    const { fromMs, toMs } = slotWindow(SLOT, GRACE);
    expect(mark({ run: { startMs: fromMs } })).toBe("✅");
    expect(mark({ run: { startMs: toMs } })).toBe("✅");
    expect(mark({ run: { startMs: fromMs - 1 } })).toBe("⛔️");
    expect(mark({ run: { startMs: toMs + 1 } })).toBe("⛔️");
  });

  it("matches on the START instant, not overlap — a run already under way is not ours", () => {
    // Started two hours before the slot and still running through it. The evaluator's open-run
    // branch handles this case; it is not evidence that the slot did anything.
    expect(mark({ run: { startMs: SLOT - 7_200_000 } })).toBe("⛔️");
  });

  it("🛑 ✅ beats every outcome — a human start at the right time still ran the engine", () => {
    // `aborted-complete` is the live case: supervision stopped a run that had already done its
    // work. That is a run that happened, and marking it ⛔️ would be false.
    for (const outcome of ["aborted-complete", "missed", "satisfied"] as const)
      expect(mark({ run: { startMs: SLOT }, outcome })).toBe("✅");
  });

  it("⏭️ for a deliberate skip", () => {
    expect(mark({ outcome: "satisfied" })).toBe("⏭️");
    expect(mark({ outcome: "skipped-full" })).toBe("⏭️");
  });

  it("⛔️ for every terminal outcome that started nothing", () => {
    for (const outcome of [
      "missed",
      "missed-running",
      "aborted-unloaded",
      "fired", // dispatched, and no run was ever detected
    ] as const)
      expect(mark({ outcome })).toBe("⛔️");
  });

  it("🛑 ⛔️ with NO record at all, on an ENABLED rule — an absent row is not a shrug", () => {
    // Every slot decided before `automation_slot_outcomes` existed is in this case. What a
    // subscriber can verify is that nothing ran, so that is what the feed says.
    expect(mark({ outcome: null })).toBe("⛔️");
  });

  it("🛑 says NOTHING about a DISABLED rule's silent slot — it was never going to start", () => {
    // A disabled rule is not evaluated at all, so every expired occurrence looks exactly like a
    // failure: no record, no run. Inferring ⛔️ there paints a month of red over weeks in which
    // nothing was ever meant to happen.
    expect(mark({ enabled: false, outcome: null })).toBe(null);
  });

  it("🛑 but a RECORDED failure survives the rule being switched off afterwards", () => {
    // The evaluator only writes for enabled rules, so a `missed` row PROVES the rule was live at
    // the time. The current flag cannot overturn a verdict from a moment it says nothing about.
    expect(mark({ enabled: false, outcome: "missed" })).toBe("⛔️");
    // And a run is a run, whatever the flag says now.
    expect(mark({ enabled: false, run: { startMs: SLOT } })).toBe("✅");
    expect(mark({ enabled: false, outcome: "satisfied" })).toBe("⏭️");
  });

  it("says nothing while the slot is still inside its grace window", () => {
    expect(mark({ nowMs: WINDOW_END, outcome: null })).toBe(null);
    expect(mark({ nowMs: WINDOW_END - 1, outcome: "missed" })).toBe(null);
  });

  it("⛔️ one millisecond after the window closes", () => {
    expect(mark({ nowMs: WINDOW_END + 1 })).toBe("⛔️");
  });

  it("says nothing about a future slot", () => {
    expect(mark({ nowMs: SLOT - 86_400_000 })).toBe(null);
  });

  it("⏭️ even inside the grace window — a skip is a decision, not a wait", () => {
    expect(mark({ nowMs: SLOT + 60_000, outcome: "satisfied" })).toBe("⏭️");
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

  it("gives a slot its run, and keeps it out of the unscheduled list", () => {
    const run = { startMs: SLOT + 30_000 };
    expect(attributeRuns([run], slots)).toEqual({
      bySlot: new Map([[slots[0].key, run]]),
      unattributed: [],
    });
  });

  it("hands back everything else", () => {
    const july = { startMs: SLOT - 60 * 86_400_000 };
    expect(attributeRuns([july], slots)).toEqual({
      bySlot: new Map(),
      unattributed: [july],
    });
  });

  it("🛑 a SECOND run in the same window stays visible, as its own event", () => {
    // The bug a review found: the slot used to show the first run while the partition swallowed
    // every run in the window, so a generator that had to be started twice published one run and
    // hid the other. A restart is exactly the morning a subscriber wants to see.
    const first = { startMs: SLOT + 60_000 };
    const restart = { startMs: SLOT + 40 * 60_000 };
    const { bySlot, unattributed } = attributeRuns([first, restart], slots);
    expect(bySlot.get(slots[0].key)).toBe(first);
    expect(unattributed).toEqual([restart]);
  });

  it("🛑 two overlapping slots cannot both rest on the same start", () => {
    const second = slot(SLOT + 60 * 60_000);
    const run = { startMs: SLOT + 90 * 60_000 }; // inside BOTH windows
    const { bySlot, unattributed } = attributeRuns([run], [slots[0], second]);
    expect(bySlot.get(slots[0].key)).toBe(run);
    expect(bySlot.has(second.key)).toBe(false);
    expect(unattributed).toEqual([]);
  });

  it("serves slots in time order however they arrive", () => {
    const earlier = slot(SLOT - 7 * 86_400_000);
    const run = { startMs: earlier.atMs + 60_000 };
    // The later slot is listed FIRST; the run still belongs to the earlier one.
    const { bySlot } = attributeRuns([run], [slots[0], earlier]);
    expect(bySlot.get(earlier.key)).toBe(run);
    expect(bySlot.has(slots[0].key)).toBe(false);
  });

  it("🛑 keys by RULE and occurrence, so simultaneous slots of two rules stay distinct", () => {
    // A standing weekly exercise and a one-off on the same generator, at the same instant. An
    // instant-keyed result merges them and one rule silently wears the other's run.
    const weekly = slot(SLOT, GRACE, "au_a");
    const oneOff = slot(SLOT, GRACE, "au_b");
    const run = { startMs: SLOT + 60_000 };
    const { bySlot } = attributeRuns([run], [weekly, oneOff]);
    expect(bySlot.size).toBe(1);
    expect(bySlot.get(weekly.key)).toBe(run);
    expect(bySlot.has(oneOff.key)).toBe(false);
  });

  it("documents the greedy policy: earliest slot first, not the most matches", () => {
    // A long-grace slot takes the earlier run even though yielding it would let a tight-grace slot
    // match too. Earliest-first is the rule a reader can follow; maximum-cardinality matching is
    // not, and nothing here has enough slots to notice.
    const wide = slot(SLOT, 180, "au_a");
    const narrow = slot(SLOT + 60 * 60_000, 1, "au_b");
    const early = { startMs: narrow.atMs };
    const late = { startMs: narrow.atMs + 60 * 60_000 };
    const { bySlot, unattributed } = attributeRuns(
      [early, late],
      [wide, narrow],
    );
    expect(bySlot.get(wide.key)).toBe(early);
    expect(bySlot.has(narrow.key)).toBe(false);
    expect(unattributed).toEqual([late]);
  });

  it("with no slots at all, every run is unscheduled", () => {
    const runs = [{ startMs: SLOT }, { startMs: SLOT + 86_400_000 }];
    expect(attributeRuns(runs, []).unattributed).toEqual(runs);
  });

  it("a run inside ANY slot's window is claimed, not just the nearest", () => {
    const later = slot(SLOT + 7 * 86_400_000);
    const run = { startMs: later.atMs + 60_000 };
    expect(attributeRuns([run], [slots[0], later]).unattributed).toEqual([]);
  });
});
