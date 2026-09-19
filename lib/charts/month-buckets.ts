/**
 * Month bucketing for the Y period — pure, so the roll-up rules are testable without a DOM.
 *
 * The Y view fetches `interval=1d` like M does and draws ~365 daily bars, which is unreadable. There
 * is no `agg_1mon` table and no API change behind this: ≤366 daily rows per series roll up trivially
 * in the browser, so `/api/history` keeps returning `1d` and the client groups the days by calendar
 * month. One bar per month, each bar the month's TOTAL.
 *
 * 🛑 **The month comes from the UTC getters, with NO offset applied.** A `1d` timestamp is not an
 * instant: `lib/history/build-series.ts` builds it as `new Date(day + "T00:00:00Z")`, i.e. a tz-naive
 * UTC-midnight MARKER of the area-local calendar day. Reading it with `getUTCMonth()` therefore gives
 * the local day's own month, and adding a timezone offset first (the natural instinct, and what
 * `tiles/use-site-bars.ts` has to do for its sub-daily buckets) would shift a marker into the wrong
 * month at either end. Verified against `build-series.ts`; the day string is the source of truth and
 * the `Z` is a carrier, not a claim about the zone.
 *
 * Buckets run CONTIGUOUSLY from the first timestamp's month to the last's, so a month with no data
 * in the middle of a window is an empty slot rather than a closed-up axis — the same rule
 * `bucketBars` in `lib/charts/tile-bars.ts` follows, and for the same reason: the axis is a calendar,
 * not a list of the months that happened to report.
 *
 * `start`/`end` are CLAMPED to the window, so the first and last buckets of a trailing 365-day window
 * are short. That is what lets the renderer draw a partial month NARROWER than a whole one, which is
 * the honest cue that its total covers fewer days.
 */

/** Aggregation rule for a series, mirroring `lib/aggregation/point-aggregates.ts`. */
export type RollUpHow = "sum" | "mean" | "min" | "max";

export interface MonthBucket {
  /** Bucket start, clamped to the window (so a leading partial month starts mid-month). */
  start: Date;
  /** Bucket end, EXCLUSIVE, clamped to the window. */
  end: Date;
  /** Indices into the source `timestamps` that fall in this month (empty for a month with no rows). */
  indices: number[];
  /** `YYYY-MM`, the bucket's identity. */
  ym: string;
  /** True when the clamped span is shorter than the whole calendar month. */
  partial: boolean;
}

const MS_PER_MIN = 60_000;

/** `YYYY-MM` for a UTC-midnight day marker. */
function ymOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monotonic month key, so "the next month" is `+ 1` and December→January needs no special case. */
function monthKey(d: Date): number {
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function monthStart(key: number): Date {
  return new Date(Date.UTC(Math.floor(key / 12), key % 12, 1));
}

/**
 * Group day markers into contiguous calendar-month buckets clamped to `[windowStart, windowEnd)`.
 *
 * `windowEnd` is EXCLUSIVE: for a daily grid the caller passes `lastTimestamp + 1 day`, because a day
 * marker is the START of the day it names and the last day's bar has to cover it.
 *
 * Returns `[]` for an empty `timestamps` — "no data" is the caller's empty state, not a zero-width
 * bucket. Timestamps are assumed ascending (every producer here builds them from a start + a fixed
 * step) and out-of-window ones are simply not claimed by any bucket.
 */
export function monthBuckets(
  timestamps: readonly Date[],
  windowStart: Date,
  windowEnd: Date,
): MonthBucket[] {
  if (timestamps.length === 0) return [];

  const first = monthKey(timestamps[0]);
  const last = monthKey(timestamps[timestamps.length - 1]);

  const byKey = new Map<number, number[]>();
  timestamps.forEach((t, i) => {
    const k = monthKey(t);
    const acc = byKey.get(k);
    if (acc) acc.push(i);
    else byKey.set(k, [i]);
  });

  const lo = windowStart.getTime();
  const hi = windowEnd.getTime();

  const out: MonthBucket[] = [];
  for (let key = first; key <= last; key++) {
    const natStart = monthStart(key).getTime();
    const natEnd = monthStart(key + 1).getTime();
    const start = Math.max(natStart, lo);
    const end = Math.min(natEnd, hi);
    out.push({
      start: new Date(start),
      end: new Date(end),
      indices: byKey.get(key) ?? [],
      ym: ymOf(monthStart(key)),
      partial: start > natStart || end < natEnd,
    });
  }
  return out;
}

/**
 * Reduce a positional series onto `buckets`.
 *
 * A bucket with no finite value is `null`, NEVER 0 — "no reading" and "nothing generated" are
 * different, and a zero would be drawn as a real (empty) month rather than a gap. This is the same
 * rule `bucketBars` and `sumSeries` follow.
 */
export function rollUp(
  values: readonly (number | null | undefined)[],
  buckets: readonly MonthBucket[],
  how: RollUpHow,
): (number | null)[] {
  return buckets.map((b) => {
    let acc: number | null = null;
    let n = 0;
    for (const i of b.indices) {
      const v = values[i];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      n += 1;
      if (acc === null) acc = v;
      else if (how === "min") acc = Math.min(acc, v);
      else if (how === "max") acc = Math.max(acc, v);
      else acc += v;
    }
    if (acc === null) return null;
    return how === "mean" ? acc / n : acc;
  });
}

/**
 * Days a bucket spans, for the places that need an HOUR count (the Sankey tooltip's avg-kW
 * secondary spelling). Derived from the CLAMPED span, so a partial month reports its short length.
 */
export function bucketDays(b: MonthBucket): number {
  return (b.end.getTime() - b.start.getTime()) / (24 * 60 * MS_PER_MIN);
}
