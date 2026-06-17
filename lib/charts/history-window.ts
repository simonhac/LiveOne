import { parseAbsolute, parseDate, toZoned } from "@internationalized/date";
import { encodeI18nToUrlSafeString } from "@/lib/url-date";

/**
 * Encode an absolute ISO window `[startIso, endIso]` into the URL-safe `startTime`/`endTime` strings
 * that `/api/history` expects, matching the interval's encoding rules:
 *   - "1d"   → date-only CalendarDate ("YYYY-MM-DD"), tz-naive
 *   - 5m/30m → ZonedDateTime with an embedded UTC offset
 *
 * This is the SINGLE encoder — both `lib/site-data-processor.ts` (area/sankey) and `LinesChartCard`
 * (line chart) call it, so their historical requests encode identically (the server's window-alignment
 * validation and the React Query `rangeKey` both depend on the exact encoded string).
 */
export function encodeHistoryWindow(
  startIso: string,
  endIso: string,
  interval: string,
): { startTime: string; endTime: string } {
  if (interval === "1d") {
    // Daily intervals: date-only format (CalendarDate).
    const startDate = parseDate(startIso.split("T")[0]);
    const endDate = parseDate(endIso.split("T")[0]);
    return {
      startTime: encodeI18nToUrlSafeString(startDate) as string,
      endTime: encodeI18nToUrlSafeString(endDate) as string,
    };
  }
  // Sub-daily intervals: ZonedDateTime in UTC with the offset embedded in the string.
  const startZoned = parseAbsolute(startIso, "UTC");
  const endZoned = parseAbsolute(endIso, "UTC");
  return {
    startTime: encodeI18nToUrlSafeString(
      toZoned(startZoned, "UTC"),
      true,
    ) as string,
    endTime: encodeI18nToUrlSafeString(
      toZoned(endZoned, "UTC"),
      true,
    ) as string,
  };
}
