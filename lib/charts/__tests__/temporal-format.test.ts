import { describe, it, expect } from "@jest/globals";
import { parseAbsolute, toZoned } from "@internationalized/date";
import {
  formatHoverTimestamp,
  formatWindowLabel,
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

/**
 * The navigator's exclusive-vs-inclusive end rule. D/W windows run local-midnight → local-midnight
 * with an EXCLUSIVE end, so they must read as the days they actually cover ("24 Aug 2026"), not as
 * their bookend instants ("12am, 24 Aug – 12am, 25 Aug 2026"). M/Y already carry an INCLUSIVE last
 * day and must pass through untouched.
 */
describe("formatWindowLabel", () => {
  // Build a ZonedDateTime in a fixed +10 zone (no DST), matching the navigator's own
  // `fromUnixTimestamp` for a 600-minute offset.
  const zdt = (iso: string) =>
    toZoned(parseAbsolute(iso, "UTC"), "Australia/Brisbane");
  /** Local midnight (+10) as the UTC instant the navigator's window actually carries. */
  const localMidnight = (day: string) => zdt(`${day}T14:00:00Z`);

  const desktop = { includeTime: true };
  const mobile = { includeTime: false };

  it("collapses a whole-day D window to the single day it covers", () => {
    // [24 Aug 00:00, 25 Aug 00:00) is 24 Aug, not "12am, 24 Aug – 12am, 25 Aug".
    const start = localMidnight("2026-08-23");
    const end = localMidnight("2026-08-24");
    expect(formatWindowLabel(start, end, "D", desktop)).toBe("24 Aug 2026");
  });

  it("collapses a whole-week W window to its inclusive first/last day", () => {
    // [18 Aug 00:00, 25 Aug 00:00) is 18 – 24 Aug.
    const start = localMidnight("2026-08-17");
    const end = localMidnight("2026-08-24");
    expect(formatWindowLabel(start, end, "W", desktop)).toBe(
      "18 – 24 Aug 2026",
    );
  });

  it("desktop and mobile agree for a whole-day window", () => {
    const start = localMidnight("2026-08-23");
    const end = localMidnight("2026-08-24");
    expect(formatWindowLabel(start, end, "D", desktop)).toBe(
      formatWindowLabel(start, end, "D", mobile),
    );
  });

  it("spans a month boundary using the inclusive last day", () => {
    // [28 Jul 00:00, 4 Aug 00:00) is 28 Jul – 3 Aug.
    const start = localMidnight("2026-07-27");
    const end = localMidnight("2026-08-03");
    expect(formatWindowLabel(start, end, "W", desktop)).toBe(
      "28 Jul – 3 Aug 2026",
    );
  });

  it("spans a year boundary using the inclusive last day", () => {
    // [30 Dec 00:00, 6 Jan 00:00) is 30 Dec 2025 – 5 Jan 2026.
    const start = localMidnight("2025-12-29");
    const end = localMidnight("2026-01-05");
    expect(formatWindowLabel(start, end, "W", desktop)).toBe(
      "30 Dec 2025 – 5 Jan 2026",
    );
  });

  it("leaves a live trailing D window (ending at now) showing its times", () => {
    const start = zdt("2026-08-24T05:47:00Z"); // 3:47pm local
    const end = zdt("2026-08-25T05:47:00Z");
    expect(formatWindowLabel(start, end, "D", desktop)).toBe(
      "3:47pm, 24 Aug – 3:47pm, 25 Aug 2026",
    );
  });

  it("does not shift an M window (its end is already the INCLUSIVE last day)", () => {
    // M carries tz-naive UTC-midnight instants for [22 Jun, 21 Jul].
    const start = zdt("2026-06-22T00:00:00Z");
    const end = zdt("2026-07-21T00:00:00Z");
    expect(formatWindowLabel(start, end, "M", mobile)).toBe(
      "22 Jun – 21 Jul 2026",
    );
  });

  it("does not shift a Y window", () => {
    const start = zdt("2025-08-25T00:00:00Z");
    const end = zdt("2026-08-24T00:00:00Z");
    expect(formatWindowLabel(start, end, "Y", mobile)).toBe(
      "25 Aug 2025 – 24 Aug 2026",
    );
  });
});
