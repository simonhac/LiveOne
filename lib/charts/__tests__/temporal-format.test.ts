import { describe, it, expect } from "@jest/globals";
import { parseAbsolute, toZoned } from "@internationalized/date";
import {
  formatHoverTimestamp,
  formatWindowLabel,
  getPeriodDuration,
  getPeriodIntervalMinutes,
  isDateOnlyPeriod,
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
 * The navigator's two label rules.
 *
 * 1. Exclusive-vs-inclusive ends. D/W windows run local-midnight → local-midnight with an EXCLUSIVE
 *    end, so they must read as the days they actually cover ("24 Aug 2026"), not as their bookend
 *    instants ("12am, 24 Aug – 12am, 25 Aug 2026"). M/Y ends are already INCLUSIVE and pass through.
 * 2. Whole calendar periods are NAMED ("August 2026", "2026") rather than spelled out as a range —
 *    the usual case for M/Y, whose windows snap to the calendar once you step back off the latest.
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

  /**
   * Every M/Y window older than the latest is calendar-snapped, so this is their NORMAL spelling:
   * once the range IS the period, naming it beats printing both endpoints.
   */
  describe("whole calendar periods collapse to their name", () => {
    it("names a whole month", () => {
      const start = zdt("2026-08-01T00:00:00Z");
      const end = zdt("2026-08-31T00:00:00Z");
      expect(formatWindowLabel(start, end, "M", mobile)).toBe("August 2026");
    });

    it("names a whole year", () => {
      const start = zdt("2025-01-01T00:00:00Z");
      const end = zdt("2025-12-31T00:00:00Z");
      expect(formatWindowLabel(start, end, "Y", mobile)).toBe("2025");
    });

    it("uses the real month length (30-day, non-leap and leap February)", () => {
      expect(
        formatWindowLabel(
          zdt("2026-09-01T00:00:00Z"),
          zdt("2026-09-30T00:00:00Z"),
          "M",
          mobile,
        ),
      ).toBe("September 2026");
      expect(
        formatWindowLabel(
          zdt("2026-02-01T00:00:00Z"),
          zdt("2026-02-28T00:00:00Z"),
          "M",
          mobile,
        ),
      ).toBe("February 2026");
      expect(
        formatWindowLabel(
          zdt("2028-02-01T00:00:00Z"),
          zdt("2028-02-29T00:00:00Z"),
          "M",
          mobile,
        ),
      ).toBe("February 2028");
    });

    it("collapses under the opts the navigator actually passes, on both breakpoints", () => {
      // TemporalNavigator passes `includeTime: !isDateOnlyPeriod(period)` on desktop and a flat
      // `false` on mobile — so for M/Y both breakpoints are date-only and both show the name.
      const start = zdt("2026-08-01T00:00:00Z");
      const end = zdt("2026-08-31T00:00:00Z");
      for (const period of ["M", "Y"] as const) {
        const navDesktop = { includeTime: !isDateOnlyPeriod(period) };
        expect(formatWindowLabel(start, end, period, navDesktop)).toBe(
          "August 2026",
        );
        expect(formatWindowLabel(start, end, period, mobile)).toBe(
          "August 2026",
        );
      }
    });

    it("a caller that asks for times still gets them", () => {
      // The collapse is a DATE-ONLY spelling. `includeTime: true` means the endpoints matter, so it
      // must not silently lose them — the guard that keeps this rule out of D/W's live windows.
      expect(
        formatWindowLabel(
          zdt("2026-08-01T00:00:00Z"),
          zdt("2026-08-31T00:00:00Z"),
          "W",
          desktop,
        ),
      ).toBe("10am, 1 Aug – 10am, 31 Aug 2026");
    });

    it("leaves a near-miss window spelled as a range", () => {
      // One day short at either end is NOT the month, and must not be named as one.
      expect(
        formatWindowLabel(
          zdt("2026-08-01T00:00:00Z"),
          zdt("2026-08-30T00:00:00Z"),
          "M",
          mobile,
        ),
      ).toBe("1 – 30 Aug 2026");
      expect(
        formatWindowLabel(
          zdt("2026-08-02T00:00:00Z"),
          zdt("2026-08-31T00:00:00Z"),
          "M",
          mobile,
        ),
      ).toBe("2 – 31 Aug 2026");
      expect(
        formatWindowLabel(
          zdt("2026-02-01T00:00:00Z"),
          zdt("2026-02-27T00:00:00Z"),
          "M",
          mobile,
        ),
      ).toBe("1 – 27 Feb 2026");
      expect(
        formatWindowLabel(
          zdt("2025-01-01T00:00:00Z"),
          zdt("2025-12-30T00:00:00Z"),
          "Y",
          mobile,
        ),
      ).toBe("1 Jan – 30 Dec 2025");
    });

    it("does not name a 12-month window that is not a calendar year", () => {
      expect(
        formatWindowLabel(
          zdt("2025-02-01T00:00:00Z"),
          zdt("2026-01-31T00:00:00Z"),
          "Y",
          mobile,
        ),
      ).toBe("1 Feb 2025 – 31 Jan 2026");
    });
  });
});
