/**
 * Table tests for the pure exercise core.
 *
 * Every case is a clock case, which is exactly why `nowMs` is injected: the daylight-saving tests
 * below are unreachable against a real clock, and they are the ones most likely to break silently.
 *
 * Melbourne is the reference zone because that is where the generator is. Its 2026 transitions:
 * DST ends Sun 5 April (clocks back, AEDT +11 → AEST +10) and starts Sun 4 October (clocks
 * forward, AEST +10 → AEDT +11).
 */
import { describe, expect, it } from "@jest/globals";
import {
  currentSlot,
  decideExercise,
  importKw,
  isDue,
  longestLoadedStretch,
  type LoadedSample,
  type LoadedStretch,
} from "../exercise";
import type { ExerciseSchedule } from "@/lib/db/planetscale/schema";

const TZ = "Australia/Melbourne";
const MIN = 60_000;

const schedule = (over: Partial<ExerciseSchedule> = {}): ExerciseSchedule => ({
  weekdays: ["thu"],
  time: "09:00",
  graceMinutes: 180,
  ...over,
});

/** A local wall-clock instant in Melbourne, as epoch ms. */
const at = (iso: string) => new Date(iso).getTime();

describe("currentSlot", () => {
  it("returns today's slot once the time has passed", () => {
    // Thu 10 Sep 2026, 10:00 local (AEST, +10:00).
    const now = at("2026-09-10T10:00:00+10:00");
    expect(currentSlot(schedule(), TZ, now)).toEqual({
      atMs: at("2026-09-10T09:00:00+10:00"),
    });
  });

  it("returns LAST week's slot when today's has not arrived yet", () => {
    // Thu 10 Sep 2026, 08:00 local — an hour before the slot.
    const now = at("2026-09-10T08:00:00+10:00");
    expect(currentSlot(schedule(), TZ, now)).toEqual({
      atMs: at("2026-09-03T09:00:00+10:00"),
    });
  });

  it("is inclusive of the slot instant itself", () => {
    const now = at("2026-09-10T09:00:00+10:00");
    expect(currentSlot(schedule(), TZ, now)).toEqual({ atMs: now });
  });

  it("walks back to the most recent matching weekday", () => {
    // Sat 12 Sep — two days after Thursday's slot.
    const now = at("2026-09-12T23:00:00+10:00");
    expect(currentSlot(schedule(), TZ, now)).toEqual({
      atMs: at("2026-09-10T09:00:00+10:00"),
    });
  });

  it("picks the nearest of several weekdays", () => {
    const multi = schedule({ weekdays: ["mon", "thu"] });
    // Fri 11 Sep — Thursday is nearer than Monday.
    const now = at("2026-09-11T12:00:00+10:00");
    expect(currentSlot(multi, TZ, now)).toEqual({
      atMs: at("2026-09-10T09:00:00+10:00"),
    });
    // Wed 9 Sep — now Monday is the most recent.
    const wed = at("2026-09-09T12:00:00+10:00");
    expect(currentSlot(multi, TZ, wed)).toEqual({
      atMs: at("2026-09-07T09:00:00+10:00"),
    });
  });

  describe("🛑 daylight saving — the slot is a WALL CLOCK time, not a fixed offset", () => {
    it("holds 09:00 local across the April end of DST", () => {
      // DST ended Sun 5 Apr 2026. Thu 9 Apr is AEST (+10:00); the week before was AEDT (+11:00).
      const now = at("2026-04-09T12:00:00+10:00");
      expect(currentSlot(schedule(), TZ, now)).toEqual({
        atMs: at("2026-04-09T09:00:00+10:00"),
      });

      // Thu 2 Apr, still AEDT: 09:00 local is +11:00. A naive "subtract 7 days from the instant"
      // would land on 08:00 local here, which is the drift this test exists to catch.
      const before = at("2026-04-02T12:00:00+11:00");
      expect(currentSlot(schedule(), TZ, before)).toEqual({
        atMs: at("2026-04-02T09:00:00+11:00"),
      });
    });

    it("holds 09:00 local across the October start of DST", () => {
      // DST started Sun 4 Oct 2026. Thu 8 Oct is AEDT (+11:00).
      const now = at("2026-10-08T12:00:00+11:00");
      expect(currentSlot(schedule(), TZ, now)).toEqual({
        atMs: at("2026-10-08T09:00:00+11:00"),
      });
    });

    it("a Sunday slot lands correctly on the transition day itself", () => {
      // Sun 4 Oct 2026 is the spring-forward day; 09:00 is well clear of the 02:00 gap.
      const sunday = schedule({ weekdays: ["sun"] });
      const now = at("2026-10-04T12:00:00+11:00");
      expect(currentSlot(sunday, TZ, now)).toEqual({
        atMs: at("2026-10-04T09:00:00+11:00"),
      });
    });
  });

  it("returns null when no weekday matches inside the lookback", () => {
    // An empty weekday list cannot occur via the parser, but the function must not loop forever.
    expect(currentSlot(schedule({ weekdays: [] }), TZ, Date.now())).toBeNull();
  });
});

describe("isDue", () => {
  const slot = { atMs: at("2026-09-10T09:00:00+10:00") };
  const createdAtMs = at("2026-01-01T00:00:00+11:00");

  it("is due when nothing has consumed it", () => {
    expect(isDue({ slot, lastTriggeredRunStartMs: null, createdAtMs })).toBe(
      true,
    );
  });

  it("🛑 is NOT due once the exact slot instant has been consumed", () => {
    expect(
      isDue({ slot, lastTriggeredRunStartMs: slot.atMs, createdAtMs }),
    ).toBe(false);
  });

  it("is due again for a different slot", () => {
    expect(
      isDue({
        slot,
        lastTriggeredRunStartMs: slot.atMs - 7 * 24 * 60 * MIN,
        createdAtMs,
      }),
    ).toBe(true);
  });

  it("🛑 is NOT due for a slot that predates the rule", () => {
    // Otherwise a rule created on Friday immediately reports Thursday as a missed exercise — a
    // week it did not exist for.
    expect(
      isDue({
        slot,
        lastTriggeredRunStartMs: null,
        createdAtMs: slot.atMs + MIN,
      }),
    ).toBe(false);
  });

  it("is due for a slot at the exact moment of creation", () => {
    expect(
      isDue({ slot, lastTriggeredRunStartMs: null, createdAtMs: slot.atMs }),
    ).toBe(true);
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
