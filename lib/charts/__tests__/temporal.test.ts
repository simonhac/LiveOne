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

  it("snaps a stored M window to the whole calendar month containing its ?end", () => {
    const r = decodeRangeFromParams(params("period=M&end=2026-06-30"), OFFSET);
    expect(r.isLatest).toBe(false);
    expect(dayOf(r.start)).toBe("2026-06-01");
    expect(dayOf(r.end)).toBe("2026-06-30");
  });

  it("snaps a stored Y window to the whole calendar year containing its ?end", () => {
    const r = decodeRangeFromParams(params("period=Y&end=2025-12-31"), OFFSET);
    expect(r.isLatest).toBe(false);
    expect(dayOf(r.start)).toBe("2025-01-01");
    expect(dayOf(r.end)).toBe("2025-12-31");
  });

  /**
   * The snap is self-healing, and that is the point: a hand-typed date and every link shared under
   * the old TRAILING scheme (`?end=2026-06-21` used to mean 22 May – 21 Jun) both land on a window
   * the navigator can actually reach, rather than one it could never step back to.
   */
  it("snaps a mid-month ?end — including links written under the old trailing scheme", () => {
    for (const end of ["2026-06-01", "2026-06-15", "2026-06-21"]) {
      const r = decodeRangeFromParams(params(`period=M&end=${end}`), OFFSET);
      expect(dayOf(r.start)).toBe("2026-06-01");
      expect(dayOf(r.end)).toBe("2026-06-30");
    }
  });

  it("a snapped M window still carries UTC-midnight instants (no offset skew)", () => {
    const r = decodeRangeFromParams(params("period=M&end=2026-06-30"), OFFSET);
    expect(r.start!).toBe("2026-06-01T00:00:00.000Z");
    expect(r.end!).toBe("2026-06-30T00:00:00.000Z");
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

  /**
   * M/Y stepping SNAPS: the latest window is trailing (22 Jun – 21 Jul), but every window older than
   * it is a whole named calendar month/year. The first click therefore OVERLAPS the latest window —
   * deliberately, and unlike D/W, which stay contiguous.
   */
  it("M: the first click off the trailing latest lands on the previous whole month", () => {
    const dflt = decodeRangeFromParams(params("period=M"), OFFSET);
    const older = computeOlder(dflt, OFFSET);
    // Latest is 22 Jun – 21 Jul, so the month before July is June — overlapping 22–30 Jun.
    expect(dayOf(older.start)).toBe("2026-06-01");
    expect(dayOf(older.end)).toBe("2026-06-30");
  });

  it("M: subsequent clicks walk whole calendar months, using each month's real length", () => {
    let win = computeOlder(
      decodeRangeFromParams(params("period=M"), OFFSET),
      OFFSET,
    );
    const seen: string[][] = [];
    for (let i = 0; i < 5; i++) {
      seen.push([dayOf(win.start)!, dayOf(win.end)!]);
      win = computeOlder(asRange("M", win), OFFSET);
    }
    expect(seen).toEqual([
      ["2026-06-01", "2026-06-30"],
      ["2026-05-01", "2026-05-31"],
      ["2026-04-01", "2026-04-30"],
      ["2026-03-01", "2026-03-31"],
      ["2026-02-01", "2026-02-28"], // 2026 is not a leap year
    ]);
  });

  it("M: steps across a year boundary into December", () => {
    const jan = decodeRangeFromParams(
      params("period=M&end=2026-01-31"),
      OFFSET,
    );
    const older = computeOlder(jan, OFFSET);
    expect(dayOf(older.start)).toBe("2025-12-01");
    expect(dayOf(older.end)).toBe("2025-12-31");
  });

  it("Y: the first click off the trailing latest lands on the previous whole year", () => {
    const dflt = decodeRangeFromParams(params("period=Y"), OFFSET);
    const older = computeOlder(dflt, OFFSET);
    // Latest is 22 Jul 2025 – 21 Jul 2026, so the year before 2026 is 2025.
    expect(dayOf(older.start)).toBe("2025-01-01");
    expect(dayOf(older.end)).toBe("2025-12-31");

    const older2 = computeOlder(asRange("Y", older), OFFSET);
    expect(dayOf(older2.start)).toBe("2024-01-01");
    expect(dayOf(older2.end)).toBe("2024-12-31"); // leap year, real length
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

    const older1 = asRange("M", computeOlder(dflt, OFFSET)); // June 2026
    expect(computeNewer(older1, OFFSET)).toBe("live");

    const older2 = asRange("M", computeOlder(older1, OFFSET)); // May 2026
    const back = computeNewer(older2, OFFSET);
    expect(back).not.toBe("live");
    expect(dayOf((back as { start: string; end: string }).start)).toBe(
      "2026-06-01",
    );
    expect(dayOf((back as { start: string; end: string }).end)).toBe(
      "2026-06-30",
    );
  });

  it("Y older-1 → live; Y older-2 → older-1", () => {
    const dflt = decodeRangeFromParams(params("period=Y"), OFFSET);
    const older1 = asRange("Y", computeOlder(dflt, OFFSET)); // 2025
    expect(computeNewer(older1, OFFSET)).toBe("live");

    const older2 = asRange("Y", computeOlder(older1, OFFSET)); // 2024
    const back = computeNewer(older2, OFFSET);
    expect(dayOf((back as { start: string; end: string }).start)).toBe(
      "2025-01-01",
    );
    expect(dayOf((back as { start: string; end: string }).end)).toBe(
      "2025-12-31",
    );
  });

  /**
   * computeNewer is the exact inverse of computeOlder, which is what keeps ‹ then › from stranding
   * you: every older step is reachable again, and the walk terminates at "live" rather than at some
   * window the URL can't express.
   */
  it("M/Y: ‹ n times then › n times returns to live, via every window it passed", () => {
    for (const period of ["M", "Y"] as const) {
      const stack: { start: string; end: string }[] = [];
      let cur = computeOlder(
        decodeRangeFromParams(params(`period=${period}`), OFFSET),
        OFFSET,
      );
      for (let i = 0; i < 3; i++) {
        stack.push(cur);
        cur = computeOlder(asRange(period, cur), OFFSET);
      }
      // Walk back up: each › must land exactly on the window ‹ came from.
      let up: { start: string; end: string } | "live" | null = cur;
      for (const expected of [...stack].reverse()) {
        up = computeNewer(
          asRange(period, up as { start: string; end: string }),
          OFFSET,
        );
        expect(up).toEqual(expected);
      }
      expect(
        computeNewer(
          asRange(period, up as { start: string; end: string }),
          OFFSET,
        ),
      ).toBe("live");
    }
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
    // A snapped window's last day IS a month end, so the stored `?end` snaps straight back to it.
    expect(p.get("end")).toBe("2026-06-30");
    expect(p.get("start")).toBeNull();
    expect(p.get("offset")).toBeNull();
    const r = decodeRangeFromParams(p, OFFSET);
    expect(dayOf(r.start)).toBe("2026-06-01");
    expect(dayOf(r.end)).toBe("2026-06-30");
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

/**
 * Malformed params. The URL is user-editable and links get mangled in transit, so an unreadable
 * `?start` is routine input — it must degrade to the default window, never throw. (It used to throw
 * a RangeError out of `useTemporalRange`'s useMemo, blanking the entire dashboard.)
 */
describe("decodeRangeFromParams — malformed params", () => {
  // The reported URL: `_00:00` where the format wants `_00.00`.
  it("degrades a colon-separated ?start to the live window and reports it dropped", () => {
    const qs = "period=D&start=2026-07-21_00:00&offset=600m";
    expect(() => decodeRangeFromParams(params(qs), OFFSET)).not.toThrow();

    const r = decodeRangeFromParams(params(qs), OFFSET);
    expect(r.period).toBe("D");
    expect(r.isHistoricalMode).toBe(false);
    expect(r.isLatest).toBe(true);
    expect(r.start).toBeUndefined();
    expect(r.end).toBeUndefined();
    // The orphaned ?offset goes too — it means nothing without the window it qualified.
    expect(r.droppedParams).toEqual([
      { param: "start", value: "2026-07-21_00:00" },
      { param: "offset", value: "600m" },
    ]);
  });

  it.each(["period=D&start=garbage", "period=W&end=garbage"])(
    "degrades %s to the live window",
    (qs) => {
      const r = decodeRangeFromParams(params(qs), OFFSET);
      expect(r.isHistoricalMode).toBe(false);
      expect(r.isLatest).toBe(true);
      expect(r.droppedParams).toHaveLength(1);
      expect(r.droppedParams?.[0].value).toBe("garbage");
    },
  );

  // A bad offset costs you the offset, never the date.
  it("keeps the window when only ?offset is unreadable, falling back to the area timezone", () => {
    const r = decodeRangeFromParams(
      params("period=D&start=2026-07-21_00.00&offset=abc"),
      OFFSET,
    );
    const good = decodeRangeFromParams(
      params("period=D&start=2026-07-21_00.00"),
      OFFSET,
    );
    expect(r.start).toBe(good.start);
    expect(r.end).toBe(good.end);
    expect(r.isHistoricalMode).toBe(true);
    expect(r.droppedParams).toEqual([{ param: "offset", value: "abc" }]);
  });

  // M/Y used to ignore a non-date-only ?end in SILENCE, so the URL claimed one month and the page
  // showed another.
  it("drops an unreadable M/Y ?end instead of silently snapping to latest", () => {
    for (const bad of ["2026-06-21_00:00", "potato", "2026-02-31"]) {
      const r = decodeRangeFromParams(params(`period=M&end=${bad}`), OFFSET);
      const dflt = decodeRangeFromParams(params("period=M"), OFFSET);
      expect(r.start).toBe(dflt.start);
      expect(r.end).toBe(dflt.end);
      expect(r.isLatest).toBe(true);
      expect(r.droppedParams).toEqual([{ param: "end", value: bad }]);
    }
  });

  it("leaves canonical params alone — no droppedParams on the happy path", () => {
    for (const qs of [
      "period=D",
      "period=D&start=2026-07-21_00.00&offset=600m",
      "period=W&start=2026-07-14_00.00&offset=600m",
      "period=M&end=2026-06-21",
      "period=Y&end=2026-06-21",
    ]) {
      expect(
        decodeRangeFromParams(params(qs), OFFSET).droppedParams,
      ).toBeUndefined();
    }
  });

  it("still honours a readable M ?end (the regression guard for the new decoder)", () => {
    // Readable ⇒ used, not dropped. The day it names is then SNAPPED to its calendar month, so this
    // is the whole of June rather than the trailing 22 May – 21 Jun the old decoder produced.
    const r = decodeRangeFromParams(params("period=M&end=2026-06-21"), OFFSET);
    expect(r.isLatest).toBe(false);
    expect(r.droppedParams).toBeUndefined();
    expect(dayOf(r.start)).toBe("2026-06-01");
    expect(dayOf(r.end)).toBe("2026-06-30");
  });
});
