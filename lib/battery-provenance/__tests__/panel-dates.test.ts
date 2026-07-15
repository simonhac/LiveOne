import { describe, expect, it } from "@jest/globals";
import {
  addDaysToYMD,
  formatYMDRange,
  historicalWindow,
  ymdToLocalDate,
} from "../panel-dates";

describe("ymdToLocalDate", () => {
  it("parses YYYY-MM-DD into a local Date at the given hour", () => {
    const d = ymdToLocalDate("2026-03-05", 12);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // 0-indexed
    expect(d.getDate()).toBe(5);
    expect(d.getHours()).toBe(12);
  });

  it("defaults to midnight", () => {
    expect(ymdToLocalDate("2026-01-01").getHours()).toBe(0);
  });
});

describe("addDaysToYMD", () => {
  it("adds a positive delta", () => {
    expect(addDaysToYMD("2026-01-01", 5)).toBe("2026-01-06");
  });

  it("subtracts with a negative delta", () => {
    expect(addDaysToYMD("2026-01-06", -5)).toBe("2026-01-01");
  });

  it("crosses a month boundary", () => {
    expect(addDaysToYMD("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysToYMD("2026-02-01", -1)).toBe("2026-01-31");
  });

  it("crosses a year boundary", () => {
    expect(addDaysToYMD("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("handles a leap-year Feb 29 correctly", () => {
    // 2028 is a leap year.
    expect(addDaysToYMD("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToYMD("2028-02-29", 1)).toBe("2028-03-01");
    // 2026 is not.
    expect(addDaysToYMD("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("zero-pads single-digit months and days", () => {
    expect(addDaysToYMD("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysToYMD("2026-09-09", 1)).toBe("2026-09-10");
  });
});

describe("historicalWindow", () => {
  it("olderSteps=1 with a 30-day period ends the day before the live window would start", () => {
    // Live (olderSteps=0, not exercised by this function) would be [2026-06-15, 2026-07-14] —
    // the 30 days ending yesterday. Step 1 must end the day BEFORE that window starts.
    const { startDay, endDay } = historicalWindow("2026-07-15", 30, 1);
    expect(endDay).toBe("2026-06-14"); // = live window's start (2026-06-15) minus 1 day
    expect(startDay).toBe("2026-05-16");
    // Inclusive span is exactly dayCount days.
    const spanDays =
      (new Date(endDay).getTime() - new Date(startDay).getTime()) /
        (24 * 60 * 60 * 1000) +
      1;
    expect(spanDays).toBe(30);
  });

  it("olderSteps=2 steps back a further whole period (non-overlapping with step 1)", () => {
    const step1 = historicalWindow("2026-07-15", 30, 1);
    const step2 = historicalWindow("2026-07-15", 30, 2);
    // step2's end is exactly the day before step1's start — no gap, no overlap.
    expect(addDaysToYMD(step2.endDay, 1)).toBe(step1.startDay);
  });

  it("365-day period spans exactly 365 days and ends before the live window", () => {
    const { startDay, endDay } = historicalWindow("2026-07-15", 365, 1);
    // Live window (not exercised here) would end 2026-07-14 (yesterday) and start 2025-07-15.
    expect(endDay).toBe("2025-07-14"); // = live window's start minus 1 day
    const spanDays =
      (new Date(endDay).getTime() - new Date(startDay).getTime()) /
        (24 * 60 * 60 * 1000) +
      1;
    expect(spanDays).toBe(365);
  });
});

describe("formatYMDRange", () => {
  it("formats both ends of the range from the day strings directly", () => {
    expect(formatYMDRange("2025-08-16", "2026-07-14")).toBe(
      "16 Aug 2025 – 14 Jul 2026",
    );
  });

  it("is insensitive to the runtime's timezone (no instant/offset conversion)", () => {
    // Regression guard for the bug this module exists to avoid: formatting must read the Y/M/D
    // straight off the parsed date, never round-trip through a UTC-timestamp/area-offset
    // conversion that could land on the adjacent calendar day.
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14 — as far as possible from UTC-11/12
      expect(formatYMDRange("2026-01-01", "2026-01-01")).toBe(
        "1 Jan 2026 – 1 Jan 2026",
      );
      process.env.TZ = "Etc/GMT+12"; // UTC-12
      expect(formatYMDRange("2026-01-01", "2026-01-01")).toBe(
        "1 Jan 2026 – 1 Jan 2026",
      );
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});
