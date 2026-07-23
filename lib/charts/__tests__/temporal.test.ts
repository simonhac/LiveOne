import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  decodeRangeFromParams,
  computeOlder,
  computeNewer,
  encodeRangeToParams,
  isDateOnlyPeriod,
  type TemporalRange,
} from "../temporal";
import { endDateFromIso } from "@/lib/date-utils";

// Fixed offset +10:00 (AEST, no DST) used throughout.
const OFFSET = 600;

// System time pinned to 07:30 local (22 Jul 2026 +10:00) so "today" = 2026-07-22, "yesterday" =
// 2026-07-21, and the D/W live windows include today's partial day.
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-07-21T21:30:00.000Z")); // = 2026-07-22 07:30 +10:00
});
afterEach(() => {
  jest.useRealTimers();
});

const params = (qs: string) => new URLSearchParams(qs);
// Recovers the local calendar date of a window instant. Works for both conventions: D/W store
// local-midnight-as-UTC (+offset → the local date), M/Y store UTC-midnight (+offset stays same day).
const dayOf = (iso?: string) =>
  iso ? endDateFromIso(iso, OFFSET).toString() : undefined;
const asRange = (
  period: TemporalRange["period"],
  win: { start: string; end: string },
): TemporalRange => ({
  period,
  start: win.start,
  end: win.end,
  isHistoricalMode: true,
  isLatest: false,
});

describe("decodeRangeFromParams", () => {
  it("defaults M to the trailing calendar month ending yesterday (inclusive 22 Jun – 21 Jul)", () => {
    const r = decodeRangeFromParams(params("period=M"), OFFSET);
    expect(r.period).toBe("M");
    expect(r.isHistoricalMode).toBe(true);
    expect(r.isLatest).toBe(true);
    expect(dayOf(r.start)).toBe("2026-06-22"); // inclusive first day
    expect(dayOf(r.end)).toBe("2026-07-21"); // inclusive last day (today's partial day excluded)
  });

  it("defaults Y to the trailing calendar year ending yesterday (22 Jul 2025 – 21 Jul 2026)", () => {
    const r = decodeRangeFromParams(params("period=Y"), OFFSET);
    expect(r.period).toBe("Y");
    expect(r.isLatest).toBe(true);
    expect(dayOf(r.start)).toBe("2025-07-22");
    expect(dayOf(r.end)).toBe("2026-07-21");
  });

  it("D (and an absent period) is live: no explicit window, not historical, at latest", () => {
    for (const qs of ["period=D", ""]) {
      const r = decodeRangeFromParams(params(qs), OFFSET);
      expect(r.period).toBe("D");
      expect(r.start).toBeUndefined();
      expect(r.end).toBeUndefined();
      expect(r.isHistoricalMode).toBe(false);
      expect(r.isLatest).toBe(true);
    }
  });

  it("an unknown period collapses to D", () => {
    expect(decodeRangeFromParams(params("period=30D"), OFFSET).period).toBe(
      "D",
    );
  });

  it("decodes a stored M window from its inclusive-last-day ?end, deriving first day via calendar", () => {
    const r = decodeRangeFromParams(params("period=M&end=2026-06-21"), OFFSET);
    expect(r.isLatest).toBe(false);
    expect(dayOf(r.start)).toBe("2026-05-22");
    expect(dayOf(r.end)).toBe("2026-06-21");
  });

  it("the M/Y history request encodes to the exact inclusive UTC calendar days (no offset skew)", () => {
    // Regression guard for the `encodeHistoryWindow` date-extraction: the ISO instants must be
    // UTC-midnight so `iso.split('T')[0]` yields the intended calendar date.
    const r = decodeRangeFromParams(params("period=M"), OFFSET);
    expect(r.start!.slice(0, 10)).toBe("2026-06-22");
    expect(r.end!.slice(0, 10)).toBe("2026-07-21");
    expect(r.start!.endsWith("T00:00:00.000Z")).toBe(true);
    expect(r.end!.endsWith("T00:00:00.000Z")).toBe(true);
  });
});

describe("computeOlder", () => {
  it("D live: first click snaps the window END to local midnight today (the full previous day)", () => {
    const live = decodeRangeFromParams(params("period=D"), OFFSET);
    const older = computeOlder(live, OFFSET);
    expect(dayOf(older.start)).toBe("2026-07-21");
    expect(dayOf(older.end)).toBe("2026-07-22"); // 00:00 today → shows all of 21 Jul
  });

  it("W live: first click snaps to the 7 full days ending 00:00 today", () => {
    const live = decodeRangeFromParams(params("period=W"), OFFSET);
    const older = computeOlder(live, OFFSET);
    expect(dayOf(older.start)).toBe("2026-07-15");
    expect(dayOf(older.end)).toBe("2026-07-22");
  });

  it("D historical: subsequent clicks step back one whole day, staying day-aligned", () => {
    const first = asRange(
      "D",
      computeOlder(decodeRangeFromParams(params("period=D"), OFFSET), OFFSET),
    );
    const second = computeOlder(first, OFFSET);
    expect(dayOf(second.start)).toBe("2026-07-20");
    expect(dayOf(second.end)).toBe("2026-07-21");
  });

  it("M: steps back one whole calendar month, contiguous with the default", () => {
    const dflt = decodeRangeFromParams(params("period=M"), OFFSET);
    const older = computeOlder(dflt, OFFSET);
    expect(dayOf(older.start)).toBe("2026-05-22");
    expect(dayOf(older.end)).toBe("2026-06-21"); // day before the default's first day (22 Jun)
  });

  it("Y: steps back one whole calendar year, contiguous with the default", () => {
    const dflt = decodeRangeFromParams(params("period=Y"), OFFSET);
    const older = computeOlder(dflt, OFFSET);
    expect(dayOf(older.start)).toBe("2024-07-22");
    expect(dayOf(older.end)).toBe("2025-07-21");
  });
});

describe("computeNewer", () => {
  it("D/W live: no-op (null)", () => {
    const live = decodeRangeFromParams(params("period=D"), OFFSET);
    expect(computeNewer(live, OFFSET)).toBeNull();
  });

  it("D first-older → live (its end is already 00:00 today)", () => {
    const first = asRange(
      "D",
      computeOlder(decodeRangeFromParams(params("period=D"), OFFSET), OFFSET),
    );
    expect(computeNewer(first, OFFSET)).toBe("live");
  });

  it("D second-older steps forward to the first-older window", () => {
    const first = asRange(
      "D",
      computeOlder(decodeRangeFromParams(params("period=D"), OFFSET), OFFSET),
    );
    const second = asRange("D", computeOlder(first, OFFSET));
    const back = computeNewer(second, OFFSET);
    expect(back).not.toBe("live");
    expect(dayOf((back as { start: string; end: string }).end)).toBe(
      "2026-07-22",
    );
  });

  it("M at default → live; M older-1 → live (back to default); M older-2 → older-1", () => {
    const dflt = decodeRangeFromParams(params("period=M"), OFFSET);
    expect(computeNewer(dflt, OFFSET)).toBe("live");

    const older1 = asRange("M", computeOlder(dflt, OFFSET));
    expect(computeNewer(older1, OFFSET)).toBe("live");

    const older2 = asRange("M", computeOlder(older1, OFFSET));
    const back = computeNewer(older2, OFFSET);
    expect(back).not.toBe("live");
    expect(dayOf((back as { start: string; end: string }).end)).toBe(
      "2026-06-21",
    );
  });
});

describe("encodeRangeToParams", () => {
  it("live drops start/end/offset (the param-free latest state)", () => {
    const p = encodeRangeToParams(params("period=M&end=2026-06-21"), "live", {
      period: "M",
      timezoneOffsetMin: OFFSET,
    });
    expect(p.get("period")).toBe("M");
    expect(p.get("end")).toBeNull();
    expect(p.get("start")).toBeNull();
    expect(p.get("offset")).toBeNull();
  });

  it("M/Y store the date-only inclusive LAST day and drop start/offset (round-trips)", () => {
    const older = computeOlder(
      decodeRangeFromParams(params("period=M"), OFFSET),
      OFFSET,
    );
    const p = encodeRangeToParams(params("period=M"), older, {
      period: "M",
      timezoneOffsetMin: OFFSET,
    });
    expect(p.get("end")).toBe("2026-06-21");
    expect(p.get("start")).toBeNull();
    expect(p.get("offset")).toBeNull();
    const r = decodeRangeFromParams(p, OFFSET);
    expect(dayOf(r.start)).toBe("2026-05-22");
    expect(dayOf(r.end)).toBe("2026-06-21");
    expect(r.isLatest).toBe(false);
  });

  it("D/W store start + offset and drop end (round-trips)", () => {
    const older = computeOlder(
      decodeRangeFromParams(params("period=D"), OFFSET),
      OFFSET,
    );
    const p = encodeRangeToParams(params("period=D"), older, {
      period: "D",
      timezoneOffsetMin: OFFSET,
    });
    expect(p.get("start")).toBeTruthy();
    expect(p.get("offset")).toBe("600m");
    expect(p.get("end")).toBeNull();
    const r = decodeRangeFromParams(p, OFFSET);
    expect(dayOf(r.start)).toBe("2026-07-21");
    expect(dayOf(r.end)).toBe("2026-07-22");
  });
});

describe("isDateOnlyPeriod", () => {
  it("is true for M and Y, false for D and W", () => {
    expect(isDateOnlyPeriod("M")).toBe(true);
    expect(isDateOnlyPeriod("Y")).toBe(true);
    expect(isDateOnlyPeriod("D")).toBe(false);
    expect(isDateOnlyPeriod("W")).toBe(false);
  });
});
