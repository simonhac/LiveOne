/**
 * Pure aggregation math for point readings — the single source of truth for how a
 * 5-minute (and daily) aggregate is derived from its inputs.
 *
 * This module has NO database imports. Both the Turso writers
 * (`updatePointAggregates5m`, `aggregateDailyPointData`) and the Postgres recompute
 * (`lib/db/planetscale/aggregate-points-pg.ts`, behind `AGG_COMPUTE_IN_PG`) call these
 * helpers so the two engines compute identical values by construction — which is what
 * `scripts/reconcile-agg-values.ts` must prove before the Turso aggregation publishers
 * are trimmed (PR-13).
 *
 * The semantics intentionally mirror the original inline logic exactly:
 *  - 5m value placement by metric type / transform (avg/min/max/last/delta), and
 *  - 1d roll-up of 5m rows (mean of avgs, min of mins, max of maxs, sum of deltas, last
 *    taken from the previous day's 00:00 interval).
 */

import { CalendarDate } from "@internationalized/date";

/** The 5m interval length, in milliseconds. The interval is (start, end] (exclusive
 * start, inclusive end), with `intervalEnd = ceil(measurementMs / FIVE_MIN_MS) * FIVE_MIN_MS`. */
export const FIVE_MIN_MS = 5 * 60 * 1000;

/** The aggregate tuple shared by the 5m and 1d tables (the value columns we reconcile). */
export interface AggregateValues {
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  delta: number | null;
  sampleCount: number;
  errorCount: number;
}

/** Inputs for computing one point's 5m aggregate from its raw readings in the interval. */
export interface Point5mInput {
  /** Non-null reading values within the interval, in measurement-time order (ascending). */
  values: number[];
  /** Count of readings in the interval whose value was null (errors). */
  errorCount: number;
  /** point_info.transform — 'd' = differentiate (delta = last − previousLast). */
  transform: string | null;
  /** point_info.metric_type — 'energy' sums values into delta (when not transform='d'). */
  metricType: string | null;
  /**
   * The previous interval's `last` value, for transform='d' points only. Undefined when
   * there is no previous value (first interval / gap), in which case delta stays null —
   * exactly as the Turso path leaves it.
   */
  previousLast?: number;
}

/**
 * Compute one point's 5-minute aggregate.
 *
 * Faithful port of the per-point logic in `updatePointAggregates5m`
 * (`lib/point-aggregation-helper.ts`):
 *  - 0 valid readings → all values null (sampleCount 0, errorCount preserved).
 *  - transform='d' → avg/min/max null; last = last reading; delta = last − previousLast
 *    (null if no previousLast).
 *  - otherwise → avg/min/max over the values, last = last reading; for metricType='energy'
 *    delta = Σ values, else delta null.
 */
export function aggregate5mForPoint(input: Point5mInput): AggregateValues {
  const { values, errorCount, transform, metricType, previousLast } = input;
  const sampleCount = values.length;

  if (sampleCount === 0) {
    return {
      avg: null,
      min: null,
      max: null,
      last: null,
      delta: null,
      sampleCount: 0,
      errorCount,
    };
  }

  const last = values[values.length - 1];

  if (transform === "d") {
    // Differentiated: delta = last − previous interval's last. avg/min/max are not
    // meaningful for a counter, so they are null (but `last` is still recorded).
    const delta = previousLast !== undefined ? last - previousLast : null;
    return {
      avg: null,
      min: null,
      max: null,
      last,
      delta,
      sampleCount,
      errorCount,
    };
  }

  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Energy (interval/non-counter) sums its readings into delta; everything else null.
  const delta =
    metricType === "energy" ? values.reduce((sum, v) => sum + v, 0) : null;

  return { avg, min, max, last, delta, sampleCount, errorCount };
}

/** One 5m row's contribution to a daily aggregate. */
export interface FiveMinRow {
  avg: number | null;
  min: number | null;
  max: number | null;
  delta: number | null;
  sampleCount: number;
  errorCount: number;
}

/** Inputs for rolling a point's 5m rows (one day) into its daily aggregate. */
export interface Point1dInput {
  /** The point's 5m rows for the day (intervalEnd in [00:05 .. 00:00-next-day]). */
  rows: FiveMinRow[];
  /**
   * The point's `last` from the previous day's 00:00 interval (the last 5m interval of
   * the prior day), or null when absent. Carried through verbatim to the daily `last`.
   */
  last: number | null;
}

/**
 * Compute one point's daily aggregate from its 5m rows.
 *
 * Faithful port of the per-point logic in `aggregateDailyPointData`
 * (`lib/db/turso/aggregate-daily-points.ts`):
 *  - avg = mean of the non-null 5m avgs (null if none),
 *  - min = min of the non-null 5m mins, max = max of the non-null 5m maxs,
 *  - delta = Σ of the non-null 5m deltas (null if none),
 *  - last = the previous-day 00:00 interval's value (passed in),
 *  - sampleCount / errorCount = Σ across the rows.
 */
export function aggregate1dForPoint(input: Point1dInput): AggregateValues {
  const { rows, last } = input;

  const avgValues = rows
    .map((r) => r.avg)
    .filter((v): v is number => v !== null);
  const minValues = rows
    .map((r) => r.min)
    .filter((v): v is number => v !== null);
  const maxValues = rows
    .map((r) => r.max)
    .filter((v): v is number => v !== null);
  const deltaValues = rows
    .map((r) => r.delta)
    .filter((v): v is number => v !== null);

  const avg =
    avgValues.length > 0
      ? avgValues.reduce((sum, v) => sum + v, 0) / avgValues.length
      : null;
  const min = minValues.length > 0 ? Math.min(...minValues) : null;
  const max = maxValues.length > 0 ? Math.max(...maxValues) : null;
  const delta =
    deltaValues.length > 0 ? deltaValues.reduce((sum, v) => sum + v, 0) : null;

  const sampleCount = rows.reduce((sum, r) => sum + (r.sampleCount || 0), 0);
  const errorCount = rows.reduce((sum, r) => sum + (r.errorCount || 0), 0);

  return { avg, min, max, last, delta, sampleCount, errorCount };
}

/**
 * The 5m interval end (ms) that a measurement timestamp (ms) belongs to.
 * Interval is (end−5min, end]: a reading exactly on a boundary belongs to that boundary.
 */
export function intervalEndForMs(measurementTimeMs: number): number {
  return Math.ceil(measurementTimeMs / FIVE_MIN_MS) * FIVE_MIN_MS;
}

/**
 * Convert a CalendarDate to the Unix timestamp range (seconds, UTC) that a daily
 * aggregate covers, in the system's local timezone: 00:05 of the given day to 00:00 of
 * the next day, inclusive — i.e. the 288 five-minute intervals (00:05, 00:10, …, 23:55,
 * 00:00). Shared by the Turso daily aggregation and the Postgres recompute so both use an
 * identical day boundary (and therefore identical 1d business keys).
 *
 * @returns [startUnixSec, endUnixSec]
 */
export function dayToUnixRangeForAggregation(
  day: CalendarDate,
  timezoneOffsetMin: number,
): [number, number] {
  // Build the ±HH:MM offset. Compute hours/mins from the ABSOLUTE minutes so negative
  // fractional offsets (e.g. -330 → -05:30) are correct — `Math.floor(-330/60)` would
  // round toward -∞ to -6 and yield -06:30. (No such offset is in use today, but the math
  // is shared with the Turso path, so it must be right for any tz.)
  const sign = timezoneOffsetMin >= 0 ? "+" : "-";
  const absMinutes = Math.abs(timezoneOffsetMin);
  const offsetHours = Math.floor(absMinutes / 60);
  const offsetMins = absMinutes % 60;
  const offsetString = `${sign}${String(offsetHours).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;

  // Format day as YYYY-MM-DD
  const dayStr = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;

  // Start at 00:05 of the given day
  const dayStart = new Date(`${dayStr}T00:05:00${offsetString}`);
  // End at 00:00 of the next day (inclusive)
  const nextDay = new Date(`${dayStr}T00:00:00${offsetString}`);
  nextDay.setDate(nextDay.getDate() + 1);
  const dayEnd = nextDay;

  return [
    Math.floor(dayStart.getTime() / 1000),
    Math.floor(dayEnd.getTime() / 1000),
  ];
}
