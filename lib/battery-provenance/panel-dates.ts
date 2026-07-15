/**
 * Pure day-string arithmetic for the battery-provenance history panel's LOCAL (non-URL) temporal
 * state — see the doc comment on `BatteryProvenancePanel` for why it doesn't use the shared
 * URL-persisted `useTemporalRange`. Kept separate from the component so the offset math (the kind
 * of thing prone to off-by-one bugs) is directly unit-testable without rendering React.
 */
import { format } from "date-fns";
import type { ZonedDateTime } from "@internationalized/date";

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
 * The explicit [start, end] day range for the `olderSteps`-th whole period back from the live
 * window (live = the trailing `dayCount` days ending yesterday). `olderSteps` must be ≥ 1 — the
 * live window itself is expressed by omitting start/end entirely, not by calling this with 0.
 * olderSteps=1 ends the day BEFORE the live window starts (non-overlapping, no gap between steps).
 */
export function historicalWindow(
  todayYMD: string,
  dayCount: number,
  olderSteps: number,
): { startDay: string; endDay: string } {
  const endDay = addDaysToYMD(todayYMD, -1 - olderSteps * dayCount);
  const startDay = addDaysToYMD(endDay, -(dayCount - 1));
  return { startDay, endDay };
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
