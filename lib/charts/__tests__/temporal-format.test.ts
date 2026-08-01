import { describe, it, expect } from "@jest/globals";
import {
  formatHoverTimestamp,
  getPeriodDuration,
  getPeriodIntervalMinutes,
} from "../temporal";

/**
 * What survives of the old `scaffold.test.ts`.
 *
 * Its `buildTimeScale` and `buildShadingAnnotations` suites went with Chart.js in Stage 6 — those
 * functions were axis CONFIG, and their replacements (`buildTimeTicks`, `buildShadingBands`) are
 * covered by `lib/charts/svg/__tests__/time-ticks.test.ts` against behaviour rather than config
 * objects. `formatHoverTimestamp` and the period algebra were never Chart.js-specific.
 */

describe("formatHoverTimestamp", () => {
  const d = new Date(2024, 7, 22, 23, 58, 0); // 11:58 PM

  it("returns '' for a null date", () => {
    expect(formatHoverTimestamp(null, "D")).toBe("");
  });

  it("formats time-only for D, date+time for W, date-only for M", () => {
    expect(formatHoverTimestamp(d, "D")).toMatch(/^\d{1,2}:\d{2}(am|pm)$/i);
    expect(formatHoverTimestamp(d, "W")).toMatch(/\d{1,2}:\d{2}(am|pm)$/i);
    expect(formatHoverTimestamp(d, "M")).not.toMatch(/(am|pm)/i);
  });

  it("drops the year on mobile", () => {
    expect(formatHoverTimestamp(d, "M", false)).toMatch(/2024/);
    expect(formatHoverTimestamp(d, "M", true)).not.toMatch(/2024/);
  });

  it("Y formats date-only, same as M", () => {
    expect(formatHoverTimestamp(d, "Y", false)).toBe(
      formatHoverTimestamp(d, "M", false),
    );
    expect(formatHoverTimestamp(d, "Y", true)).toBe(
      formatHoverTimestamp(d, "M", true),
    );
  });
});

describe("temporal period algebra (fixed nominal durations)", () => {
  const dayDuration = 24 * 60 * 60 * 1000;

  it("D/W/M/Y durations are fixed nominal and M/Y are daily-interval", () => {
    expect(getPeriodDuration("D")).toBe(dayDuration);
    expect(getPeriodDuration("W")).toBe(7 * dayDuration);
    expect(getPeriodDuration("M")).toBe(30 * dayDuration);
    expect(getPeriodDuration("Y")).toBe(365 * dayDuration);
    expect(getPeriodIntervalMinutes("D")).toBe(5);
    expect(getPeriodIntervalMinutes("W")).toBe(30);
    expect(getPeriodIntervalMinutes("M")).toBe(24 * 60);
    expect(getPeriodIntervalMinutes("Y")).toBe(24 * 60);
  });
});
