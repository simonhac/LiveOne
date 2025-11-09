import {
  parseAbsolute,
  toZoned,
  CalendarDate,
  ZonedDateTime,
  parseDate,
  now,
  fromDate,
} from "@internationalized/date";

/**
 * Get current time formatted as ISO8601 with fixed AEST offset (+10:00)
 * This uses a fixed offset rather than timezone to avoid DST complications
 * @returns ISO string with +10:00 offset (e.g., "2025-08-16T20:36:41+10:00")
 */
export function getNowFormattedAEST(): string {
  const nowDate = new Date();
  // Add 10 hours to UTC to get AEST
  const aestTime = new Date(nowDate.getTime() + 10 * 60 * 60 * 1000);

  const year = aestTime.getUTCFullYear();
  const month = String(aestTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(aestTime.getUTCDate()).padStart(2, "0");
  const hour = String(aestTime.getUTCHours()).padStart(2, "0");
  const minute = String(aestTime.getUTCMinutes()).padStart(2, "0");
  const second = String(aestTime.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}+10:00`;
}

/**
 * Format a Date to AEST/AEDT timezone string without milliseconds
 * @param date - JavaScript Date object
 * @returns ISO string with timezone offset (e.g., "2025-08-16T20:36:41+10:00")
 */
export function formatTimeAEST(zonedDateTime: ZonedDateTime): string {
  // Validate input
  if (!zonedDateTime || typeof zonedDateTime.year === "undefined") {
    throw new Error(
      `formatTimeAEST expects a ZonedDateTime object, got ${typeof zonedDateTime}: ${zonedDateTime}`,
    );
  }

  // Get the year, month, day, hour, minute, second from the zoned date
  const year = zonedDateTime.year;
  const month = String(zonedDateTime.month).padStart(2, "0");
  const day = String(zonedDateTime.day).padStart(2, "0");
  const hour = String(zonedDateTime.hour).padStart(2, "0");
  const minute = String(zonedDateTime.minute).padStart(2, "0");
  const second = String(zonedDateTime.second).padStart(2, "0");

  // Get the offset in milliseconds and convert to +HH:MM format
  const offsetMs = zonedDateTime.offset;
  const offsetMinutes = offsetMs / (1000 * 60); // Convert ms to minutes
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetString = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetString}`;
}

/**
 * Format a CalendarDate to YYYY-MM-DD string
 * @param date - CalendarDate object
 * @returns Date string in YYYY-MM-DD format
 */
export function formatDateAEST(date: CalendarDate): string {
  const year = date.year;
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * Format a CalendarDate as YYYY-MM-DD (ISO 8601 date format)
 * @param date - The CalendarDate to format
 * @returns Date string in YYYY-MM-DD format
 * @deprecated Use formatDateAEST instead (same functionality)
 */
export function formatDateYYYYMMDD(date: CalendarDate): string {
  return formatDateAEST(date);
}

/**
 * Parse a YYYY-MM-DD string to CalendarDate
 * @param dateStr - Date string in YYYY-MM-DD format (e.g., "2025-08-17")
 * @returns CalendarDate object
 */
export function parseDateISO(dateStr: string): CalendarDate {
  return parseDate(dateStr);
}

/**
 * Parse a YYYY-MM-DD string to CalendarDate
 * @param dateStr - Date string in YYYY-MM-DD format (e.g., "2025-08-17")
 * @returns CalendarDate object
 * @deprecated Use parseDateISO instead
 */
export function parseDateYYYYMMDD(dateStr: string): CalendarDate {
  return parseDate(dateStr);
}

/**
 * Get yesterday's date in YYYY-MM-DD format in the system's timezone
 * @param timezoneOffsetMinutes - System's timezone offset in minutes (e.g., 600 for AEST)
 * @returns Date string in YYYY-MM-DD format
 */
export function getYesterdayDate(timezoneOffsetMinutes: number): string {
  // Get current UTC time
  const nowUTC = new Date();

  // Apply timezone offset to get local time
  const localTime = new Date(
    nowUTC.getTime() + timezoneOffsetMinutes * 60 * 1000,
  );

  // Subtract one day
  localTime.setDate(localTime.getDate() - 1);

  // Format as YYYY-MM-DD
  const year = localTime.getFullYear();
  const month = String(localTime.getMonth() + 1).padStart(2, "0");
  const day = String(localTime.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * Parse time range for minute-based intervals (5m, 30m)
 * Accepts either ISO8601 datetime or date-only strings
 * @param startStr - Start time/date string
 * @param endStr - End time/date string
 * @param systemTimezoneOffsetMin - System's standard timezone offset in minutes (e.g., 600 for AEST)
 * @returns Tuple of [startTime, endTime] as ZonedDateTime objects
 */
export function parseTimeRange(
  startStr: string,
  endStr: string,
  systemTimezoneOffsetMin: number,
): [ZonedDateTime, ZonedDateTime] {
  const startTime = parseTimeString(startStr, systemTimezoneOffsetMin, true);
  const endTime = parseTimeString(endStr, systemTimezoneOffsetMin, false);

  return [startTime, endTime];
}

/**
 * Parse a single time/date string into ZonedDateTime
 * @param timeStr - ISO8601 datetime or date string
 * @param systemTimezoneOffsetMin - System's standard timezone offset in minutes
 * @param isStartOfDay - If date-only, whether to use start (00:00) or end (23:59:59.999) of day
 */
function parseTimeString(
  timeStr: string,
  systemTimezoneOffsetMin: number,
  isStartOfDay: boolean,
): ZonedDateTime {
  // Check if it's a date-only string (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) {
    // Parse as date and convert to ZonedDateTime at start or end of day
    const date = parseDate(timeStr);

    // Create timezone string (e.g., "+10:00" for AEST, no DST)
    const offsetHours = Math.floor(Math.abs(systemTimezoneOffsetMin) / 60);
    const offsetMinutes = Math.abs(systemTimezoneOffsetMin) % 60;
    const offsetSign = systemTimezoneOffsetMin >= 0 ? "+" : "-";
    const tzOffset = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;

    // Create datetime string at start or end of day
    // End of day is midnight (00:00:00) of the next day
    if (isStartOfDay) {
      const datetimeStr = `${timeStr}T00:00:00.000${tzOffset}`;
      const absolute = parseAbsolute(datetimeStr, tzOffset);
      return toZoned(absolute, "Australia/Sydney");
    } else {
      // End of day: add one day and use 00:00:00
      const nextDay = date.add({ days: 1 });
      const year = nextDay.year;
      const month = String(nextDay.month).padStart(2, "0");
      const day = String(nextDay.day).padStart(2, "0");
      const datetimeStr = `${year}-${month}-${day}T00:00:00.000${tzOffset}`;
      const absolute = parseAbsolute(datetimeStr, tzOffset);
      return toZoned(absolute, "Australia/Sydney");
    }
  }

  // It's a full datetime string - parse it directly
  // If no timezone specified, it will be treated as UTC
  try {
    // First try parsing with timezone info
    const absolute = parseAbsolute(timeStr, "UTC");
    return toZoned(absolute, "Australia/Sydney");
  } catch (e) {
    // If that fails, try adding Z for UTC
    const absolute = parseAbsolute(timeStr + "Z", "UTC");
    return toZoned(absolute, "Australia/Sydney");
  }
}

/**
 * Parse date range for daily intervals (1d)
 * Accepts only ISO8601 date strings (YYYY-MM-DD)
 * @param startStr - Start date string
 * @param endStr - End date string
 * @returns Tuple of [startDate, endDate] as CalendarDate objects
 * @throws Error if strings are not valid date-only format
 */
export function parseDateRange(
  startStr: string,
  endStr: string,
): [CalendarDate, CalendarDate] {
  // Strict validation - must be date-only format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
    throw new Error(
      `Invalid start date format. Expected YYYY-MM-DD, got: ${startStr}`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
    throw new Error(
      `Invalid end date format. Expected YYYY-MM-DD, got: ${endStr}`,
    );
  }

  const startDate = parseDate(startStr);
  const endDate = parseDate(endStr);

  // Validate that start is before or equal to end
  if (startDate.compare(endDate) > 0) {
    throw new Error(
      `Start date (${startStr}) must be before or equal to end date (${endStr})`,
    );
  }

  return [startDate, endDate];
}

/**
 * Convert a ZonedDateTime to Unix timestamp (seconds since epoch)
 * @param zonedDateTime - The ZonedDateTime to convert
 * @returns Unix timestamp in seconds
 */
export function toUnixTimestamp(zonedDateTime: ZonedDateTime): number {
  // Validate input
  if (!zonedDateTime || typeof zonedDateTime.toDate !== "function") {
    throw new Error(
      `toUnixTimestamp expects a ZonedDateTime object, got ${typeof zonedDateTime}: ${zonedDateTime}`,
    );
  }

  // Convert to milliseconds since epoch, then to seconds
  const epochMillis = zonedDateTime.toDate().getTime();
  return Math.floor(epochMillis / 1000);
}

/**
 * Convert Unix timestamp to ZonedDateTime
 * @param unixSeconds - Unix timestamp in seconds
 * @param timezoneOffsetMin - Timezone offset in minutes
 * @returns ZonedDateTime object
 */
export function fromUnixTimestamp(
  unixSeconds: number,
  timezoneOffsetMin: number,
): ZonedDateTime {
  // Convert Unix seconds to milliseconds
  const epochMillis = unixSeconds * 1000;

  // fromDate requires a Date object, not a number
  // Create a Date object from the epoch milliseconds
  const date = new Date(epochMillis);

  // Use fromDate with the Date object
  const timezone = timezoneOffsetMin === 600 ? "Australia/Brisbane" : "UTC";

  // Create ZonedDateTime from the Date object
  return fromDate(date, timezone);
}

/**
 * Calculate the difference between two CalendarDates in milliseconds
 * @param start - Start date
 * @param end - End date
 * @returns Difference in milliseconds
 */
export function getDateDifferenceMs(
  start: CalendarDate,
  end: CalendarDate,
): number {
  // compare() returns the difference in days
  const daysDiff = end.compare(start);
  return daysDiff * 24 * 60 * 60 * 1000; // Convert days to milliseconds
}

/**
 * Calculate the difference between two ZonedDateTimes in milliseconds
 * @param start - Start time
 * @param end - End time
 * @returns Difference in milliseconds
 */
export function getTimeDifferenceMs(
  start: ZonedDateTime,
  end: ZonedDateTime,
): number {
  // compare() returns the difference in milliseconds
  return end.compare(start);
}

/**
 * Parse relative time (e.g., "7d", "24h", "30m")
 * @param lastParam - Relative time string
 * @param interval - The interval type (5m, 30m, 1d)
 * @param systemTimezoneOffsetMin - System's standard timezone offset in minutes
 * @returns Tuple of [start, end] as either ZonedDateTime or CalendarDate based on interval
 */
export function parseRelativeTime(
  lastParam: string,
  interval: string,
  systemTimezoneOffsetMin: number,
): [ZonedDateTime | CalendarDate, ZonedDateTime | CalendarDate] {
  const match = lastParam.match(/^(\d+)([dhm])$/i);
  if (!match) {
    throw new Error(
      `Invalid relative time format. Use format like 7d, 24h, or 30m. Got: ${lastParam}`,
    );
  }

  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  const nowTime = now("Australia/Brisbane");

  if (interval === "1d") {
    // For daily intervals, work with calendar dates
    // Always end with yesterday since today's data isn't complete
    const today = new CalendarDate(nowTime.year, nowTime.month, nowTime.day);
    const yesterday = today.subtract({ days: 1 });
    let startDate: CalendarDate;

    switch (unit) {
      case "d":
        startDate = yesterday.subtract({ days: amount - 1 }); // Count back from yesterday
        break;
      case "h":
      case "m":
        throw new Error(
          `Hours and minutes not supported for daily intervals. Use days (e.g., 30d)`,
        );
      default:
        throw new Error(`Invalid time unit: ${unit}`);
    }

    return [startDate, yesterday];
  } else {
    // For minute intervals, align end time to interval boundary
    const intervalMinutes = interval === "30m" ? 30 : 5;

    // Align current time to previous interval boundary (not future)
    const endMinute = nowTime.minute;
    const endAlignedMinute =
      Math.floor(endMinute / intervalMinutes) * intervalMinutes;
    const minutesToSubtract = endMinute - endAlignedMinute;
    const endTime = nowTime
      .subtract({ minutes: minutesToSubtract })
      .set({ second: 0, millisecond: 0 });

    // Calculate start time based on the aligned end time
    let startTime: ZonedDateTime;

    switch (unit) {
      case "d":
        startTime = endTime.subtract({ days: amount });
        break;
      case "h":
        startTime = endTime.subtract({ hours: amount });
        break;
      case "m":
        startTime = endTime.subtract({ minutes: amount });
        break;
      default:
        throw new Error(`Invalid time unit: ${unit}`);
    }

    return [startTime, endTime];
  }
}

/**
 * Get a ZonedDateTime for the current time adjusted to a specific timezone offset
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC (e.g., 600 for UTC+10)
 * @returns ZonedDateTime adjusted for the timezone offset
 */
export function getZonedNow(timezoneOffsetMin: number): ZonedDateTime {
  // Start with UTC time
  const nowUTC = now("UTC");
  // Add the timezone offset to get the correct local time
  return nowUTC.add({ minutes: timezoneOffsetMin });
}

/**
 * Get today's date as a CalendarDate for a given timezone
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC (e.g., 600 for UTC+10)
 * @returns Today's CalendarDate in the given timezone
 */
export function getTodayInTimezone(timezoneOffsetMin: number): CalendarDate {
  const zonedNow = getZonedNow(timezoneOffsetMin);
  return new CalendarDate(zonedNow.year, zonedNow.month, zonedNow.day);
}

/**
 * Get yesterday as a CalendarDate for a given timezone
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC
 * @returns Yesterday's CalendarDate in the given timezone
 */
export function getYesterdayInTimezone(
  timezoneOffsetMin: number,
): CalendarDate {
  const today = getTodayInTimezone(timezoneOffsetMin);
  return today.subtract({ days: 1 });
}

/**
 * Get a CalendarDate N days ago for a given timezone
 * @param daysAgo - Number of days in the past (0 = today, 1 = yesterday, etc.)
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC
 * @returns CalendarDate N days ago in the given timezone
 */
export function getCalendarDateDaysAgo(
  daysAgo: number,
  timezoneOffsetMin: number,
): CalendarDate {
  const today = getTodayInTimezone(timezoneOffsetMin);
  return daysAgo > 0 ? today.subtract({ days: daysAgo }) : today;
}

/**
 * Convert a CalendarDate to Unix timestamps for start and end of day in a given timezone
 * @param date - The calendar date
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC
 * @returns Tuple of [startOfDayUnix, endOfDayUnix] in seconds
 * Note: End of day is midnight (00:00:00) of the next day, not 23:59:59
 */
export function calendarDateToUnixRange(
  date: CalendarDate,
  timezoneOffsetMin: number,
): [number, number] {
  // Create a ZonedDateTime at midnight UTC for the given date
  const midnightUTC = now("UTC").set({
    year: date.year,
    month: date.month,
    day: date.day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  // Subtract the timezone offset to get the UTC time that corresponds to midnight local
  // If the timezone is +600 (10 hours ahead), midnight local is 10 hours earlier in UTC
  const startOfDay = midnightUTC.subtract({ minutes: timezoneOffsetMin });
  const startUnix = Math.floor(startOfDay.toDate().getTime() / 1000);

  // End of day is start of next day (midnight of next day)
  const nextDay = date.add({ days: 1 });
  const nextMidnightUTC = now("UTC").set({
    year: nextDay.year,
    month: nextDay.month,
    day: nextDay.day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  const endOfDay = nextMidnightUTC.subtract({ minutes: timezoneOffsetMin });
  const endUnix = Math.floor(endOfDay.toDate().getTime() / 1000);

  return [startUnix, endUnix];
}

/**
 * Convert Unix timestamp to ISO8601 with fixed AEST offset (+10:00)
 * @param unixTimestamp - Unix timestamp (can be in seconds or milliseconds)
 * @param isMilliseconds - Whether the timestamp is in milliseconds (default: false for seconds)
 * @returns ISO string with +10:00 offset (e.g., "2025-08-16T20:36:41+10:00")
 */
export function unixToFormattedAEST(
  unixTimestamp: number,
  isMilliseconds = false,
): string {
  // Convert to milliseconds if needed
  const epochMillis = isMilliseconds ? unixTimestamp : unixTimestamp * 1000;
  const date = new Date(epochMillis);

  // Add 10 hours to UTC to get AEST
  const aestTime = new Date(date.getTime() + 10 * 60 * 60 * 1000);

  const year = aestTime.getUTCFullYear();
  const month = String(aestTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(aestTime.getUTCDate()).padStart(2, "0");
  const hour = String(aestTime.getUTCHours()).padStart(2, "0");
  const minute = String(aestTime.getUTCMinutes()).padStart(2, "0");
  const second = String(aestTime.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}+10:00`;
}

/**
 * Format a JavaScript Date to an ISO string with timezone offset
 * @param date - JavaScript Date object
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC (positive for east, negative for west)
 * @returns ISO string with timezone offset (e.g., "2025-08-16T20:36:41+10:00")
 */
export function formatTime_fromJSDate(
  date: Date,
  timezoneOffsetMin: number,
): string {
  // Get the UTC time
  const utcTime = date.getTime();

  // Apply the timezone offset to get local time
  const localTime = new Date(utcTime + timezoneOffsetMin * 60 * 1000);

  // Format the date parts using UTC methods (since we've already applied the offset)
  const year = localTime.getUTCFullYear();
  const month = String(localTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localTime.getUTCDate()).padStart(2, "0");
  const hour = String(localTime.getUTCHours()).padStart(2, "0");
  const minute = String(localTime.getUTCMinutes()).padStart(2, "0");
  const second = String(localTime.getUTCSeconds()).padStart(2, "0");

  // Format the timezone offset (e.g., "+10:00" or "-05:00")
  const offsetHours = Math.floor(Math.abs(timezoneOffsetMin) / 60);
  const offsetMinutes = Math.abs(timezoneOffsetMin) % 60;
  const offsetSign = timezoneOffsetMin >= 0 ? "+" : "-";
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;

  // Return ISO format with timezone offset
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetStr}`;
}

/**
 * Format a Date as HH:mm+TZ in the system's timezone
 * @param date - JavaScript Date object (in UTC)
 * @param timezoneOffsetMin - Timezone offset in minutes (positive for east of UTC)
 * @returns Time string in HH:mm+TZ format (e.g., "14:30+10:00")
 */
export function formatJustTime_fromJSDate(
  date: Date,
  timezoneOffsetMin: number,
): string {
  // Apply the timezone offset to get local time
  const localTime = new Date(date.getTime() + timezoneOffsetMin * 60 * 1000);

  // Format time as HH:mm using UTC methods (since we've already applied the offset)
  const hour = String(localTime.getUTCHours()).padStart(2, "0");
  const minute = String(localTime.getUTCMinutes()).padStart(2, "0");

  // Format the timezone offset (e.g., "+10:00" or "-05:00")
  const offsetHours = Math.floor(Math.abs(timezoneOffsetMin) / 60);
  const offsetMinutes = Math.abs(timezoneOffsetMin) % 60;
  const offsetSign = timezoneOffsetMin >= 0 ? "+" : "-";
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;

  return `${hour}:${minute}${offsetStr}`;
}

/**
 * Calculate the next time at a specific minute boundary
 * @param intervalMinutes - The interval in minutes (e.g., 1, 5, 15, 30, 60)
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC (e.g., 600 for UTC+10)
 * @param baseTime - Optional base time to calculate from (defaults to now)
 * @returns ZonedDateTime for the next boundary
 *
 * Examples:
 * - intervalMinutes=1: Returns next minute (:00 seconds)
 * - intervalMinutes=5: Returns next 5-minute boundary (:00, :05, :10, etc.)
 * - intervalMinutes=60: Returns next hour (:00:00)
 */
export function getNextMinuteBoundary(
  intervalMinutes: number,
  timezoneOffsetMin: number = 600,
  baseTime?: Date,
): ZonedDateTime {
  const base = baseTime || new Date();

  // Convert to milliseconds since epoch
  const baseMs = base.getTime();
  const intervalMs = intervalMinutes * 60 * 1000; // Convert minutes to milliseconds

  // Calculate periods and next boundary
  // Always advance to the next boundary
  const periods = Math.floor(baseMs / intervalMs);
  const nextMs = (periods + 1) * intervalMs;

  // Create new Date at the next boundary
  const next = new Date(nextMs);

  // Convert offset to IANA fixed offset timezone string
  // Note: IANA uses inverted signs (Etc/GMT-10 = UTC+10)
  const offsetHours = timezoneOffsetMin / 60;
  let timezone: string;
  if (offsetHours === 0) {
    timezone = "Etc/UTC";
  } else {
    // Invert the sign for IANA Etc/GMT zones
    const etcOffset = -offsetHours;
    timezone = etcOffset >= 0 ? `Etc/GMT+${etcOffset}` : `Etc/GMT${etcOffset}`;
  }

  return fromDate(next, timezone);
}
