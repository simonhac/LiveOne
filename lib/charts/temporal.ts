/**
 * Temporal-range algebra for the dashboard charts — the period + time-window logic that drives the
 * shared temporal navigator (date-range label + prev/next + 1D/7D/30D). Pure, no React.
 *
 * The single source of truth for the navigator's state is the URL query params (`?period`, `?start`,
 * `?end`, `?offset`); these helpers decode that into a {@link TemporalRange}, compute the next window
 * for prev/next navigation, and re-encode a window back into URL params. Previously this lived inline
 * in SiteChartsCard; it's extracted here so the line chart, the area/sankey chart, and the navigator
 * component all share ONE implementation.
 */
import type { ChartTimeRange } from "@/lib/charts/scaffold";
import {
  encodeUrlDate,
  decodeUrlDate,
  encodeUrlOffset,
  decodeUrlOffset,
} from "@/lib/url-date";

export interface TemporalRange {
  period: ChartTimeRange;
  /** ISO start of the requested historical window; absent ⇒ live trailing window. */
  start?: string;
  /** ISO end of the requested historical window; absent ⇒ live trailing window. */
  end?: string;
  /** True when an explicit historical window is set (vs the live trailing window). */
  isHistoricalMode: boolean;
}

/** Minimal read interface satisfied by both URLSearchParams and Next's ReadonlyURLSearchParams. */
type ReadonlyParamsLike = { get(name: string): string | null };
/** Minimal interface for cloning current params (both URLSearchParams and ReadonlyURLSearchParams). */
type StringableParams = { toString(): string };

/** Period window length in milliseconds. */
export function getPeriodDuration(period: ChartTimeRange): number {
  if (period === "1D") return 24 * 60 * 60 * 1000;
  if (period === "7D") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

/** Data interval (minutes) for a period: 5m for 1D, 30m for 7D, 1d for 30D. */
export function getPeriodIntervalMinutes(period: ChartTimeRange): number {
  if (period === "1D") return 5;
  if (period === "7D") return 30;
  return 24 * 60;
}

/** 30D is a day-based (date-only) period: its URL window omits the time-of-day and the offset. */
export function isDateOnlyPeriod(period: ChartTimeRange): boolean {
  return period === "30D";
}

/**
 * Decode the navigator state from URL params. `period` defaults to "1D" when absent. The historical
 * window is filled from `start`/`end` (one implies the other via the period duration); for non-day
 * periods a stored `offset` is required to decode the local times — without it we fall back to live.
 */
export function decodeRangeFromParams(
  params: ReadonlyParamsLike,
): TemporalRange {
  const periodParam = params.get("period");
  const period: ChartTimeRange =
    periodParam === "1D" || periodParam === "7D" || periodParam === "30D"
      ? periodParam
      : "1D";

  const startEncoded = params.get("start");
  const endEncoded = params.get("end");
  const offsetEncoded = params.get("offset");

  // For 30D (day-based), offset is 0 (no timezone conversion). For other periods it's required.
  const offsetMin =
    period === "30D"
      ? 0
      : offsetEncoded
        ? decodeUrlOffset(offsetEncoded)
        : null;

  if (offsetMin === null) {
    return { period, isHistoricalMode: false };
  }

  const periodDuration = getPeriodDuration(period);
  let start: string | undefined;
  let end: string | undefined;

  if (startEncoded && endEncoded) {
    start = decodeUrlDate(startEncoded, offsetMin);
    const decodedEnd = decodeUrlDate(endEncoded, offsetMin);
    // Validate start + period == end; if not, trust start + period.
    const expectedEnd = new Date(new Date(start).getTime() + periodDuration);
    end =
      expectedEnd.getTime() !== new Date(decodedEnd).getTime()
        ? expectedEnd.toISOString()
        : decodedEnd;
  } else if (startEncoded) {
    start = decodeUrlDate(startEncoded, offsetMin);
    end = new Date(new Date(start).getTime() + periodDuration).toISOString();
  } else if (endEncoded) {
    end = decodeUrlDate(endEncoded, offsetMin);
    start = new Date(new Date(end).getTime() - periodDuration).toISOString();
  }

  return { period, start, end, isHistoricalMode: !!(start || end) };
}

/**
 * Compute the next-older window (prev / ArrowLeft): step back one whole period. From live mode this
 * steps back from `now` rounded down to the interval boundary. Returns an ISO window.
 */
export function computeOlder(range: TemporalRange): {
  start: string;
  end: string;
} {
  let currentStart: Date;
  let currentEnd: Date;

  if (range.isHistoricalMode && range.start && range.end) {
    currentStart = new Date(range.start);
    currentEnd = new Date(range.end);
  } else {
    // Live mode: go back one period from now, rounded down to the interval boundary.
    const intervalMinutes = getPeriodIntervalMinutes(range.period);
    const now = new Date();
    const roundedNow = new Date(now);
    const roundedMinutes =
      Math.floor(now.getMinutes() / intervalMinutes) * intervalMinutes;
    roundedNow.setMinutes(roundedMinutes, 0, 0);
    currentEnd = roundedNow;
    currentStart = new Date(
      roundedNow.getTime() - getPeriodDuration(range.period),
    );
  }

  const duration = currentEnd.getTime() - currentStart.getTime();
  const newEnd = new Date(currentStart.getTime());
  const newStart = new Date(currentStart.getTime() - duration);
  return { start: newStart.toISOString(), end: newEnd.toISOString() };
}

/**
 * Compute the next-newer window (next / ArrowRight): step forward one whole period. Returns "live"
 * when stepping forward lands within one interval of now (revert to the live trailing window), or
 * null when not in historical mode (next is a no-op in live mode).
 */
export function computeNewer(
  range: TemporalRange,
): { start: string; end: string } | "live" | null {
  if (!(range.start && range.end)) return null;

  const currentStart = new Date(range.start);
  const currentEnd = new Date(range.end);
  const duration = currentEnd.getTime() - currentStart.getTime();
  const newStart = new Date(currentEnd.getTime());
  const newEnd = new Date(currentEnd.getTime() + duration);

  const now = new Date();
  const intervalMs = getPeriodIntervalMinutes(range.period) * 60 * 1000;
  if (newEnd.getTime() > now.getTime() - intervalMs) {
    return "live";
  }
  return { start: newStart.toISOString(), end: newEnd.toISOString() };
}

/**
 * Re-encode a target window (or "live") into URL params, preserving any unrelated params. Always sets
 * `period`. A window sets `start` (date-only for 30D, else with `offset`) and drops `end` (redundant
 * with start + period). "live" drops `start`/`end`/`offset`.
 */
export function encodeRangeToParams(
  current: StringableParams,
  target: { start: string; end: string } | "live",
  opts: { period: ChartTimeRange; timezoneOffsetMin: number },
): URLSearchParams {
  const params = new URLSearchParams(current.toString());
  params.set("period", opts.period);

  if (target === "live") {
    params.delete("start");
    params.delete("end");
    params.delete("offset");
    return params;
  }

  const isDateOnly = isDateOnlyPeriod(opts.period);
  params.set(
    "start",
    encodeUrlDate(target.start, opts.timezoneOffsetMin, isDateOnly),
  );
  params.delete("end");
  if (isDateOnly) {
    params.delete("offset");
  } else {
    params.set("offset", encodeUrlOffset(opts.timezoneOffsetMin));
  }
  return params;
}
