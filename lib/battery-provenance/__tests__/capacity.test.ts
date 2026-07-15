import { describe, it, expect } from "@jest/globals";
import {
  learnEwmaCapacity,
  learnCapacityFromDays,
  measureWindowCapacity,
  chargeRunKwhByDay,
} from "../capacity";

const MIN5 = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * One balanced cycling day: SoC ramps 40→80 (charging, no discharge) then 80→40 (discharging
 * `dischargePerStep` kWh/step). The down-swing is 40pp and 8 kWh discharges over it ⇒
 * `C = 100·Σdischarge / Σ(down-swing) = 100·8/40 = 20`. Returns interval arrays + a day-aligned timeline.
 */
function cyclingDay(dayStartMs: number, dischargePerStep = 1) {
  const socPts: number[] = [];
  for (let s = 40; s <= 80; s += 5) socPts.push(s); // 40..80 (9 pts)
  for (let s = 75; s >= 40; s -= 5) socPts.push(s); // 75..40 (8 pts) ⇒ 17 pts, 16 intervals
  const soc: (number | null)[] = socPts;
  const discharge: number[] = [0];
  for (let i = 1; i < socPts.length; i++)
    discharge.push(socPts[i] < socPts[i - 1] ? dischargePerStep : 0);
  // +1 so the first sample lands AFTER local midnight (an interval ending exactly at midnight buckets to
  // the previous day — end-exclusive boundary; starting at +5min keeps all samples in one day cleanly).
  const timeline = socPts.map((_, i) => dayStartMs + (i + 1) * MIN5);
  return { soc, discharge, timeline };
}

describe("measureWindowCapacity", () => {
  it("recovers C from balanced cycling (C = 100·Σdischarge / Σ down-swing)", () => {
    const { soc, discharge } = cyclingDay(Date.parse("2026-01-01T00:00:00Z"));
    expect(measureWindowCapacity(discharge, soc)).toBeCloseTo(20, 6);
  });

  it("returns null when SoC is absent (SoC-blind window)", () => {
    expect(measureWindowCapacity([0, 2, 2], [null, null, null])).toBeNull();
  });
});

describe("learnEwmaCapacity", () => {
  it("learns a day's raw C from its discharge vs swing; day 0 applies the prior (causal)", () => {
    const day0 = cyclingDay(Date.parse("2026-01-01T00:00:00Z"));
    const res = learnEwmaCapacity(day0.discharge, day0.soc, day0.timeline, 0, {
      prior: 15,
      alpha: 0.1,
    });
    expect(res.byDay).toHaveLength(1);
    expect(res.byDay[0].rawC).toBeCloseTo(20, 6);
    expect(res.byDay[0].capacityKwh).toBeCloseTo(15, 6);
    expect(res.capacitySeries.every((c) => c === 15)).toBe(true);
  });

  it("is causal and reproducible: a day's applied C depends only on PRIOR days", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const soc: (number | null)[] = [];
    const discharge: number[] = [];
    const timeline: number[] = [];
    for (let d = 0; d < 3; d++) {
      const day = cyclingDay(base + d * DAY);
      soc.push(...day.soc);
      discharge.push(...day.discharge);
      timeline.push(...day.timeline);
    }
    const full = learnEwmaCapacity(discharge, soc, timeline, 0, {
      prior: 15,
      alpha: 0.1,
    });
    expect(full.byDay).toHaveLength(3);
    expect(full.byDay[0].capacityKwh).toBeCloseTo(15, 6); // prior
    expect(full.byDay[1].capacityKwh).toBeCloseTo(0.1 * 20 + 0.9 * 15, 6); // 15.5
    expect(full.byDay[2].capacityKwh).toBeGreaterThan(
      full.byDay[1].capacityKwh,
    );

    // reproducible/causal: truncating to the first 2 days reproduces the first 2 byDay entries exactly.
    const twoLen = cyclingDay(base).soc.length * 2;
    const two = learnEwmaCapacity(
      discharge.slice(0, twoLen),
      soc.slice(0, twoLen),
      timeline.slice(0, twoLen),
      0,
      { prior: 15, alpha: 0.1 },
    );
    expect(two.byDay[0]).toEqual(full.byDay[0]);
    expect(two.byDay[1]).toEqual(full.byDay[1]);
  });

  it("clamps a day's raw C to the physical band", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    // 50 kWh discharged over a 1pp drop → absurd raw C, pinned to clampMax.
    const res = learnEwmaCapacity(
      [0, 50],
      [80, 79],
      [base + MIN5, base + 2 * MIN5],
      0,
      { prior: 15, clampMax: 100, minDaySocSwingPct: 1 },
    );
    expect(res.byDay[0].rawC).toBe(100);
  });

  it("holds the prior across a thin day (swing below the minimum)", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    // total swing 2pp < minDaySocSwingPct 20 → rawC null, EWMA unchanged.
    const res = learnEwmaCapacity(
      [0, 0.1, 0.1],
      [60, 61, 60],
      [base + MIN5, base + 2 * MIN5, base + 3 * MIN5],
      0,
      { prior: 22, minDaySocSwingPct: 20 },
    );
    expect(res.byDay[0].rawC).toBeNull();
    expect(res.capacitySeries.every((c) => c === 22)).toBe(true);
  });

  it("returns the prior everywhere when SoC is absent (graceful SoC-blind fallback)", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const res = learnEwmaCapacity(
      [0, 2, 2],
      [null, null, null],
      [base + MIN5, base + 2 * MIN5, base + 3 * MIN5],
      0,
      { prior: 22 },
    );
    expect(res.capacitySeries.every((c) => c === 22)).toBe(true);
  });
});

describe("excludeDays (BMS-recal exclusion)", () => {
  it("an excluded day's raw C never updates the EWMA", () => {
    const d0 = cyclingDay(Date.parse("2026-01-01T00:00:00Z"));
    const d1 = cyclingDay(Date.parse("2026-01-02T00:00:00Z"), 2); // raw C = 40 (outlier for the test)
    const d2 = cyclingDay(Date.parse("2026-01-03T00:00:00Z"));
    const discharge = [...d0.discharge, ...d1.discharge, ...d2.discharge];
    const soc = [...d0.soc, ...d1.soc, ...d2.soc];
    const timeline = [...d0.timeline, ...d1.timeline, ...d2.timeline];
    const base = learnEwmaCapacity(discharge, soc, timeline, 0, {
      prior: 15,
      alpha: 0.1,
    });
    const r = learnEwmaCapacity(discharge, soc, timeline, 0, {
      prior: 15,
      alpha: 0.1,
      excludeDays: new Set([base.byDay[1].dayIndex]),
    });
    expect(r.byDay[1].rawC).toBeNull();
    // Day 2 applies the EWMA as if day 1 never happened: one 20-fold from day 0.
    expect(r.byDay[2].capacityKwh).toBeCloseTo(0.1 * 20 + 0.9 * 15, 10);
    expect(base.byDay[2].capacityKwh).toBeGreaterThan(r.byDay[2].capacityKwh);
  });
});

describe("chargeRunKwhByDay (coulomb floor input)", () => {
  it("sums a single contiguous charging run", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    // 4 slots × 1 kWh charge each, contiguous 5-min cadence.
    const timeline = [1, 2, 3, 4].map((i) => base + i * MIN5);
    const charge = [1, 1, 1, 1];
    const discharge = [0, 0, 0, 0];
    const byDay = chargeRunKwhByDay(charge, discharge, timeline, 0);
    const dayIndex = Math.floor(base / DAY);
    expect(byDay.get(dayIndex)).toBeCloseTo(4, 6);
  });

  it("breaks the run on a data gap and keeps the larger of two runs", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const dayIndex = Math.floor(base / DAY);
    // Run A: 2 slots × 1 kWh = 2 kWh, then a big gap, then run B: 3 slots × 1 kWh = 3 kWh.
    const timeline = [
      base + 1 * MIN5,
      base + 2 * MIN5,
      base + 8 * MIN5, // gap > 10 min tolerance from the previous slot
      base + 9 * MIN5,
      base + 10 * MIN5,
    ];
    const charge = [1, 1, 1, 1, 1];
    const discharge = [0, 0, 0, 0, 0];
    const byDay = chargeRunKwhByDay(charge, discharge, timeline, 0);
    expect(byDay.get(dayIndex)).toBeCloseTo(3, 6);
  });

  it("nets simultaneous discharge against charge and ignores sub-threshold jitter", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const dayIndex = Math.floor(base / DAY);
    const timeline = [1, 2, 3].map((i) => base + i * MIN5);
    // Slot 1: net charge 2kWh. Slot 2: charge==discharge → net 0, breaks the run. Slot 3: tiny net (noise).
    const charge = [2, 1, 0.0001];
    const discharge = [0, 1, 0];
    const byDay = chargeRunKwhByDay(charge, discharge, timeline, 0);
    expect(byDay.get(dayIndex)).toBeCloseTo(2, 6);
  });

  it("does not carry a run across the local-day boundary", () => {
    // Two slots just before local midnight, two just after (00:00 itself buckets to the PREVIOUS day
    // under the shared end-exclusive convention — skipped here to keep the split unambiguous).
    const timeline = [
      Date.parse("2026-01-01T23:50:00Z"),
      Date.parse("2026-01-01T23:55:00Z"),
      Date.parse("2026-01-02T00:05:00Z"),
      Date.parse("2026-01-02T00:10:00Z"),
    ];
    const day0 = Math.floor(timeline[0] / DAY);
    const charge = [1, 1, 1, 1];
    const discharge = [0, 0, 0, 0];
    const byDay = chargeRunKwhByDay(charge, discharge, timeline, 0);
    // A single uninterrupted 4 kWh run in wall-clock time is split 2/2 across the day boundary.
    expect(byDay.get(day0)).toBeCloseTo(2, 6);
    expect(byDay.get(day0 + 1)).toBeCloseTo(2, 6);
  });
});

describe("learnCapacityFromDays — coulomb floor", () => {
  it("snaps the EWMA up when a day's charge run exceeds it, causally (next day, not the run's own day)", () => {
    const days = [
      { dayIndex: 0, capDischargeKwh: 0, downSwingPct: 0, chargeRunKwh: 0 },
      // SoC-blind day (downSwingPct 0 ⇒ rawC never fires) with a huge continuous charge run.
      { dayIndex: 1, capDischargeKwh: 0, downSwingPct: 0, chargeRunKwh: 40 },
      { dayIndex: 2, capDischargeKwh: 0, downSwingPct: 0, chargeRunKwh: 0 },
    ];
    const { byDay } = learnCapacityFromDays(days, {
      prior: 21,
      floorChargeEff: 0.85,
    });
    expect(byDay[0].capacityKwh).toBeCloseTo(21, 6); // prior
    expect(byDay[1].capacityKwh).toBeCloseTo(21, 6); // day 1 still applies the OLD value (causal)
    expect(byDay[2].capacityKwh).toBeCloseTo(40 * 0.85, 6); // day 2 sees the snapped-up floor
  });

  it("never lowers the EWMA — a small day's charge run is simply ignored", () => {
    const days = [
      { dayIndex: 0, capDischargeKwh: 0, downSwingPct: 0, chargeRunKwh: 40 },
      { dayIndex: 1, capDischargeKwh: 0, downSwingPct: 0, chargeRunKwh: 1 },
    ];
    const { byDay } = learnCapacityFromDays(days, {
      prior: 21,
      floorChargeEff: 0.85,
    });
    expect(byDay[1].capacityKwh).toBeCloseTo(40 * 0.85, 6);
  });

  it("clamps the floor to the physical band (clampMax)", () => {
    const days = [
      { dayIndex: 0, capDischargeKwh: 0, downSwingPct: 0, chargeRunKwh: 500 },
      { dayIndex: 1, capDischargeKwh: 0, downSwingPct: 0, chargeRunKwh: 0 },
    ];
    const { byDay } = learnCapacityFromDays(days, {
      prior: 15,
      clampMax: 100,
      floorChargeEff: 1,
    });
    expect(byDay[1].capacityKwh).toBe(100);
  });

  it("real-world shape: a capacity upgrade mid-SoC-blind-stretch is caught within days, unlike the pre-fix EWMA crawl", () => {
    // Mirrors Kinkora: ~20 kWh battery, SoC-blind throughout, then a capacity upgrade with recurring
    // ~35-40 kWh charge runs on roughly half the days (solar-driven — not every day is sunny).
    const days: {
      dayIndex: number;
      capDischargeKwh: number;
      downSwingPct: number;
      chargeRunKwh: number;
    }[] = [];
    for (let i = 0; i < 5; i++)
      days.push({
        dayIndex: i,
        capDischargeKwh: 0,
        downSwingPct: 0,
        chargeRunKwh: 0,
      });
    for (let i = 5; i < 20; i++)
      days.push({
        dayIndex: i,
        capDischargeKwh: 0,
        downSwingPct: 0,
        chargeRunKwh: i % 2 === 0 ? 38 : 5, // big run every other day
      });
    const { byDay } = learnCapacityFromDays(days, {
      prior: 21,
      floorChargeEff: 0.85,
    });
    // Pre-fix (no floor): the EWMA would sit frozen at 21 for the whole SoC-blind stretch.
    // With the floor: within a handful of days of the first big run, C should be well above 21.
    expect(byDay[10].capacityKwh).toBeGreaterThan(30);
    expect(byDay[19].capacityKwh).toBeCloseTo(38 * 0.85, 6);
  });
});

describe("learnEwmaCapacity — coulomb floor via opts.chargeKwh", () => {
  it("is inert when chargeKwh is omitted (backward compatible)", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const res = learnEwmaCapacity(
      [0, 2, 2],
      [null, null, null],
      [base + MIN5, base + 2 * MIN5, base + 3 * MIN5],
      0,
      { prior: 22 },
    );
    expect(res.capacitySeries.every((c) => c === 22)).toBe(true);
  });

  it("snaps C up from a SoC-blind day's charge run when chargeKwh is supplied", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    // Day 0: SoC-blind, a 40 kWh continuous charge run (40 slots × 1 kWh). Day 1: also SoC-blind.
    const n = 40;
    const timeline = Array.from({ length: n }, (_, i) => base + (i + 1) * MIN5);
    const charge = Array.from({ length: n }, () => 1);
    const discharge = Array.from({ length: n }, () => 0);
    const soc = Array.from({ length: n }, () => null as number | null);
    const day1Timeline = timeline.map((t) => t + DAY);
    const res = learnEwmaCapacity(
      [...discharge, ...discharge],
      [...soc, ...soc],
      [...timeline, ...day1Timeline],
      0,
      { prior: 21, floorChargeEff: 0.85, chargeKwh: [...charge, ...charge] },
    );
    expect(res.byDay).toHaveLength(2);
    expect(res.byDay[0].capacityKwh).toBeCloseTo(21, 6); // causal: day 0 still applies the prior
    expect(res.byDay[1].capacityKwh).toBeCloseTo(40 * 0.85, 6); // day 1 sees the snap-up
  });
});
