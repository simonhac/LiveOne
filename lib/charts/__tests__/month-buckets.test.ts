import { describe, expect, it } from "@jest/globals";
import {
  bucketDays,
  monthBuckets,
  rollUp,
  type MonthBucket,
} from "@/lib/charts/month-buckets";

const DAY_MS = 24 * 60 * 60_000;

/** UTC-midnight day markers, exactly the shape `lib/history/build-series.ts` emits for `1d`. */
function days(fromYMD: string, count: number): Date[] {
  const start = new Date(`${fromYMD}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, i) => new Date(start + i * DAY_MS));
}

/** The window a daily grid implies: first marker → last marker + one day (exclusive). */
function windowOf(ts: Date[]): [Date, Date] {
  return [ts[0], new Date(ts[ts.length - 1].getTime() + DAY_MS)];
}

function bucketsFor(ts: Date[]): MonthBucket[] {
  const [start, end] = windowOf(ts);
  return monthBuckets(ts, start, end);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("monthBuckets", () => {
  it("returns nothing for an empty series", () => {
    expect(
      monthBuckets([], new Date("2026-01-01Z"), new Date("2026-02-01Z")),
    ).toEqual([]);
  });

  it("buckets a whole calendar month into one span, not partial", () => {
    const ts = days("2026-03-01", 31);
    const b = bucketsFor(ts);
    expect(b).toHaveLength(1);
    expect(b[0].ym).toBe("2026-03");
    expect(b[0].indices).toHaveLength(31);
    expect(b[0].partial).toBe(false);
    expect(ymd(b[0].start)).toBe("2026-03-01");
    expect(ymd(b[0].end)).toBe("2026-04-01");
  });

  it("clamps the first and last buckets of a trailing window, and marks them partial", () => {
    // A trailing 365-day window ending 2026-06-14 → 13 buckets, both ends short.
    const ts = days("2025-06-15", 365);
    const b = bucketsFor(ts);
    expect(b).toHaveLength(13);
    expect(b.map((x) => x.ym)[0]).toBe("2025-06");
    expect(b[b.length - 1].ym).toBe("2026-06");

    expect(ymd(b[0].start)).toBe("2025-06-15");
    expect(ymd(b[0].end)).toBe("2025-07-01");
    expect(b[0].partial).toBe(true);
    expect(bucketDays(b[0])).toBe(16);

    const last = b[b.length - 1];
    expect(ymd(last.start)).toBe("2026-06-01");
    expect(ymd(last.end)).toBe("2026-06-15"); // exclusive: the 14th is the last day covered
    expect(last.partial).toBe(true);
    expect(bucketDays(last)).toBe(14);

    // Every interior bucket is a whole month, and every day lands in exactly one bucket.
    expect(b.slice(1, -1).every((x) => !x.partial)).toBe(true);
    expect(b.reduce((n, x) => n + x.indices.length, 0)).toBe(365);
  });

  it("gets February's length right in a leap year", () => {
    const ts = days("2028-02-01", 29);
    const b = bucketsFor(ts);
    expect(b).toHaveLength(1);
    expect(b[0].indices).toHaveLength(29);
    expect(bucketDays(b[0])).toBe(29);
    expect(b[0].partial).toBe(false);
  });

  it("keeps an empty month as a SLOT rather than closing the axis up", () => {
    // January and March report; February is missing entirely.
    const ts = [...days("2026-01-30", 2), ...days("2026-03-01", 2)];
    const b = monthBuckets(ts, ts[0], new Date("2026-03-03T00:00:00Z"));
    expect(b.map((x) => x.ym)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(b[1].indices).toEqual([]);
    expect(ymd(b[1].start)).toBe("2026-02-01");
    expect(ymd(b[1].end)).toBe("2026-03-01");
  });

  it("reads the month off the UTC getters, so a day marker never slips a month", () => {
    // 1d markers are tz-naive. The last day of a month must stay in that month, and the first day of
    // the next must start the next bucket — which is what breaks if an offset is applied first.
    const ts = days("2026-04-30", 2);
    const b = bucketsFor(ts);
    expect(b.map((x) => x.ym)).toEqual(["2026-04", "2026-05"]);
    expect(b[0].indices).toEqual([0]);
    expect(b[1].indices).toEqual([1]);
  });

  it("crosses a year boundary without a special case", () => {
    const ts = [...days("2025-12-30", 2), ...days("2026-01-01", 1)];
    const b = monthBuckets(ts, ts[0], new Date("2026-01-02T00:00:00Z"));
    expect(b.map((x) => x.ym)).toEqual(["2025-12", "2026-01"]);
  });
});

describe("rollUp", () => {
  const ts = [...days("2026-01-30", 2), ...days("2026-03-01", 2)];
  const b = monthBuckets(ts, ts[0], new Date("2026-03-03T00:00:00Z"));

  it("sums, means, mins and maxes over each bucket's members", () => {
    const v = [1, 2, 10, 20];
    expect(rollUp(v, b, "sum")).toEqual([3, null, 30]);
    expect(rollUp(v, b, "mean")).toEqual([1.5, null, 15]);
    expect(rollUp(v, b, "min")).toEqual([1, null, 10]);
    expect(rollUp(v, b, "max")).toEqual([2, null, 20]);
  });

  it("gives an empty month null, never 0 — a gap is not a zero reading", () => {
    expect(rollUp([1, 2, 3, 4], b, "sum")[1]).toBeNull();
  });

  it("gives an all-null month null, and ignores nulls inside a mixed one", () => {
    expect(rollUp([null, null, 4, null], b, "sum")).toEqual([null, null, 4]);
    expect(rollUp([null, null, 4, null], b, "mean")).toEqual([null, null, 4]);
  });

  it("treats non-finite values as missing", () => {
    expect(rollUp([NaN, 2, Infinity, 20], b, "sum")).toEqual([2, null, 20]);
  });

  it("means over the FINITE count, not the bucket's day count", () => {
    // Two days in the bucket, one of them null: the mean is the one value, not half of it.
    expect(rollUp([null, 7, 1, 1], b, "mean")).toEqual([7, null, 1]);
  });
});
