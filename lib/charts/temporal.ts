/**
 * Temporal-range algebra for the dashboard charts — the period + time-window logic that drives the
 * shared temporal navigator (date-range label + prev/next + D/W/M/Y). Pure, no React.
 *
 * The single source of truth for the navigator's state is the URL query params (`?period`, `?start`,
 * `?end`, `?offset`); these helpers decode that into a {@link TemporalRange}, compute the next window
 * for prev/next navigation, and re-encode a window back into URL params. Previously this lived inline
 * in SiteChartsCard; it's extracted here so the line chart, the area/sankey chart, and the navigator
 * component all share ONE implementation.
 *
 * Periods:
 *  - D/W — live trailing 24h / 7d (sub-daily), ending at NOW (today's partial day included). The
 *    first "older" click snaps the window END to local midnight of today.
 *  - M/Y — trailing CALENDAR month / year ending end-of-yesterday (daily data), so they NEVER include
 *    today's partial day. They are date-only and ALWAYS carry an explicit window (see below).
 */
import type { ChartTimeRange } from "@/lib/charts/scaffold";
import { parseDate } from "@internationalized/date";
import {
  getTodayInTimezone,
  periodStep,
  endDateFromIso,
  periodWindowEndingAt,
  utcMidnightISO,
  utcDateFromIso,
} from "@/lib/date-utils";
import {
  encodeUrlDate,
  decodeUrlDate,
  encodeUrlOffset,
  decodeUrlOffset,
} from "@/lib/url-date";

/** The navigator's period set. Identical to {@link ChartTimeRange} — every period is URL-shared now. */
export type NavigatorPeriod = "D" | "W" | "M" | "Y";

export interface TemporalRange {
  period: NavigatorPeriod;
  /** ISO start of the requested historical window; absent ⇒ live trailing window (D/W only). */
  start?: string;
  /** ISO end (exclusive) of the requested historical window; absent ⇒ live trailing window (D/W only). */
  end?: string;
  /**
   * True when an explicit window is set (vs the live trailing window). ALWAYS true for M/Y (they carry
   * a calendar window even at latest) — drives the consumers' "explicit window vs `last=`" fetch choice.
   */
  isHistoricalMode: boolean;
  /**
   * True when showing the newest window for this period (a param-free URL). Drives the newer button /
   * ArrowRight disable — NOT `isHistoricalMode`, since M/Y are always historical yet can be at latest.
   */
  isLatest: boolean;
}

/** Minimal read interface satisfied by both URLSearchParams and Next's ReadonlyURLSearchParams. */
type ReadonlyParamsLike = { get(name: string): string | null };
/** Minimal interface for cloning current params (both URLSearchParams and ReadonlyURLSearchParams). */
type StringableParams = { toString(): string };

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Period window length in milliseconds — a FIXED nominal duration (M=30d, Y=365d), NOT a calendar
 * length. Used only for the D/W live-label/window fallbacks and the generator-runs `Nd` string; the
 * navigator never uses it to build an M/Y window (M/Y always carry an explicit calendar window).
 */
export function getPeriodDuration(period: ChartTimeRange): number {
  if (period === "D") return 24 * 60 * 60 * 1000;
  if (period === "W") return 7 * 24 * 60 * 60 * 1000;
  if (period === "Y") return 365 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000; // M
}

/** Data interval (minutes) for a period: 5m for D, 30m for W, 1d for M/Y. */
export function getPeriodIntervalMinutes(period: ChartTimeRange): number {
  if (period === "D") return 5;
  if (period === "W") return 30;
  return 24 * 60; // M / Y
}

/** M and Y are day-based (date-only) periods: their URL window omits the time-of-day and the offset. */
export function isDateOnlyPeriod(period: ChartTimeRange): boolean {
  return period === "M" || period === "Y";
}

/**
 * Decode the navigator state from URL params. `period` defaults to "D" when absent/unknown.
 *
 * - M/Y (date-only): ALWAYS windowed as an INCLUSIVE `[firstDay, lastDay]` in the area-local calendar,
 *   both represented as tz-naive UTC-midnight instants (so the `1d` history encoder's `split("T")[0]`
 *   recovers the intended calendar date). `?end` (a `YYYY-MM-DD`) is the inclusive last day; absent ⇒
 *   the latest window whose last day is yesterday (today's partial day excluded).
 * - D/W: `?start` (+`?offset`) marks a historical window; param-free ⇒ live trailing window.
 */
export function decodeRangeFromParams(
  params: ReadonlyParamsLike,
  timezoneOffsetMin: number,
): TemporalRange {
  const periodParam = params.get("period");
  const period: NavigatorPeriod =
    periodParam === "D" ||
    periodParam === "W" ||
    periodParam === "M" ||
    periodParam === "Y"
      ? periodParam
      : "D";

  if (isDateOnlyPeriod(period)) {
    const endEncoded = params.get("end");
    const hasEnd = !!endEncoded && DATE_ONLY_RE.test(endEncoded);
    const lastDay = hasEnd
      ? parseDate(endEncoded as string)
      : getTodayInTimezone(timezoneOffsetMin).subtract({ days: 1 });
    const firstDay = lastDay.add({ days: 1 }).subtract(periodStep(period));
    return {
      period,
      start: utcMidnightISO(firstDay),
      end: utcMidnightISO(lastDay),
      isHistoricalMode: true,
      isLatest: !hasEnd,
    };
  }

  // D / W
  const startEncoded = params.get("start");
  const endEncoded = params.get("end");
  if (!startEncoded && !endEncoded) {
    return { period, isHistoricalMode: false, isLatest: true };
  }

  const offsetEncoded = params.get("offset");
  const offsetMin = offsetEncoded
    ? decodeUrlOffset(offsetEncoded)
    : timezoneOffsetMin;
  const periodDuration = getPeriodDuration(period);
  let start: string | undefined;
  let end: string | undefined;

  if (startEncoded) {
    start = decodeUrlDate(startEncoded, offsetMin);
    end = new Date(new Date(start).getTime() + periodDuration).toISOString();
  } else if (endEncoded) {
    end = decodeUrlDate(endEncoded, offsetMin);
    start = new Date(new Date(end).getTime() - periodDuration).toISOString();
  }

  return { period, start, end, isHistoricalMode: true, isLatest: false };
}

/**
 * Compute the next-older window (prev / ArrowLeft): step back one whole period, snapping to local-day
 * boundaries. From a live D/W window (no explicit end) the new window ENDS at local midnight today —
 * so the first "older" click shows the full previous day(s), not a `now`-offset window. Returns an ISO
 * window. Consecutive windows are contiguous (each ends where the previous began).
 */
export function computeOlder(
  range: TemporalRange,
  timezoneOffsetMin: number,
): { start: string; end: string } {
  const step = periodStep(range.period);

  if (isDateOnlyPeriod(range.period)) {
    // M/Y always carry an inclusive [firstDay, lastDay]. Step back one whole period: the new window's
    // last day is the day before the current first day (contiguous), and its first day is one step back.
    const firstDay = utcDateFromIso(range.start as string);
    return {
      start: utcMidnightISO(firstDay.subtract(step)),
      end: utcMidnightISO(firstDay.subtract({ days: 1 })),
    };
  }

  // D/W: snap the window END to local midnight. From live (no explicit end) the new window ENDS at
  // local midnight today (the full previous day(s)); otherwise step the end back one whole period.
  const today = getTodayInTimezone(timezoneOffsetMin);
  const newEndDate = range.end
    ? endDateFromIso(range.end, timezoneOffsetMin).subtract(step)
    : today;
  return periodWindowEndingAt(range.period, newEndDate, timezoneOffsetMin);
}

/**
 * Compute the next-newer window (next / ArrowRight): step forward one whole period. Returns "live" when
 * stepping forward reaches the latest window (revert to the live / default window), or null when there
 * is nothing to step forward from (D/W live mode — next is a no-op).
 */
export function computeNewer(
  range: TemporalRange,
  timezoneOffsetMin: number,
): { start: string; end: string } | "live" | null {
  if (!range.end) return null; // D/W live: no-op
  const today = getTodayInTimezone(timezoneOffsetMin);
  const step = periodStep(range.period);

  if (isDateOnlyPeriod(range.period)) {
    // Step the inclusive last day forward one whole period; once it reaches yesterday (the latest
    // window's last day) revert to the default/live state.
    const lastDay = utcDateFromIso(range.end);
    const newLastDay = lastDay.add(step);
    if (newLastDay.compare(today.subtract({ days: 1 })) >= 0) return "live";
    return {
      start: utcMidnightISO(newLastDay.add({ days: 1 }).subtract(step)),
      end: utcMidnightISO(newLastDay),
    };
  }

  // D/W: the newest historical window ends AT today (the partial live window is one interval beyond).
  const endDate = endDateFromIso(range.end, timezoneOffsetMin);
  if (endDate.compare(today) >= 0) return "live";
  return periodWindowEndingAt(
    range.period,
    endDate.add(step),
    timezoneOffsetMin,
  );
}

/**
 * Re-encode a target window (or "live") into URL params, preserving any unrelated params. Always sets
 * `period`. "live" drops `start`/`end`/`offset` (the param-free latest state). A window for M/Y stores
 * the inclusive-LAST day (`?end`, date-only) and drops `start`/`offset`; a window for D/W stores `start`
 * (+`offset`) and drops `end`.
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

  if (isDateOnlyPeriod(opts.period)) {
    // target.end is UTC-midnight of the inclusive last day → store that day, date-only.
    params.set("end", utcDateFromIso(target.end).toString());
    params.delete("start");
    params.delete("offset");
  } else {
    params.set(
      "start",
      encodeUrlDate(target.start, opts.timezoneOffsetMin, false),
    );
    params.delete("end");
    params.set("offset", encodeUrlOffset(opts.timezoneOffsetMin));
  }
  return params;
}
