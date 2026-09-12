/**
 * Table tests for the pure exercise core: what to DO about a slot, once there is one.
 *
 * Every case is a clock case, which is exactly why `nowMs` is injected. Finding the slot in the
 * first place is the recurrence grammar's job and is tested in `recurrence.test.ts` — including
 * the daylight-saving cases, which used to live here against `currentSlot`.
 */
import { describe, expect, it } from "@jest/globals";
import {
  decideExercise,
  importKw,
  isDue,
  longestLoadedStretch,
  type LoadedSample,
  type LoadedStretch,
} from "../exercise";

const MIN = 60_000;

/** A local wall-clock instant in Melbourne, as epoch ms. */
const at = (iso: string) => new Date(iso).getTime();

describe("isDue", () => {
  const slot = { atMs: at("2026-09-10T09:00:00+10:00") };
  const createdAtMs = at("2026-01-01T00:00:00+11:00");

  it("is due when nothing has consumed it", () => {
    expect(isDue({ slot, lastTriggeredRunStartMs: null, createdAtMs })).toEqual(
      {
        due: true,
      },
    );
  });

  it("🛑 is NOT due once the exact slot instant has been consumed", () => {
    expect(
      isDue({ slot, lastTriggeredRunStartMs: slot.atMs, createdAtMs }),
    ).toEqual({ due: false, reason: "dealt-with" });
  });

  it("is due again for a LATER slot", () => {
    expect(
      isDue({
        slot,
        lastTriggeredRunStartMs: slot.atMs - 7 * 24 * 60 * MIN,
        createdAtMs,
      }),
    ).toEqual({ due: true });
  });

  // 🛑 The watermark. `lastTriggeredRunStart` is ONE timestamp column, so "everything up to here is
  // dealt with" is the only thing it can mean — and reading it as an exact match is how removing a
  // consumed occurrence re-armed an earlier one.
  it("🛑 is NOT due for a slot EARLIER than the watermark, not merely equal to it", () => {
    // Two slots an hour apart, both inside one grace window, both dealt with — the key holds the
    // later one. The owner then skips the later occurrence, so `previousOccurrence` returns the
    // earlier slot. Under an exact match that no longer matched the key and the engine started for
    // an occurrence it had already handled.
    expect(
      isDue({
        slot,
        lastTriggeredRunStartMs: slot.atMs + 60 * MIN,
        createdAtMs,
      }),
    ).toEqual({ due: false, reason: "dealt-with" });
  });

  it("🛑 is NOT due for a slot that predates the rule, and says which reason", () => {
    // Otherwise a rule created on Friday immediately reports Thursday as a missed exercise — a
    // week it did not exist for. The REASON matters: the evaluator retires a spent rule on
    // `dealt-with` and must not do so on this one, which has simply not started yet.
    expect(
      isDue({
        slot,
        lastTriggeredRunStartMs: null,
        createdAtMs: slot.atMs + MIN,
      }),
    ).toEqual({ due: false, reason: "predates-rule" });
  });

  it("is due for a slot at the exact moment of creation", () => {
    expect(
      isDue({ slot, lastTriggeredRunStartMs: null, createdAtMs: slot.atMs }),
    ).toEqual({ due: true });
  });

  // 🛑 `slot.atMs <= null` coerces the null to 0 in JS, so a bare `<=` answers "not due" for every
  // slot on a rule that has never fired — the whole feature, silently off.
  it("🛑 treats a NULL watermark as 'nothing consumed', not as zero", () => {
    expect(isDue({ slot, lastTriggeredRunStartMs: null, createdAtMs })).toEqual(
      { due: true },
    );
    expect(
      isDue({
        slot: { atMs: 1 },
        lastTriggeredRunStartMs: null,
        createdAtMs: 0,
      }),
    ).toEqual({ due: true });
  });
});

describe("importKw — the sign convention", () => {
  it("reads NEGATIVE watts as import", () => {
    expect(importKw(-2300)).toBe(2.3);
  });

  it("clamps export to zero rather than reporting negative load", () => {
    expect(importKw(4100)).toBe(0);
  });

  it("is zero at zero", () => {
    expect(importKw(0)).toBe(0);
  });
});

describe("longestLoadedStretch", () => {
  const OPTS = { minLoadKw: 1.5, dipToleranceSeconds: 180 };
  const T = at("2026-09-10T09:00:00+10:00");

  /**
   * MINUTELY samples, the cadence `point_readings` actually holds, expressed as kW of import and
   * stored as the negative watts the Selectronic reports. Sparser fixtures would trip the
   * 5-minute gap break for reasons that have nothing to do with the case under test.
   */
  const ramp = (
    fromMin: number,
    toMin: number,
    kw: number | null,
  ): LoadedSample[] => {
    const out: LoadedSample[] = [];
    for (let m = fromMin; m <= toMin; m++)
      out.push({ tMs: T + m * MIN, value: kw === null ? null : -kw * 1000 });
    return out;
  };

  it("finds a simple continuous stretch", () => {
    const s = longestLoadedStretch(ramp(0, 30, 2.5), OPTS);
    expect(s).toEqual({
      startMs: T,
      endMs: T + 30 * MIN,
      minutes: 30,
      peakKw: 2.5,
    });
  });

  it("returns null when nothing reaches the threshold", () => {
    // The measured 0.26 kW unloaded run: real, but useless against wet stacking.
    expect(longestLoadedStretch(ramp(0, 40, 0.26), OPTS)).toBeNull();
  });

  it("returns null for an empty series", () => {
    expect(longestLoadedStretch([], OPTS)).toBeNull();
  });

  it("bridges a dip within the tolerance", () => {
    // Loaded 0-10, idle 11-12 (a 2-minute dip, inside the 3-minute tolerance), loaded 13-20.
    const s = longestLoadedStretch(
      [...ramp(0, 10, 2.5), ...ramp(11, 12, 0.4), ...ramp(13, 20, 2.6)],
      OPTS,
    );
    expect(s?.minutes).toBe(20);
  });

  it("\u{1F6D1} splits on a dip LONGER than the tolerance", () => {
    // Loaded 0-5, idle 6-14 (9 minutes), loaded 15-40. The answer must be the longer HALF (25),
    // never the 40 a bridge would have produced.
    const s = longestLoadedStretch(
      [...ramp(0, 5, 2.5), ...ramp(6, 14, 0.2), ...ramp(15, 40, 2.5)],
      OPTS,
    );
    expect(s?.minutes).toBe(25);
    expect(s?.startMs).toBe(T + 15 * MIN);
  });

  it("tolerates a sampling gap up to the gap break", () => {
    // NO samples at all between minute 5 and minute 9. Four minutes: inside the 5-minute gap
    // break, and deliberately NOT judged by the stricter 3-minute dip tolerance, because a gap is
    // missing information rather than an observation of low load.
    const s = longestLoadedStretch(
      [...ramp(0, 5, 2.5), ...ramp(9, 20, 2.5)],
      OPTS,
    );
    expect(s?.minutes).toBe(20);
  });

  it("\u{1F6D1} breaks on a sampling gap longer than the gap break", () => {
    const s = longestLoadedStretch(
      [...ramp(0, 5, 2.5), ...ramp(30, 50, 2.5)],
      OPTS,
    );
    expect(s?.minutes).toBe(20);
    expect(s?.startMs).toBe(T + 30 * MIN);
  });

  it("treats a null value as a gap, not as a dip", () => {
    // If nulls counted as observed low load, this 4-minute hole would exceed the 3-minute dip
    // tolerance and split the stretch.
    const s = longestLoadedStretch(
      [...ramp(0, 5, 2.5), ...ramp(6, 8, null), ...ramp(9, 20, 2.5)],
      OPTS,
    );
    expect(s?.minutes).toBe(20);
  });

  it("reports the peak across the whole winning stretch", () => {
    // The measured hub-commanded range: 2.3-4.1 kW.
    const s = longestLoadedStretch(
      [...ramp(0, 9, 2.3), ...ramp(10, 19, 4.1), ...ramp(20, 30, 2.6)],
      OPTS,
    );
    expect(s?.peakKw).toBeCloseTo(4.1);
    expect(s?.minutes).toBe(30);
  });

  it("ignores export entirely", () => {
    // Positive watts is export, which `importKw` clamps to 0 — so it never reaches the threshold.
    const s = longestLoadedStretch(
      ramp(0, 30, 2.5).map((x) => ({ ...x, value: -(x.value as number) })),
      OPTS,
    );
    expect(s).toBeNull();
  });

  it("sorts an out-of-order series before measuring", () => {
    const s = longestLoadedStretch([...ramp(0, 30, 2.5)].reverse(), OPTS);
    expect(s?.minutes).toBe(30);
  });

  it("takes the LONGEST stretch, not the first or the last", () => {
    const s = longestLoadedStretch(
      [
        ...ramp(0, 8, 2.5),
        ...ramp(20, 60, 2.5), // the winner
        ...ramp(80, 90, 2.5),
      ],
      OPTS,
    );
    expect(s?.minutes).toBe(40);
    expect(s?.startMs).toBe(T + 20 * MIN);
  });
});

describe("decideExercise", () => {
  const slot = { atMs: at("2026-09-10T09:00:00+10:00") };
  const base = { slot, graceMinutes: 180, minMinutes: 30 };
  const loaded = (minutes: number): LoadedStretch => ({
    startMs: slot.atMs - 2 * 24 * 60 * MIN,
    endMs: slot.atMs - 2 * 24 * 60 * MIN + minutes * MIN,
    minutes,
    peakKw: 3.2,
  });

  it("dispatches when the slot is due and nothing objects", () => {
    expect(
      decideExercise(
        { ...base, evidence: null, openRun: false },
        slot.atMs + MIN,
      ),
    ).toEqual({ kind: "dispatch" });
  });

  it("consumes as satisfied when a long enough loaded run already happened", () => {
    const d = decideExercise(
      { ...base, evidence: loaded(45), openRun: false },
      slot.atMs + MIN,
    );
    expect(d.kind).toBe("consume");
    expect(d.kind !== "dispatch" && d.context.outcome).toBe("satisfied");
    expect(d.kind !== "dispatch" && d.context.evidence?.minutes).toBe(45);
  });

  it("treats exactly minMinutes as satisfied", () => {
    const d = decideExercise(
      { ...base, evidence: loaded(30), openRun: false },
      slot.atMs + MIN,
    );
    expect(d.kind !== "dispatch" && d.context.outcome).toBe("satisfied");
  });

  it("a stretch just short of minMinutes does NOT satisfy", () => {
    expect(
      decideExercise(
        { ...base, evidence: loaded(29.9), openRun: false },
        slot.atMs + MIN,
      ),
    ).toEqual({ kind: "dispatch" });
  });

  it("🛑 satisfied beats a run in progress — the cheapest answer wins", () => {
    const d = decideExercise(
      { ...base, evidence: loaded(45), openRun: true },
      slot.atMs + MIN,
    );
    expect(d.kind !== "dispatch" && d.context.outcome).toBe("satisfied");
  });

  it("🛑 waits WITHOUT consuming while a run is in progress", () => {
    const d = decideExercise(
      { ...base, evidence: null, openRun: true },
      slot.atMs + MIN,
    );
    // `wait`, not `consume`: the slot must survive so the next tick can retry once the run ends.
    expect(d.kind).toBe("wait");
    expect(d.kind !== "dispatch" && d.context.outcome).toBe("waiting");
  });

  it("still dispatches at the very end of the grace window", () => {
    expect(
      decideExercise(
        { ...base, evidence: null, openRun: false },
        slot.atMs + 180 * MIN,
      ),
    ).toEqual({ kind: "dispatch" });
  });

  it("writes the slot off one millisecond past grace", () => {
    const d = decideExercise(
      { ...base, evidence: null, openRun: false },
      slot.atMs + 180 * MIN + 1,
    );
    expect(d.kind).toBe("consume");
    expect(d.kind !== "dispatch" && d.context.outcome).toBe("missed");
  });

  it("🛑 distinguishes a grace expiry spent running", () => {
    // Otherwise a generator that ran all morning for another reason looks like a system failure.
    const d = decideExercise(
      { ...base, evidence: null, openRun: true },
      slot.atMs + 200 * MIN,
    );
    expect(d.kind).toBe("consume");
    expect(d.kind !== "dispatch" && d.context.outcome).toBe("missed-running");
  });

  it("records the slot instant and decision time in the context", () => {
    const now = slot.atMs + 5 * MIN;
    const d = decideExercise({ ...base, evidence: null, openRun: true }, now);
    expect(d.kind !== "dispatch" && d.context).toMatchObject({
      kind: "exercise",
      slotAt: slot.atMs,
      at: now,
    });
  });
});
