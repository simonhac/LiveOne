/**
 * URL Date Encoding/Decoding Utilities
 *
 * Converts between ISO timestamps and URL-friendly local time formats.
 * - 1D/7D Format: YYYY-MM-DD_HH.MM (e.g., "2025-11-02_14.15")
 * - 30D Format: YYYY-MM-DD (e.g., "2025-11-07")
 */

import {
  CalendarDate,
  ZonedDateTime,
  parseDate,
  parseAbsolute,
  toZoned,
} from "@internationalized/date";

/**
 * Encode an ISO timestamp and timezone offset into a URL-friendly format
 *
 * @param isoTimestamp - ISO 8601 timestamp (e.g., "2025-11-02T14:15:00Z")
 * @param timezoneOffsetMin - Timezone offset in minutes (e.g., 600 for AEST)
 * @param dateOnly - If true, encode as date only (YYYY-MM-DD) for 30D view
 * @returns URL-friendly date string (e.g., "2025-11-02_14.15" or "2025-11-07")
 */
export function encodeUrlDate(
  isoTimestamp: string,
  timezoneOffsetMin: number,
  dateOnly = false,
): string {
  const date = new Date(isoTimestamp);

  // Apply timezone offset to get local time
  const localTime = new Date(date.getTime() + timezoneOffsetMin * 60 * 1000);

  const year = localTime.getUTCFullYear();
  const month = String(localTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localTime.getUTCDate()).padStart(2, "0");

  if (dateOnly) {
    // Format as YYYY-MM-DD (for 30D view)
    return `${year}-${month}-${day}`;
  }

  // Format as YYYY-MM-DD_HH.MM (for 1D/7D view)
  const hours = String(localTime.getUTCHours()).padStart(2, "0");
  const minutes = String(localTime.getUTCMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}_${hours}.${minutes}`;
}

/**
 * Encode epoch milliseconds and timezone offset into a URL-friendly format
 *
 * @param epochMs - Unix timestamp in milliseconds
 * @param timezoneOffsetMin - Timezone offset in minutes (e.g., 600 for AEST)
 * @param dateOnly - If true, encode as date only (YYYY-MM-DD) for 30D view
 * @returns URL-friendly date string (e.g., "2025-11-02_14.15" or "2025-11-07")
 */
export function encodeUrlDateFromEpoch(
  epochMs: number,
  timezoneOffsetMin: number,
  dateOnly = false,
): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    throw new Error(
      `Invalid epochMs: ${epochMs}. Must be a positive finite number.`,
    );
  }
  if (!Number.isFinite(timezoneOffsetMin)) {
    throw new Error(
      `Invalid timezoneOffsetMin: ${timezoneOffsetMin}. Must be a finite number.`,
    );
  }
  const date = new Date(epochMs);
  return encodeUrlDate(date.toISOString(), timezoneOffsetMin, dateOnly);
}

/**
 * Decode a URL-friendly date string back to ISO timestamp
 *
 * @param urlDate - URL-friendly date string (e.g., "2025-11-02_14.15" or "2025-11-07")
 * @param timezoneOffsetMin - Timezone offset in minutes (e.g., 600 for AEST)
 * @returns ISO 8601 timestamp string
 */
export function decodeUrlDate(
  urlDate: string,
  timezoneOffsetMin: number,
): string {
  let year: number, month: number, day: number, hours: number, minutes: number;

  // Check if it's date-only format (YYYY-MM-DD without time)
  if (/^\d{4}-\d{2}-\d{2}$/.test(urlDate)) {
    // Parse YYYY-MM-DD
    [year, month, day] = urlDate.split("-").map(Number);
    hours = 0; // Start of day
    minutes = 0;
  } else {
    // Parse YYYY-MM-DD_HH.MM
    const [datePart, timePart] = urlDate.split("_");
    [year, month, day] = datePart.split("-").map(Number);
    [hours, minutes] = timePart.split(".").map(Number);
  }

  // Create date in UTC representing the local time
  const localTime = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

  // Convert back to UTC by subtracting the timezone offset
  const utcTime = new Date(localTime.getTime() - timezoneOffsetMin * 60 * 1000);

  return utcTime.toISOString();
}

/**
 * Decode a URL-friendly date string back to epoch milliseconds
 *
 * @param urlDate - URL-friendly date string (e.g., "2025-11-02_14.15" or "2025-11-07")
 * @param timezoneOffsetMin - Timezone offset in minutes (e.g., 600 for AEST)
 * @returns Unix timestamp in milliseconds
 */
export function decodeUrlDateToEpoch(
  urlDate: string,
  timezoneOffsetMin: number,
): number {
  const isoString = decodeUrlDate(urlDate, timezoneOffsetMin);
  return new Date(isoString).getTime();
}

/**
 * Encode timezone offset for URL
 *
 * @param offsetMinutes - Offset in minutes (e.g., 600)
 * @returns URL-friendly offset string (e.g., "600m")
 */
export function encodeUrlOffset(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes)) {
    throw new Error(
      `Invalid offsetMinutes: ${offsetMinutes}. Must be a finite number.`,
    );
  }
  return `${offsetMinutes}m`;
}

/**
 * Decode timezone offset from URL
 *
 * @param urlOffset - URL offset string (e.g., "600m")
 * @returns Offset in minutes
 */
export function decodeUrlOffset(urlOffset: string): number {
  return parseInt(urlOffset.replace("m", ""), 10);
}

/**
 * Decode a URL-safe string to CalendarDate or ZonedDateTime
 *
 * @param urlDate - URL-safe date string
 * @param timezoneOffsetMin - Optional timezone offset in minutes (required for format without embedded timezone)
 * @returns CalendarDate for date-only format, ZonedDateTime for datetime formats
 * @throws Error if format is invalid or timezoneOffsetMin is missing when required
 *
 * Supported formats:
 * - "2025-11-02" → CalendarDate
 * - "2025-11-02_14.15" → ZonedDateTime (requires timezoneOffsetMin parameter)
 * - "2025-11-02_14.15T10.00" → ZonedDateTime (timezone HH.MM in string)
 * - "2025-11-02_14.15T10" → ZonedDateTime (timezone HH in string)
 */
export function decodeUrlSafeStringToI18n(
  urlDate: string,
  timezoneOffsetMin?: number,
): CalendarDate | ZonedDateTime {
  // Date-only format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(urlDate)) {
    return parseDate(urlDate);
  }

  // DateTime with embedded timezone: YYYY-MM-DD_HH.MM[T][-]HH[.MM]
  const withTzMatch = urlDate.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})T(-?\d{1,2})(?:\.(\d{2}))?$/,
  );
  if (withTzMatch) {
    const [, year, month, day, hour, minute, tzHour, tzMinute] = withTzMatch;

    // Build timezone offset string (e.g., "+10:00" or "-05:30")
    const tzMinutes = parseInt(tzMinute || "0");
    const tzHours = parseInt(tzHour);
    const isNegative = tzHours < 0;
    const absHours = Math.abs(tzHours);
    const tzOffset = `${isNegative ? "-" : "+"}${String(absHours).padStart(2, "0")}:${String(tzMinutes).padStart(2, "0")}`;

    // Parse as absolute time with the timezone offset
    const isoString = `${year}-${month}-${day}T${hour}:${minute}:00${tzOffset}`;
    const absolute = parseAbsolute(isoString, tzOffset);
    return toZoned(absolute, tzOffset);
  }

  // DateTime without embedded timezone: YYYY-MM-DD_HH.MM
  const withoutTzMatch = urlDate.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})$/,
  );
  if (withoutTzMatch) {
    if (timezoneOffsetMin === undefined) {
      throw new Error(
        `timezoneOffsetMin is required for URL date format without embedded timezone: ${urlDate}`,
      );
    }

    const [, year, month, day, hour, minute] = withoutTzMatch;

    // Convert offset in minutes to ±HH:MM format
    const isNegative = timezoneOffsetMin < 0;
    const absMinutes = Math.abs(timezoneOffsetMin);
    const tzHours = Math.floor(absMinutes / 60);
    const tzMinutes = absMinutes % 60;
    const tzOffset = `${isNegative ? "-" : "+"}${String(tzHours).padStart(2, "0")}:${String(tzMinutes).padStart(2, "0")}`;

    // Parse as absolute time with the timezone offset
    const isoString = `${year}-${month}-${day}T${hour}:${minute}:00${tzOffset}`;
    const absolute = parseAbsolute(isoString, tzOffset);
    return toZoned(absolute, tzOffset);
  }

  throw new Error(`Invalid URL date format: ${urlDate}`);
}

/**
 * Encode CalendarDate or ZonedDateTime to URL-safe string
 *
 * @param dateTime - CalendarDate or ZonedDateTime to encode
 * @param includeOffsetInString - If true, embed timezone in string; if false, return as tuple with offset (default: true)
 * @returns For CalendarDate: string (date-only format)
 *          For ZonedDateTime with includeOffsetInString=false: [string, offsetMinutes] tuple
 *          For ZonedDateTime with includeOffsetInString=true: string with embedded timezone
 *
 * Examples:
 * - CalendarDate → "2025-11-02"
 * - ZonedDateTime, includeOffsetInString=false → ["2025-11-02_14.15", 600]
 * - ZonedDateTime, includeOffsetInString=true → "2025-11-02_14.15T10.00"
 */
export function encodeI18nToUrlSafeString(
  dateTime: CalendarDate | ZonedDateTime,
  includeOffsetInString: boolean = true,
): string | [string, number] {
  // Check if it's a CalendarDate using instanceof
  if (dateTime instanceof CalendarDate) {
    // CalendarDate → date-only format
    const date = dateTime;
    const year = date.year;
    const month = String(date.month).padStart(2, "0");
    const day = String(date.day).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // ZonedDateTime → datetime format
  const zoned = dateTime as ZonedDateTime;
  const year = zoned.year;
  const month = String(zoned.month).padStart(2, "0");
  const day = String(zoned.day).padStart(2, "0");
  const hour = String(zoned.hour).padStart(2, "0");
  const minute = String(zoned.minute).padStart(2, "0");

  const dateTimePart = `${year}-${month}-${day}_${hour}.${minute}`;

  // Get timezone offset from ZonedDateTime
  const offsetMs = zoned.offset;
  const offsetMinutes = offsetMs / (1000 * 60);

  if (includeOffsetInString) {
    // Embed timezone in string as THH.MM or THH
    const isNegative = offsetMinutes < 0;
    const absMinutes = Math.abs(offsetMinutes);
    const tzHours = Math.floor(absMinutes / 60);
    const tzMinutes = absMinutes % 60;

    const sign = isNegative ? "-" : "";
    if (tzMinutes === 0) {
      // Format as THH (e.g., T10)
      return `${dateTimePart}T${sign}${tzHours}`;
    } else {
      // Format as THH.MM (e.g., T10.30)
      return `${dateTimePart}T${sign}${tzHours}.${String(tzMinutes).padStart(2, "0")}`;
    }
  } else {
    // Return tuple with offset in minutes
    return [dateTimePart, offsetMinutes];
  }
}
