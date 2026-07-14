import { describe, it, expect } from "@jest/globals";
import { learnEwmaCapacity, measureWindowCapacity } from "../capacity";

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
