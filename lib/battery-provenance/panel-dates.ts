/**
 * Pure day-string arithmetic for the battery-provenance history panel's LOCAL (non-URL) temporal
 * state — see the doc comment on `BatteryProvenancePanel` for why it doesn't use the shared
 * URL-persisted `useTemporalRange`. Kept separate from the component so the offset math (the kind
 * of thing prone to off-by-one bugs) is directly unit-testable without rendering React.
 */
import { format } from "date-fns";
import { parseDate, type ZonedDateTime } from "@internationalized/date";
import { calendarPeriodWindow } from "@/lib/date-utils";

/** Area-local YYYY-MM-DD → a local Date at the given hour (0 = midnight). Day strings are dates,
 *  not instants, so this is plain calendar arithmetic — it never needs the area's real UTC offset. */
export function ymdToLocalDate(day: string, hour = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour);
}

/** `day`, `deltaDays` away (may be negative). */
export function addDaysToYMD(day: string, deltaDays: number): string {
  const d = ymdToLocalDate(day);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `zdt`'s calendar date as YYYY-MM-DD (no time-of-day component). */
export function zonedDateTimeToYMD(zdt: ZonedDateTime): string {
  return `${zdt.year}-${String(zdt.month).padStart(2, "0")}-${String(zdt.day).padStart(2, "0")}`;
}

/**
 * The inclusive [startDay, endDay] (area-local YMD) for the CALENDAR-aligned M/Y window `olderSteps`
 * whole periods back. `olderSteps = 0` is the live/default window ending end-of-yesterday (M = the
 * trailing calendar month, Y = the trailing calendar year). Anchored to `todayYMD` via
 * {@link calendarPeriodWindow} (multiply form) so consecutive windows stay contiguous across
 * month-ends. Unlike the old day-count `historicalWindow`, this is safe to call with `olderSteps = 0`.
 */
export function calendarHistoricalWindow(
  todayYMD: string,
  unit: "month" | "year",
  olderSteps: number,
): { startDay: string; endDay: string } {
  const { startDay, lastDay } = calendarPeriodWindow(
    parseDate(todayYMD),
    unit,
    olderSteps,
  );
  return { startDay: startDay.toString(), endDay: lastDay.toString() };
}

/**
 * `startDay – endDay` for display, e.g. "16 Aug 2025 – 14 Jul 2026". Formats the day strings
 * DIRECTLY (via their parsed Y/M/D fields) rather than converting through any instant/timezone —
 * the panel's `windowStart`/`windowEnd` are browser-local `Date` objects built by `ymdToLocalDate`,
 * so round-tripping them through an area-timezone conversion (e.g. `fromUnixTimestamp`) can land on
 * the wrong calendar day whenever the viewer's browser timezone differs from the area's.
 */
export function formatYMDRange(startDay: string, endDay: string): string {
  const fmt = "d MMM yyyy";
  return `${format(ymdToLocalDate(startDay), fmt)} – ${format(ymdToLocalDate(endDay), fmt)}`;
}
