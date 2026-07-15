/**
 * Equivalence + seam tests for the per-day reduction (`daily.ts`).
 *
 * The contract under test: reducing a throughput window to per-day rows and running the day-level fits
 * over them reproduces the per-interval learners EXACTLY — in one pass, day-by-day chained through the
 * carry, or in arbitrary run partitions.
 */
import { describe, it, expect } from "@jest/globals";
import {
  reduceThroughputToDays,
  sliceThroughput,
  dayIndexOf,
  dayIndexRangeMs,
  dayIndexToDayString,
  dayStringToDayIndex,
  EMPTY_CARRY,
  type ThroughputSlice,
  type DayCarry,
  type BatteryDayReduction,
} from "../daily";
import { learnEwmaEta, learnEtaFromDays } from "../eta";
import {
  learnEwmaCapacity,
  learnCapacityFromDays,
  measureWindowCapacity,
  measureWindowCapacityFromSums,
} from "../capacity";
import { detectRecalDayIndexes } from "../losses";

const DAY_MS = 86_400_000;
const SLOT_MS = 300_000; // 5 minutes

/** Tiny deterministic LCG so fixtures are reproducible without Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface FixtureOpts {
  startDay?: string;
  numDays?: number;
  tzOffsetMin?: number;
  /** Local-day offsets (0-based) that get a phantom SoC jump (recal). */
  recalDays?: number[];
  /** Local-day offsets with NO throughput (idle battery, SoC flat). */
  idleDays?: number[];
  /** Local-day offsets entirely MISSING from the timeline (no agg_5m rows). */
  missingDays?: number[];
  /** Local-day offsets that charge to the SoC rail (≥98) mid-day. */
  railDays?: number[];
  /** [dayOffset, startSlot, slotCount] runs of null SoC (sensor dark). */
  socGaps?: [number, number, number][];
  /** All-null SoC (SoC-blind battery). */
  socBlind?: boolean;
}

/** Build a deterministic multi-day battery pattern: solar-hours charge, evening discharge, SoC
 *  integrated from net flow against a nominal 20 kWh capacity (so the fits see physical data). */
function buildTp(opts: FixtureOpts = {}): {
  tp: ThroughputSlice;
  tz: number;
  startDayIndex: number;
} {
  const {
    startDay = "2025-09-01",
    numDays = 40,
    tzOffsetMin = 600,
    recalDays = [],
    idleDays = [],
    missingDays = [],
    railDays = [],
    socGaps = [],
    socBlind = false,
  } = opts;
  const rand = lcg(42);
  const startDayIndex = dayStringToDayIndex(startDay);
  const [dayStartEx] = dayIndexRangeMs(startDayIndex, tzOffsetMin);

  const timeline: number[] = [];
  const chargeKwh: number[] = [];
  const dischargeKwh: number[] = [];
  const soc: (number | null)[] = [];

  const capacity = 20; // nominal kWh for SoC integration
  let socNow = 55;
  const gapSet = new Set<string>();
  for (const [d, s0, count] of socGaps)
    for (let k = 0; k < count; k++) gapSet.add(`${d}:${s0 + k}`);

  for (let d = 0; d < numDays; d++) {
    if (missingDays.includes(d)) continue;
    const idle = idleDays.includes(d);
    const rail = railDays.includes(d);
    for (let slot = 0; slot < 288; slot++) {
      const t = dayStartEx + d * DAY_MS + (slot + 1) * SLOT_MS;
      const hour = ((slot + 1) * 5) / 60;
      let charge = 0;
      let discharge = 0;
      if (!idle) {
        if (hour >= 9 && hour < 15)
          charge = 0.22 + 0.08 * rand(); // ~16-21 kWh/day in
        else if (hour >= 17 || hour < 6) discharge = 0.09 + 0.04 * rand();
        if (rail && hour >= 12 && hour < 15) charge += 0.15; // push to the rail
      }
      // Physical SoC: net in at η_c=0.94, out 1:1, tiny idle drain.
      socNow += ((0.94 * charge - discharge) / capacity) * 100;
      socNow -= 0.0007; // ~0.2 pp/day idle
      if (recalDays.includes(d) && slot === 30) socNow += 10; // phantom BMS snap
      socNow = Math.min(rail ? 99.5 : 96, Math.max(8, socNow));

      timeline.push(t);
      chargeKwh.push(charge);
      dischargeKwh.push(discharge);
      soc.push(socBlind || gapSet.has(`${d}:${slot}`) ? null : socNow);
    }
  }
  return {
    tp: { timeline, chargeKwh, dischargeKwh, soc },
    tz: tzOffsetMin,
    startDayIndex,
  };
}

/** The reference recal convention: the window-scalar C, exactly `recalDaysFor`. */
function windowRecalSet(tp: ThroughputSlice, tz: number): Set<number> {
  const c = measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? 15;
  return detectRecalDayIndexes(
    tp.chargeKwh,
    tp.dischargeKwh,
    tp.soc,
    c,
    tp.timeline,
    tz,
  );
}

function windowC(tp: ThroughputSlice): number {
  return measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? 15;
}

describe("day helpers", () => {
  it("dayIndex ↔ dayString round-trips", () => {
    const d = dayStringToDayIndex("2025-08-16");
    expect(dayIndexToDayString(d)).toBe("2025-08-16");
    expect(dayIndexToDayString(d + 1)).toBe("2025-08-17");
  });

  it("dayIndexRangeMs is the exclusive-start owner range of dayIndexOf", () => {
    for (const tz of [600, 570, -300]) {
      const d = dayStringToDayIndex("2025-09-10");
      const [startEx, endInc] = dayIndexRangeMs(d, tz);
      expect(dayIndexOf(startEx, tz)).toBe(d - 1);
      expect(dayIndexOf(startEx + 1, tz)).toBe(d);
      expect(dayIndexOf(endInc, tz)).toBe(d);
      expect(dayIndexOf(endInc + 1, tz)).toBe(d + 1);
    }
  });
});

describe("reduceThroughputToDays — full-window equivalence", () => {
  const scenarios: [string, FixtureOpts][] = [
    ["plain cycling", {}],
    [
      "with recal + rails + idle days",
      { recalDays: [12, 25], railDays: [5, 6], idleDays: [18] },
    ],
    [
      "with SoC gaps mid-day and across midnight",
      {
        socGaps: [
          [8, 100, 30],
          [14, 280, 20],
        ],
        recalDays: [20],
      },
    ],
    ["missing whole days", { missingDays: [10, 11], recalDays: [15] }],
    ["negative tz offset", { tzOffsetMin: -300, recalDays: [9] }],
    ["half-hour tz offset", { tzOffsetMin: 570 }],
    ["SoC-blind", { socBlind: true }],
  ];

  it.each(scenarios)(
    "%s: sums, pairs and recal flags match the learners",
    (_name, opts) => {
      const { tp, tz } = buildTp(opts);
      const c = windowC(tp);
      const rows = reduceThroughputToDays(tp, tz, EMPTY_CARRY, c);

      // η inputs: ungated per-day sums (compare through the fit's byDay diags).
      const etaRef = learnEwmaEta(
        tp.chargeKwh,
        tp.dischargeKwh,
        tp.timeline,
        tz,
        {
          prior: 0.9,
          excludeDays: windowRecalSet(tp, tz),
        },
      );
      expect(rows.map((r) => r.dayIndex)).toEqual(
        etaRef.byDay.map((d) => d.dayIndex),
      );
      for (let i = 0; i < rows.length; i++) {
        expect(rows[i].chargeKwh).toBeCloseTo(etaRef.byDay[i].chargeKwh, 12);
        expect(rows[i].dischargeKwh).toBeCloseTo(
          etaRef.byDay[i].dischargeKwh,
          12,
        );
      }

      // Recal flags: exactly the window-scalar detector's day set.
      const recalRef = windowRecalSet(tp, tz);
      for (const r of rows) expect(r.recal).toBe(recalRef.has(r.dayIndex));

      // Capacity pair sums: compare through the fit (byDay swing is the down-swing sum) AND the seed.
      const capRef = learnEwmaCapacity(
        tp.dischargeKwh,
        tp.soc,
        tp.timeline,
        tz,
        {
          prior: windowC(tp),
          excludeDays: recalRef,
        },
      );
      for (let i = 0; i < rows.length; i++) {
        expect(rows[i].downSwingPct).toBeCloseTo(capRef.byDay[i].swingPct, 12);
      }
      // Seed from summed day subtotals vs the one-pass running sum: identical up to float
      // associativity (day-bucketed re-summation reorders additions — last-ulp only).
      const sumCapDis = rows.reduce((a, r) => a + r.capDischargeKwh, 0);
      const sumSwing = rows.reduce((a, r) => a + r.downSwingPct, 0);
      const seedFromSums = measureWindowCapacityFromSums(sumCapDis, sumSwing);
      const seedRef = measureWindowCapacity(tp.dischargeKwh, tp.soc);
      if (seedRef === null) expect(seedFromSums).toBeNull();
      else expect(seedFromSums!).toBeCloseTo(seedRef, 9);

      // Fit-level equivalence: day-level fits over the reductions == per-interval fits.
      const etaFit = learnEtaFromDays(
        rows.map((r) => ({ ...r, excluded: r.recal })),
        { prior: 0.9 },
      );
      expect(etaFit.byDay).toEqual(etaRef.byDay);
      const capFit = learnCapacityFromDays(
        rows.map((r) => ({
          dayIndex: r.dayIndex,
          capDischargeKwh: r.capDischargeKwh,
          downSwingPct: r.downSwingPct,
          excluded: r.recal,
        })),
        { prior: windowC(tp) },
      );
      expect(capFit.byDay).toEqual(capRef.byDay);
    },
  );

  it("losses day inputs match learnLosses' internal day view (socFirst/socLast/socSamples)", () => {
    const { tp, tz } = buildTp({ socGaps: [[3, 50, 40]], recalDays: [22] });
    const c = windowC(tp);
    const rows = reduceThroughputToDays(tp, tz, EMPTY_CARRY, c);
    // Reference: replicate losses.ts's per-day accumulation directly from the arrays.
    const byDay = new Map<
      number,
      { first: number | null; last: number | null; n: number }
    >();
    for (let i = 0; i < tp.timeline.length; i++) {
      const d = dayIndexOf(tp.timeline[i], tz);
      if (!byDay.has(d)) byDay.set(d, { first: null, last: null, n: 0 });
      const acc = byDay.get(d)!;
      const s = tp.soc[i];
      if (s !== null) {
        if (acc.first === null) acc.first = s;
        acc.last = s;
        acc.n++;
      }
    }
    for (const r of rows) {
      const ref = byDay.get(r.dayIndex)!;
      expect(r.socFirst).toEqual(ref.first);
      expect(r.socLast).toEqual(ref.last);
      expect(r.socSamples).toBe(ref.n);
    }
  });
});

describe("reduceThroughputToDays — seam/carry resumability", () => {
  /** Slice tp into per-day (or run) sub-windows using the owner ranges. */
  function slicesByDays(
    tp: ThroughputSlice,
    tz: number,
    runs: number[][],
  ): ThroughputSlice[] {
    return runs.map((run) => {
      const [startEx] = dayIndexRangeMs(run[0], tz);
      const [, endInc] = dayIndexRangeMs(run[run.length - 1], tz);
      const from = tp.timeline.findIndex((t) => t > startEx);
      let to = tp.timeline.length;
      for (let i = tp.timeline.length - 1; i >= 0; i--)
        if (tp.timeline[i] <= endInc) {
          to = i + 1;
          break;
        }
      return {
        timeline: tp.timeline.slice(from, to),
        chargeKwh: tp.chargeKwh.slice(from, to),
        dischargeKwh: tp.dischargeKwh.slice(from, to),
        soc: tp.soc.slice(from, to),
      };
    });
  }

  function carryOf(r: BatteryDayReduction): DayCarry {
    return {
      socLastSlotPct: r.socLastSlotPct,
      socCarryPct: r.socCarryPct,
      netAfterSocKwh: r.netAfterSocKwh,
    };
  }

  const opts: FixtureOpts = {
    numDays: 25,
    recalDays: [7, 16],
    railDays: [4],
    idleDays: [11],
    missingDays: [13],
    socGaps: [
      [5, 270, 25], // spans midnight into day 6
      [9, 0, 288], // whole day SoC-dark
      [10, 0, 288], // second dark day (multi-day gap)
    ],
  };

  it("day-by-day chained through the carry == one pass (incl. recal spanning dark days)", () => {
    const { tp, tz } = buildTp(opts);
    const c = windowC(tp);
    const onePass = reduceThroughputToDays(tp, tz, EMPTY_CARRY, c);

    const dayRuns = onePass.map((r) => [r.dayIndex]);
    const slices = slicesByDays(tp, tz, dayRuns);
    let carry = EMPTY_CARRY;
    const chained: BatteryDayReduction[] = [];
    for (const slice of slices) {
      const rows = reduceThroughputToDays(slice, tz, carry, c);
      expect(rows).toHaveLength(1);
      chained.push(rows[0]);
      carry = carryOf(rows[0]);
    }
    expect(chained).toEqual(onePass);
  });

  it("arbitrary run partitions chained through the carry == one pass", () => {
    const { tp, tz } = buildTp(opts);
    const c = windowC(tp);
    const onePass = reduceThroughputToDays(tp, tz, EMPTY_CARRY, c);
    const allDays = onePass.map((r) => r.dayIndex);

    // Partition into runs of 1..7 days (deterministic pattern).
    const runs: number[][] = [];
    for (let i = 0, k = 1; i < allDays.length; i += k, k = (k % 7) + 1)
      runs.push(allDays.slice(i, i + k));
    const slices = slicesByDays(tp, tz, runs);
    let carry = EMPTY_CARRY;
    const chained: BatteryDayReduction[] = [];
    for (const slice of slices) {
      const rows = reduceThroughputToDays(slice, tz, carry, c);
      chained.push(...rows);
      carry = carryOf(rows[rows.length - 1]);
    }
    expect(chained).toEqual(onePass);
  });

  it("re-reducing a suffix from a mid-history row's carry == the one-pass tail", () => {
    const { tp, tz } = buildTp(opts);
    const c = windowC(tp);
    const onePass = reduceThroughputToDays(tp, tz, EMPTY_CARRY, c);
    const cutIdx = 8; // resume after the 9th row
    const [, cutEndInc] = dayIndexRangeMs(onePass[cutIdx].dayIndex, tz);
    const tail = reduceThroughputToDays(
      sliceThroughput(tp, cutEndInc),
      tz,
      carryOf(onePass[cutIdx]),
      c,
    );
    expect(tail).toEqual(onePass.slice(cutIdx + 1));
  });

  it("a mutated day changes its carry-out; re-reducing forward from it heals to from-scratch", () => {
    const { tp, tz } = buildTp({ numDays: 12 });
    const c = windowC(tp);
    const before = reduceThroughputToDays(tp, tz, EMPTY_CARRY, c);

    // Mutate day 5: inject extra discharge late in the day (late-arriving data).
    const mutIdx = 5;
    const [startEx, endInc] = dayIndexRangeMs(before[mutIdx].dayIndex, tz);
    const mutated: ThroughputSlice = {
      timeline: [...tp.timeline],
      chargeKwh: [...tp.chargeKwh],
      dischargeKwh: [...tp.dischargeKwh],
      soc: [...tp.soc],
    };
    for (let i = 0; i < mutated.timeline.length; i++) {
      const t = mutated.timeline[i];
      if (t > startEx && t <= endInc && t > endInc - 3600_000)
        mutated.dischargeKwh[i] += 0.5;
    }
    const fromScratch = reduceThroughputToDays(mutated, tz, EMPTY_CARRY, c);

    // Re-reduce ONLY the mutated day from its predecessor's stored carry…
    const carryIn = {
      socLastSlotPct: before[mutIdx - 1].socLastSlotPct,
      socCarryPct: before[mutIdx - 1].socCarryPct,
      netAfterSocKwh: before[mutIdx - 1].netAfterSocKwh,
    };
    const daySlice = sliceThroughput(
      {
        timeline: mutated.timeline.filter((t) => t <= endInc),
        chargeKwh: mutated.chargeKwh.filter(
          (_, i) => mutated.timeline[i] <= endInc,
        ),
        dischargeKwh: mutated.dischargeKwh.filter(
          (_, i) => mutated.timeline[i] <= endInc,
        ),
        soc: mutated.soc.filter((_, i) => mutated.timeline[i] <= endInc),
      },
      startEx,
    );
    const [reDay] = reduceThroughputToDays(daySlice, tz, carryIn, c);
    expect(reDay).toEqual(fromScratch[mutIdx]);

    // …its carry-out changed (net shifted), so the cascade must re-reduce forward; chaining the
    // remaining days from the new carry reproduces from-scratch exactly.
    const tail = reduceThroughputToDays(
      sliceThroughput(mutated, endInc),
      tz,
      {
        socLastSlotPct: reDay.socLastSlotPct,
        socCarryPct: reDay.socCarryPct,
        netAfterSocKwh: reDay.netAfterSocKwh,
      },
      c,
    );
    expect([...fromScratch.slice(0, mutIdx), reDay, ...tail]).toEqual(
      fromScratch,
    );
  });
});
