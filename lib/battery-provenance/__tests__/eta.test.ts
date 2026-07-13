import { describe, it, expect } from "@jest/globals";
import { learnEwmaEta } from "../eta";

const DAY = 86_400_000;
const BASE = Date.UTC(2025, 0, 1, 12, 0, 0); // a noon, well inside a local day
const days = (n: number) => Array.from({ length: n }, (_, i) => BASE + i * DAY);

describe("learnEwmaEta", () => {
  it("returns the prior for empty input", () => {
    const r = learnEwmaEta([], [], [], 0, { prior: 0.93 });
    expect(r.etaSeries).toEqual([]);
    expect(r.byDay).toEqual([]);
    expect(r.summary).toBe(0.93);
  });

  it("holds one η across all intervals of a single local day (causal → day 0 = prior)", () => {
    // three 5-min intervals in the same local day
    const t = [BASE, BASE + 300_000, BASE + 600_000];
    const r = learnEwmaEta([5, 5, 5], [4, 4, 4], t, 0, { prior: 0.95 });
    expect(r.byDay).toHaveLength(1);
    expect(r.etaSeries).toEqual([0.95, 0.95, 0.95]); // day 0 always uses the seed
    expect(r.summary).toBeCloseTo(0.95, 10);
  });

  it("learns causally: each day applies the η learned from PRIOR days", () => {
    const alpha = 0.1;
    const prior = 0.95;
    // 4 days, each raw η = 9/10 = 0.9
    const r = learnEwmaEta([10, 10, 10, 10], [9, 9, 9, 9], days(4), 0, {
      alpha,
      prior,
    });
    // causal EWMA seeded at prior, folding 0.9 each subsequent day
    let ewma = prior;
    const expected = [] as number[];
    for (let i = 0; i < 4; i++) {
      expected.push(ewma);
      ewma = alpha * 0.9 + (1 - alpha) * ewma;
    }
    expect(r.etaSeries[0]).toBe(prior);
    r.etaSeries.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10));
    // strictly decreasing toward 0.9
    for (let i = 1; i < r.etaSeries.length; i++) {
      expect(r.etaSeries[i]).toBeLessThan(r.etaSeries[i - 1]);
      expect(r.etaSeries[i]).toBeGreaterThan(0.9);
    }
    // per-day raw η recorded
    expect(r.byDay.every((d) => d.rawEta === 0.9)).toBe(true);
  });

  it("ignores thin days (below minDayChargeKwh) — they don't update the EWMA", () => {
    const r = learnEwmaEta(
      [10, 0.5, 10], // day 1 too thin to trust
      [8, 0.5, 8],
      days(3),
      0,
      { alpha: 0.5, prior: 0.99, minDayChargeKwh: 1 },
    );
    expect(r.byDay[1].rawEta).toBeNull();
    // day 2 applies exactly what day 0's update produced (day 1 was a no-op)
    const afterDay0 = 0.5 * 0.8 + 0.5 * 0.99; // 0.895
    expect(r.etaSeries[1]).toBeCloseTo(afterDay0, 10);
    expect(r.etaSeries[2]).toBeCloseTo(afterDay0, 10);
  });

  it("clamps a day's raw η to the physical band", () => {
    // discharge > charge (net SoC drop over the day) → raw ratio 2.0, clamped to 1.0
    const r = learnEwmaEta([10, 10], [20, 20], days(2), 0, {
      prior: 0.9,
      clampMax: 1.0,
    });
    expect(r.byDay[0].rawEta).toBe(1.0);
  });

  it("weights the summary by throughput", () => {
    // day 0 (prior) moves little; day 1 (learned) moves a lot → summary skews to day 1's applied η
    const r = learnEwmaEta([1, 100], [0.5, 90], days(2), 0, {
      alpha: 1,
      prior: 0.6,
    });
    // day0 applied 0.6 (weight 1), day1 applied = 1*clamp(0.5/1)=... raw day0=0.5→clamp0.7, ewma=0.7; day1 applied 0.7 (weight 100)
    const expected = (0.6 * 1 + 0.7 * 100) / 101;
    expect(r.summary).toBeCloseTo(expected, 8);
  });

  it("buckets by LOCAL day using the tz offset", () => {
    // two intervals 2h apart straddling local midnight for UTC+10 (offset 600)
    const utcMidnight = Date.UTC(2025, 0, 2, 0, 0, 0);
    // 13:30 and 14:30 UTC = 23:30 and 00:30 local (UTC+10) → different local days
    const t = [utcMidnight - 10.5 * 3_600_000, utcMidnight - 9.5 * 3_600_000];
    const r = learnEwmaEta([10, 10], [9, 9], t, 600);
    expect(r.byDay).toHaveLength(2);
  });
});
