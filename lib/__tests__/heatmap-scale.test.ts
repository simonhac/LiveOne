import { describe, it, expect } from "@jest/globals";
import {
  BLACK_SENTINEL,
  FLAT_POSITION,
  POWER_BASELINE_W,
  isBaselinePower,
  normalizeHeatmapValue,
} from "../heatmap-scale";

const ordinary = { baselinePower: false };
const power = { baselinePower: true };

describe("isBaselinePower", () => {
  it.each(["load/power", "load.rest-of-house/power", "source.solar/power"])(
    "%s gets the black floor",
    (p) => expect(isBaselinePower(p)).toBe(true),
  );

  it.each([
    "load/energy", // right family, wrong metric
    "bidi.battery/power", // power, but neither load nor source
    "bidi.battery/soc",
    "load.hws/temperature",
  ])("%s does not", (p) => expect(isBaselinePower(p)).toBe(false));
});

describe("normalizeHeatmapValue — ordinary series", () => {
  it("spans the full 0–1 ramp across min…max", () => {
    expect(normalizeHeatmapValue(0, 0, 100, ordinary)).toBe(0);
    expect(normalizeHeatmapValue(50, 0, 100, ordinary)).toBe(0.5);
    expect(normalizeHeatmapValue(100, 0, 100, ordinary)).toBe(1);
  });

  /**
   * The regression that motivated the change (defect #10). Under the old
   * `Math.max(max - min, 1)` floor this range — 0.4 wide — could only ever reach 0.4 of the palette,
   * so a stable hot-water tank rendered as a washed-out band while the legend claimed min…max.
   */
  it("uses the whole ramp for a sub-unit range (was capped at 0.4)", () => {
    expect(normalizeHeatmapValue(40.1, 40.1, 40.5, ordinary)).toBe(0);
    expect(normalizeHeatmapValue(40.5, 40.1, 40.5, ordinary)).toBe(1);
    expect(normalizeHeatmapValue(40.3, 40.1, 40.5, ordinary)).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("sits mid-ramp when every value is identical, instead of dividing by zero", () => {
    const v = normalizeHeatmapValue(7, 7, 7, ordinary);
    expect(v).toBe(FLAT_POSITION);
    expect(Number.isFinite(v)).toBe(true);
  });

  it("handles a negative range (battery power swings through zero)", () => {
    expect(normalizeHeatmapValue(-5000, -5000, 5000, ordinary)).toBe(0);
    expect(normalizeHeatmapValue(0, -5000, 5000, ordinary)).toBe(0.5);
    expect(normalizeHeatmapValue(5000, -5000, 5000, ordinary)).toBe(1);
  });

  it("clamps a value outside [min,max] rather than leaving the ramp", () => {
    expect(normalizeHeatmapValue(150, 0, 100, ordinary)).toBe(1);
    expect(normalizeHeatmapValue(-10, 0, 100, ordinary)).toBe(0);
  });
});

describe("normalizeHeatmapValue — load/source power baseline", () => {
  it("returns the black sentinel at or below standby", () => {
    expect(normalizeHeatmapValue(0, 0, 5000, power)).toBe(BLACK_SENTINEL);
    expect(normalizeHeatmapValue(POWER_BASELINE_W, 0, 5000, power)).toBe(
      BLACK_SENTINEL,
    );
  });

  it("scales from the baseline (not from min) once above it", () => {
    // lo is the 50 W baseline, so the ramp is 50…5050, not min…max.
    expect(normalizeHeatmapValue(50.0001, 0, 5050, power)).toBeCloseTo(0, 6);
    expect(normalizeHeatmapValue(5050, 0, 5050, power)).toBe(1);
    expect(normalizeHeatmapValue(2550, 0, 5050, power)).toBeCloseTo(0.5, 10);
  });

  it("never divides by zero when the whole series sits at the baseline", () => {
    // Everything is <= 50, so every cell is black and the span is never consulted.
    expect(normalizeHeatmapValue(10, 0, 50, power)).toBe(BLACK_SENTINEL);
    expect(normalizeHeatmapValue(50, 50, 50, power)).toBe(BLACK_SENTINEL);
  });

  it("stays finite for a max barely above the baseline", () => {
    const v = normalizeHeatmapValue(50.5, 0, 51, power);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
