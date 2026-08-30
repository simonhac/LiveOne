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
 * The canonical URL grammars — the single source of truth for what {@link decodeUrlDate} and
 * {@link decodeUrlOffset} will accept, and exactly what {@link encodeUrlDate} /
 * {@link encodeUrlOffset} emit.
 */
const CANONICAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})$/;
const CANONICAL_OFFSET_RE = /^(-?\d{1,4})m$/;

/** Largest sane timezone offset in minutes (UTC+14 .. UTC-12, with room for half-hour zones). */
const MAX_OFFSET_MIN = 14 * 60;

/**
 * A URL param that isn't in the canonical grammar — i.e. bad INPUT, not a bug in our code.
 *
 * Typed so that `decodeRangeFromParams` can degrade gracefully on this and ONLY this: a malformed
 * `?start=` is a user handing us a mangled link (drop the param, show the default window), whereas
 * any other throw is a fault on our side and must keep propagating to the error boundary.
 */
export class UrlDateFormatError extends Error {
  readonly value: string;

  constructor(value: string, what = "URL date") {
    super(`Invalid ${what} format: ${value}`);
    this.name = "UrlDateFormatError";
    this.value = value;
  }
}

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
 * Strict: the string must match the canonical grammar exactly AND name a real instant. Near misses
 * are NOT repaired — `"2025-11-02_14:15"` (colon) and `"2025-11-02T14.15"` both throw rather than
 * being coerced, because guessing at the intent risks silently showing the WRONG window. Note this
 * also catches inputs that used to parse into nonsense: `"2025-11-2_9.5"` previously coerced to hour
 * 9.5, and `"garbage"` produced an Invalid Date whose `.toISOString()` threw a bare RangeError.
 *
 * @param urlDate - URL-friendly date string (e.g., "2025-11-02_14.15" or "2025-11-07")
 * @param timezoneOffsetMin - Timezone offset in minutes (e.g., 600 for AEST)
 * @returns ISO 8601 timestamp string
 * @throws {UrlDateFormatError} if `urlDate` is not canonical — bad input, recoverable by the caller
 * @throws {Error} if `timezoneOffsetMin` is not finite — that comes from area config, not the URL,
 *   so it is a fault on our side and deliberately NOT a `UrlDateFormatError`
 */
export function decodeUrlDate(
  urlDate: string,
  timezoneOffsetMin: number,
): string {
  if (!Number.isFinite(timezoneOffsetMin)) {
    throw new Error(
      `Invalid timezoneOffsetMin: ${timezoneOffsetMin}. Must be a finite number.`,
    );
  }

  let year: number, month: number, day: number, hours: number, minutes: number;

  if (CANONICAL_DATE_RE.test(urlDate)) {
    // YYYY-MM-DD — start of the local day
    [year, month, day] = urlDate.split("-").map(Number);
    hours = 0;
    minutes = 0;
  } else {
    // YYYY-MM-DD_HH.MM
    const match = urlDate.match(CANONICAL_DATETIME_RE);
    if (!match) throw new UrlDateFormatError(urlDate);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    hours = Number(match[4]);
    minutes = Number(match[5]);
    if (hours > 23 || minutes > 59) throw new UrlDateFormatError(urlDate);
  }

  // Create date in UTC representing the local time
  const localTime = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

  // Reject dates that don't exist (2026-02-31, 2026-13-01): Date.UTC silently rolls them over, so
  // compare the components back rather than trusting it.
  if (
    localTime.getUTCFullYear() !== year ||
    localTime.getUTCMonth() !== month - 1 ||
    localTime.getUTCDate() !== day
  ) {
    throw new UrlDateFormatError(urlDate);
  }

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
 * Strict, and for the same reason as {@link decodeUrlDate}: this used to be a bare `parseInt`, so
 * `?offset=abc` yielded NaN and blew up at the caller's `.toISOString()` rather than here.
 *
 * @param urlOffset - URL offset string (e.g., "600m")
 * @returns Offset in minutes
 * @throws {UrlDateFormatError} if not a canonical, in-range offset
 */
export function decodeUrlOffset(urlOffset: string): number {
  const match = urlOffset.match(CANONICAL_OFFSET_RE);
  if (!match) throw new UrlDateFormatError(urlOffset, "URL offset");

  const minutes = Number(match[1]);
  if (Math.abs(minutes) > MAX_OFFSET_MIN) {
    throw new UrlDateFormatError(urlOffset, "URL offset");
  }
  return minutes;
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
