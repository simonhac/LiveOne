/**
 * Unit tests for the pure reserve-floor learner (`reserve-floor.ts`).
 *
 * Contract: the per-day APPLIED floor is a low quantile of the trailing-90-day per-day SoC minima,
 * minus 2, clamped to `[5, maxPct]` — "learn where the battery goes deep, assume `maxPct` where it
 * doesn't." Causal (trailing window ending at each day), robust to a lone anomalous dip, and always
 * finite.
 */
import { describe, it, expect } from "@jest/globals";
import { learnReserveFloorByDay, DEFAULT_RESERVE_PCT } from "../reserve-floor";

/** N days all with the same per-day min SoC. */
const flat = (n: number, v: number | null): (number | null)[] =>
  new Array(n).fill(v);

describe("learnReserveFloorByDay", () => {
  it("pins to maxPct (default 10) when the battery never discharges deep", () => {
    // A genset-backed site that bottoms at ~20%: the floor is unidentifiable, so it takes the prior.
    const floors = learnReserveFloorByDay(flat(100, 20));
    expect(floors).toHaveLength(100);
    expect(new Set(floors)).toEqual(new Set([DEFAULT_RESERVE_PCT]));
  });

  it("learns an intermediate floor when the battery cycles to a mid SoC", () => {
    // minima ≈ 9% → 9 − 2 = 7 (steady state). The first 9 days are warm-up (thin window → maxPct).
    const floors = learnReserveFloorByDay(flat(100, 9));
    expect(floors[99]).toBe(7);
    expect(floors[0]).toBe(DEFAULT_RESERVE_PCT); // warm-up
    expect(new Set(floors)).toEqual(new Set([DEFAULT_RESERVE_PCT, 7]));
  });

  it("clamps to the lower bound (5) for a deeply-cycled battery", () => {
    // minima ≈ 6% → 6 − 2 = 4 → clamped up to 5 (steady state; warm-up days take the prior).
    const floors = learnReserveFloorByDay(flat(100, 6));
    expect(floors[99]).toBe(5);
    expect(floors[0]).toBe(DEFAULT_RESERVE_PCT);
  });

  it("the reserveFloorMaxPct knob raises the ceiling for high-reserve hardware", () => {
    // minima ≈ 20%: default → clamps to 10; maxPct=25 → 20 − 2 = 18 (below the raised cap).
    expect(new Set(learnReserveFloorByDay(flat(100, 20)))).toEqual(
      new Set([DEFAULT_RESERVE_PCT]),
    );
    const raised = learnReserveFloorByDay(flat(100, 20), 25);
    expect(raised[99]).toBe(18); // steady state
    expect(raised[0]).toBe(25); // warm-up takes the raised prior
  });

  it("returns maxPct while the window is too thin to trust (< 10 day-minima)", () => {
    expect(new Set(learnReserveFloorByDay(flat(5, 6)))).toEqual(
      new Set([DEFAULT_RESERVE_PCT]),
    );
    expect(new Set(learnReserveFloorByDay(flat(5, 6), 7))).toEqual(
      new Set([7]),
    );
  });

  it("returns maxPct for a fully SoC-dark (all-null) history", () => {
    expect(new Set(learnReserveFloorByDay(flat(30, null)))).toEqual(
      new Set([DEFAULT_RESERVE_PCT]),
    );
  });

  it("is robust to a single anomalous deep dip (uses a low quantile, not the min)", () => {
    // 89 days at 20% + one glitch to 2%: the 5th-percentile of the 90 minima is still ~20 → floor 10.
    const socMin = [2, ...flat(89, 20)];
    const floors = learnReserveFloorByDay(socMin);
    expect(floors[floors.length - 1]).toBe(DEFAULT_RESERVE_PCT);
  });

  it("is causal: the floor only drops once enough deep days accumulate in the trailing window", () => {
    // Days 0–59 bottom at 20%; days 60–119 bottom at 8%.
    const socMin = [...flat(60, 20), ...flat(60, 8)];
    const floors = learnReserveFloorByDay(socMin);
    // Early day (window all 20) → prior.
    expect(floors[10]).toBe(DEFAULT_RESERVE_PCT);
    // Late day (window dominated by the 8% minima) → 8 − 2 = 6.
    expect(floors[119]).toBe(6);
  });

  it("guards an inverted band when maxPct < the lower bound", () => {
    // maxPct 3 < 5 → hi clamped up to 5, so the floor is exactly 5.
    expect(new Set(learnReserveFloorByDay(flat(100, 20), 3))).toEqual(
      new Set([5]),
    );
  });
});
