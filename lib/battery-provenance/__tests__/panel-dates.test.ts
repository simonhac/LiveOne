import { describe, expect, it } from "@jest/globals";
import {
  addDaysToYMD,
  calendarHistoricalWindow,
  formatYMDRange,
  ymdToLocalDate,
} from "../panel-dates";

const DAY_MS = 24 * 60 * 60 * 1000;
const inclusiveSpan = (startDay: string, endDay: string) =>
  (new Date(endDay).getTime() - new Date(startDay).getTime()) / DAY_MS + 1;

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

describe("calendarHistoricalWindow", () => {
  it("default M (olderSteps=0) is the trailing calendar month ending yesterday", () => {
    // today = 22 Jul 2026 → 22 Jun – 21 Jul inclusive.
    const { startDay, endDay } = calendarHistoricalWindow(
      "2026-07-22",
      "month",
      0,
    );
    expect(startDay).toBe("2026-06-22");
    expect(endDay).toBe("2026-07-21");
  });

  it("older M steps back one whole calendar month (contiguous with the default)", () => {
    const dflt = calendarHistoricalWindow("2026-07-22", "month", 0);
    const older1 = calendarHistoricalWindow("2026-07-22", "month", 1);
    expect(older1.startDay).toBe("2026-05-22");
    expect(older1.endDay).toBe("2026-06-21");
    // No gap / overlap: the day after older1's end is the default's start.
    expect(addDaysToYMD(older1.endDay, 1)).toBe(dflt.startDay);
  });

  it("default Y (olderSteps=0) is the trailing calendar year ending yesterday", () => {
    // today = 22 Jul 2026 → 22 Jul 2025 – 21 Jul 2026 inclusive.
    const { startDay, endDay } = calendarHistoricalWindow(
      "2026-07-22",
      "year",
      0,
    );
    expect(startDay).toBe("2025-07-22");
    expect(endDay).toBe("2026-07-21");
    expect(inclusiveSpan(startDay, endDay)).toBe(365);
  });

  it("older Y steps back one whole calendar year (contiguous)", () => {
    const dflt = calendarHistoricalWindow("2026-07-22", "year", 0);
    const older1 = calendarHistoricalWindow("2026-07-22", "year", 1);
    expect(older1.startDay).toBe("2024-07-22");
    expect(older1.endDay).toBe("2025-07-21");
    expect(addDaysToYMD(older1.endDay, 1)).toBe(dflt.startDay);
  });

  it("a Y window spanning a leap February is 366 days", () => {
    // today = 22 Jul 2024 → 22 Jul 2023 – 21 Jul 2024 (includes 29 Feb 2024).
    const { startDay, endDay } = calendarHistoricalWindow(
      "2024-07-22",
      "year",
      0,
    );
    expect(startDay).toBe("2023-07-22");
    expect(endDay).toBe("2024-07-21");
    expect(inclusiveSpan(startDay, endDay)).toBe(366);
  });

  it("clamps at month-ends and stays contiguous (today = 31 Mar)", () => {
    // 31 Mar − 1 month clamps to 28 Feb; the default month is 28 Feb – 30 Mar.
    const dflt = calendarHistoricalWindow("2026-03-31", "month", 0);
    expect(dflt.startDay).toBe("2026-02-28");
    expect(dflt.endDay).toBe("2026-03-30");
    // older-1 anchors to 31 Mar (multiply form): [31 Jan, 27 Feb].
    const older1 = calendarHistoricalWindow("2026-03-31", "month", 1);
    expect(older1.startDay).toBe("2026-01-31");
    expect(older1.endDay).toBe("2026-02-27");
    expect(addDaysToYMD(older1.endDay, 1)).toBe(dflt.startDay);
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
