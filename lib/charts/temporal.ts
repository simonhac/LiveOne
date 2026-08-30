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
import { format } from "date-fns";
import { formatTime12h, formatDateTimeRange } from "@/lib/fe-date-format";
import { parseDate } from "@internationalized/date";
import type { ZonedDateTime } from "@internationalized/date";
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
  UrlDateFormatError,
} from "@/lib/url-date";

/**
 * The four dashboard periods. Lives here rather than in a chart module because it is the *period*
 * vocabulary — the navigator, the query layer and the data processors all speak it, and only some of
 * them draw anything. (It used to live in `lib/charts/scaffold.ts`, which was Chart.js registration
 * and axis config; that file went with Chart.js in Stage 6.)
 */
export type ChartTimeRange = "D" | "W" | "M" | "Y";

/**
 * Format a hovered timestamp for the chart header, shared by both charts: date-only for M/Y,
 * date+time for W, time-only for D; `isMobile` drops the year. Returns "" for a null date.
 */
export function formatHoverTimestamp(
  date: Date | null,
  timeRange: ChartTimeRange,
  isMobile: boolean = false,
): string {
  if (!date) return "";

  // The clock time goes through the shared 12-hour spelling rather than date-fns' `h:mma`, which
  // renders an uppercase "11:58PM" — the one place in the UI that shouted its am/pm, directly above
  // an axis that now reads "12am"/"2am".
  const time = formatTime12h({
    hour: date.getHours(),
    minute: date.getMinutes(),
  });

  if (timeRange === "M" || timeRange === "Y") {
    // Mobile: "Fri, 22 Aug" / Desktop: "Fri, 22 Aug 2024"
    return format(date, isMobile ? "EEE, d MMM" : "EEE, d MMM yyyy");
  } else if (timeRange === "W") {
    // Mobile: "Fri, 22 Aug 11:58pm" / Desktop: "Fri, 22 Aug 2024 11:58pm"
    return `${format(date, isMobile ? "EEE, d MMM" : "EEE, d MMM yyyy")} ${time}`;
  } else {
    // For D view, show time only (e.g., "11:58pm")
    return time;
  }
}

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
  /**
   * URL params that were unreadable and have been ignored — a mangled share link, a hand-edited date,
   * a `?start=…_14:15` where the format wants `_14.15`. Purely informational: the range above is
   * already valid without them (it is exactly the range a param-free URL would give).
   * `useTemporalRange` turns this into a toast and strips the offending params from the address bar,
   * so the URL — this module's single source of truth — keeps matching what is actually on screen.
   */
  droppedParams?: DroppedParam[];
}

/** One URL param that was ignored, kept verbatim so the toast can quote what the user pasted. */
export interface DroppedParam {
  param: "start" | "end" | "offset";
  value: string;
}

/**
 * Decode one URL param, or record it as dropped and return undefined.
 *
 * Catches ONLY {@link UrlDateFormatError} — i.e. bad input, which the caller recovers from by falling
 * back to the default window. Anything else (a non-finite `timezoneOffsetMin` from area config, say)
 * is a fault on our side and keeps propagating to the error boundary, where it stays visible instead
 * of being silently rewritten into "the last 24 hours".
 */
function readParam<T>(
  param: DroppedParam["param"],
  raw: string,
  decode: (raw: string) => T,
  dropped: DroppedParam[],
): T | undefined {
  try {
    return decode(raw);
  } catch (err) {
    if (err instanceof UrlDateFormatError) {
      dropped.push({ param, value: raw });
      return undefined;
    }
    throw err;
  }
}

/** Minimal read interface satisfied by both URLSearchParams and Next's ReadonlyURLSearchParams. */
type ReadonlyParamsLike = { get(name: string): string | null };
/** Minimal interface for cloning current params (both URLSearchParams and ReadonlyURLSearchParams). */
type StringableParams = { toString(): string };

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Decode M/Y's date-only `?end` param, raising the same {@link UrlDateFormatError} the D/W decoders
 * raise so that {@link readParam} can treat every malformed param identically. `parseDate` throws its
 * own untyped Error for an impossible date (2026-02-31), which we normalise here.
 */
function decodeDateOnlyParam(raw: string) {
  if (!DATE_ONLY_RE.test(raw)) throw new UrlDateFormatError(raw);
  try {
    return parseDate(raw);
  } catch {
    throw new UrlDateFormatError(raw);
  }
}

/**
 * Period window length in milliseconds — a FIXED nominal duration (M=30d, Y=365d), NOT a calendar
 * length. Used only for the D/W live-label/window fallbacks and the `runs` card's `Nd` string; the
 * navigator never uses it to build an M/Y window (M/Y always carry an explicit calendar window).
 */
export function getPeriodDuration(period: ChartTimeRange): number {
  if (period === "D") return 24 * 60 * 60 * 1000;
  if (period === "W") return 7 * 24 * 60 * 60 * 1000;
  if (period === "Y") return 365 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000; // M
}

/**
 * The period spelled out for a card heading — the same nominal durations {@link getPeriodDuration}
 * uses, in words ("over the last …").
 */
export const PERIOD_LABEL: Record<NavigatorPeriod, string> = {
  D: "24 hours",
  W: "7 days",
  M: "30 days",
  Y: "12 months",
};

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

/** True when a zoned instant sits exactly on local midnight. */
function isLocalMidnight(zdt: ZonedDateTime): boolean {
  return (
    zdt.hour === 0 &&
    zdt.minute === 0 &&
    zdt.second === 0 &&
    zdt.millisecond === 0
  );
}

/**
 * The navigator's range label for a window.
 *
 * D/W windows carry an EXCLUSIVE end, so a window running local-midnight -> local-midnight covers a
 * whole number of calendar days: collapse it to the date-only INCLUSIVE spelling ("24 Aug 2026",
 * "18 – 24 Aug 2026") instead of printing the bookend times ("12am, 24 Aug – 12am, 25 Aug 2026").
 * A live trailing D/W window ends at `now`, so it is untouched and still shows its times.
 *
 * M/Y are never adjusted: their window is ALREADY an inclusive `[firstDay, lastDay]`
 * (see {@link decodeRangeFromParams}), so "22 Jun – 21 Jul 2026" is right as it stands.
 *
 * Lives here rather than in `formatDateTimeRange` because that formatter is generic and its other
 * callers (ViewDataModal's row cursors, SiteChartsCard's first/last bucket) pass INCLUSIVE ends —
 * the exclusive-end rule is the navigator's, not the formatter's.
 */
export function formatWindowLabel(
  start: ZonedDateTime,
  end: ZonedDateTime,
  period: ChartTimeRange,
  opts: { includeTime: boolean },
): string {
  if (
    !isDateOnlyPeriod(period) &&
    isLocalMidnight(start) &&
    isLocalMidnight(end)
  ) {
    return formatDateTimeRange(start, end.subtract({ days: 1 }), false);
  }
  return formatDateTimeRange(start, end, opts.includeTime);
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

  // Every param that failed to decode. Non-empty ⇒ the range below is the DEFAULT one and the caller
  // should strip these from the URL (see `useTemporalRange`).
  const dropped: DroppedParam[] = [];
  const withDropped = (range: TemporalRange): TemporalRange =>
    dropped.length ? { ...range, droppedParams: dropped } : range;

  if (isDateOnlyPeriod(period)) {
    const endEncoded = params.get("end");
    // An unreadable `?end` used to be ignored in silence, which left the URL claiming one month while
    // the page showed another. Now it is dropped loudly.
    const lastDay = endEncoded
      ? readParam("end", endEncoded, decodeDateOnlyParam, dropped)
      : undefined;
    const resolvedLastDay =
      lastDay ?? getTodayInTimezone(timezoneOffsetMin).subtract({ days: 1 });
    const firstDay = resolvedLastDay
      .add({ days: 1 })
      .subtract(periodStep(period));
    return withDropped({
      period,
      start: utcMidnightISO(firstDay),
      end: utcMidnightISO(resolvedLastDay),
      isHistoricalMode: true,
      isLatest: !lastDay,
    });
  }

  // D / W
  const startEncoded = params.get("start");
  const endEncoded = params.get("end");
  if (!startEncoded && !endEncoded) {
    return { period, isHistoricalMode: false, isLatest: true };
  }

  // A bad `?offset` costs you the offset, never the date: fall back to the area's own timezone,
  // exactly as the offset-absent path does.
  const offsetEncoded = params.get("offset");
  const offsetMin =
    (offsetEncoded
      ? readParam("offset", offsetEncoded, decodeUrlOffset, dropped)
      : undefined) ?? timezoneOffsetMin;

  const periodDuration = getPeriodDuration(period);
  const anchorParam = startEncoded ? "start" : "end";
  const anchorRaw = (startEncoded ?? endEncoded) as string;
  const anchor = readParam(
    anchorParam,
    anchorRaw,
    (v) => decodeUrlDate(v, offsetMin),
    dropped,
  );

  if (anchor === undefined) {
    // Unreadable window ⇒ the live trailing window: byte-identical to what a param-free URL returns
    // above, so every consumer already handles this shape. A lone `?offset` means nothing without it.
    if (offsetEncoded && !dropped.some((d) => d.param === "offset")) {
      dropped.push({ param: "offset", value: offsetEncoded });
    }
    return withDropped({ period, isHistoricalMode: false, isLatest: true });
  }

  const anchorMs = new Date(anchor).getTime();
  const start =
    anchorParam === "start"
      ? anchor
      : new Date(anchorMs - periodDuration).toISOString();
  const end =
    anchorParam === "start"
      ? new Date(anchorMs + periodDuration).toISOString()
      : anchor;

  return withDropped({
    period,
    start,
    end,
    isHistoricalMode: true,
    isLatest: false,
  });
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
