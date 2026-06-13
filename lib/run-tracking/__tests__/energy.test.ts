import { describe, it, expect } from "@jest/globals";
import {
  assignEnergyToPeriods,
  type EnergyReading,
  type EnergyWindow,
} from "@/lib/run-tracking/energy";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function r(tMs: number, value: number | null): EnergyReading {
  return { tMs, value };
}

describe("assignEnergyToPeriods", () => {
  it("computes energy as last − first within the window (Wh→kWh, 3dp)", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 2 * MIN }];
    const readings = [r(T0, 100), r(T0 + MIN, 110), r(T0 + 2 * MIN, 130)];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.03]);
  });

  it("handles a counter reset via forward positive deltas", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 3 * MIN }];
    const readings = [
      r(T0, 100),
      r(T0 + MIN, 110), // +10
      r(T0 + 2 * MIN, 5), // reset (drop -105)
      r(T0 + 3 * MIN, 15), // +10
    ];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.02]);
  });

  it("returns null when fewer than two readings fall in the window", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    expect(assignEnergyToPeriods(windows, [r(T0, 100)], T0)).toEqual([null]);
    expect(assignEnergyToPeriods(windows, [], T0)).toEqual([null]);
  });

  it("uses nowMs as the upper bound for an open window", () => {
    const now = T0 + 2 * MIN;
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: null }];
    const readings = [r(T0, 100), r(T0 + MIN, 150), r(T0 + 2 * MIN, 250)];
    expect(assignEnergyToPeriods(windows, readings, now)).toEqual([0.15]);
  });

  it("excludes readings outside the window and ignores nulls", () => {
    const windows: EnergyWindow[] = [
      { startMs: T0 + MIN, endMs: T0 + 2 * MIN },
    ];
    const readings = [
      r(T0, 100), // before window
      r(T0 + MIN, 110),
      r(T0 + 90_000, null), // null ignored
      r(T0 + 2 * MIN, 140),
      r(T0 + 3 * MIN, 999), // after window
    ];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.03]);
  });

  it("aligns results to windows by index", () => {
    const windows: EnergyWindow[] = [
      { startMs: T0, endMs: T0 + MIN },
      { startMs: T0 + 2 * MIN, endMs: T0 + 3 * MIN },
    ];
    const readings = [
      r(T0, 100),
      r(T0 + MIN, 120),
      r(T0 + 2 * MIN, 200),
      r(T0 + 3 * MIN, 260),
    ];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.02, 0.06]);
  });
});
