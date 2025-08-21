import { parseAbsolute, toZoned, CalendarDate, ZonedDateTime, parseDate, now, fromDate } from '@internationalized/date';

/**
 * Format a Date to AEST/AEDT timezone string without milliseconds
 * @param date - JavaScript Date object
 * @returns ISO string with timezone offset (e.g., "2025-08-16T20:36:41+10:00")
 */
export function formatTimeAEST(zonedDateTime: ZonedDateTime): string {
  // Validate input
  if (!zonedDateTime || typeof zonedDateTime.year === 'undefined') {
    throw new Error(`formatTimeAEST expects a ZonedDateTime object, got ${typeof zonedDateTime}: ${zonedDateTime}`);
  }
  
  // Get the year, month, day, hour, minute, second from the zoned date
  const year = zonedDateTime.year;
  const month = String(zonedDateTime.month).padStart(2, '0');
  const day = String(zonedDateTime.day).padStart(2, '0');
  const hour = String(zonedDateTime.hour).padStart(2, '0');
  const minute = String(zonedDateTime.minute).padStart(2, '0');
  const second = String(zonedDateTime.second).padStart(2, '0');
  
  // Get the offset in milliseconds and convert to +HH:MM format
  const offsetMs = zonedDateTime.offset;
  const offsetMinutes = offsetMs / (1000 * 60); // Convert ms to minutes
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;
  
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetString}`;
}

/**
 * Format a CalendarDate to YYYY-MM-DD string
 * @param date - CalendarDate object
 * @returns Date string in YYYY-MM-DD format
 */
export function formatDateAEST(date: CalendarDate): string {
  const year = date.year;
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}


/**
 * Get yesterday's date in YYYY-MM-DD format
 * @returns Date string in YYYY-MM-DD format
 */
export function getYesterdayDate(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}

/**
 * Parse time range for minute-based intervals (5m, 30m)
 * Accepts either ISO8601 datetime or date-only strings
 * @param startStr - Start time/date string
 * @param endStr - End time/date string
 * @param systemTimezoneOffset - System's standard timezone offset in hours (e.g., 10 for AEST)
 * @returns Tuple of [startTime, endTime] as ZonedDateTime objects
 */
export function parseTimeRange(
  startStr: string,
  endStr: string,
  systemTimezoneOffset: number
): [ZonedDateTime, ZonedDateTime] {
  const startTime = parseTimeString(startStr, systemTimezoneOffset, true);
  const endTime = parseTimeString(endStr, systemTimezoneOffset, false);
  
  return [startTime, endTime];
}

/**
 * Parse a single time/date string into ZonedDateTime
 * @param timeStr - ISO8601 datetime or date string
 * @param systemTimezoneOffset - System's standard timezone offset in hours
 * @param isStartOfDay - If date-only, whether to use start (00:00) or end (23:59:59.999) of day
 */
function parseTimeString(
  timeStr: string,
  systemTimezoneOffset: number,
  isStartOfDay: boolean
): ZonedDateTime {
  // Check if it's a date-only string (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) {
    // Parse as date and convert to ZonedDateTime at start or end of day
    const date = parseDate(timeStr);
    
    // Create timezone string (e.g., "+10:00" for AEST, no DST)
    const offsetHours = Math.floor(Math.abs(systemTimezoneOffset));
    const offsetMinutes = Math.round((Math.abs(systemTimezoneOffset) % 1) * 60);
    const offsetSign = systemTimezoneOffset >= 0 ? '+' : '-';
    const tzOffset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
    
    // Create datetime string at start or end of day
    // End of day is midnight (00:00:00) of the next day
    if (isStartOfDay) {
      const datetimeStr = `${timeStr}T00:00:00.000${tzOffset}`;
      const absolute = parseAbsolute(datetimeStr, tzOffset);
      return toZoned(absolute, 'Australia/Sydney');
    } else {
      // End of day: add one day and use 00:00:00
      const nextDay = date.add({ days: 1 });
      const year = nextDay.year;
      const month = String(nextDay.month).padStart(2, '0');
      const day = String(nextDay.day).padStart(2, '0');
      const datetimeStr = `${year}-${month}-${day}T00:00:00.000${tzOffset}`;
      const absolute = parseAbsolute(datetimeStr, tzOffset);
      return toZoned(absolute, 'Australia/Sydney');
    }
  }
  
  // It's a full datetime string - parse it directly
  // If no timezone specified, it will be treated as UTC
  try {
    // First try parsing with timezone info
    const absolute = parseAbsolute(timeStr, 'UTC');
    return toZoned(absolute, 'Australia/Sydney');
  } catch (e) {
    // If that fails, try adding Z for UTC
    const absolute = parseAbsolute(timeStr + 'Z', 'UTC');
    return toZoned(absolute, 'Australia/Sydney');
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
  endStr: string
): [CalendarDate, CalendarDate] {
  // Strict validation - must be date-only format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
    throw new Error(`Invalid start date format. Expected YYYY-MM-DD, got: ${startStr}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
    throw new Error(`Invalid end date format. Expected YYYY-MM-DD, got: ${endStr}`);
  }
  
  const startDate = parseDate(startStr);
  const endDate = parseDate(endStr);
  
  // Validate that start is before or equal to end
  if (startDate.compare(endDate) > 0) {
    throw new Error(`Start date (${startStr}) must be before or equal to end date (${endStr})`);
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
  if (!zonedDateTime || typeof zonedDateTime.toDate !== 'function') {
    throw new Error(`toUnixTimestamp expects a ZonedDateTime object, got ${typeof zonedDateTime}: ${zonedDateTime}`);
  }
  
  // Convert to milliseconds since epoch, then to seconds
  const epochMillis = zonedDateTime.toDate().getTime();
  return Math.floor(epochMillis / 1000);
}

/**
 * Convert Unix timestamp to ZonedDateTime
 * @param unixSeconds - Unix timestamp in seconds
 * @param timezoneOffset - Timezone offset in hours (default 10 for AEST)
 * @returns ZonedDateTime object
 */
export function fromUnixTimestamp(unixSeconds: number, timezoneOffset: number = 10): ZonedDateTime {
  // Convert Unix seconds to milliseconds
  const epochMillis = unixSeconds * 1000;
  
  // fromDate requires a Date object, not a number
  // Create a Date object from the epoch milliseconds
  const date = new Date(epochMillis);
  
  // Use fromDate with the Date object
  const timezone = timezoneOffset === 10 ? 'Australia/Brisbane' : 'UTC';
  
  // Create ZonedDateTime from the Date object
  return fromDate(date, timezone);
}

/**
 * Calculate the difference between two CalendarDates in milliseconds
 * @param start - Start date
 * @param end - End date
 * @returns Difference in milliseconds
 */
export function getDateDifferenceMs(start: CalendarDate, end: CalendarDate): number {
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
export function getTimeDifferenceMs(start: ZonedDateTime, end: ZonedDateTime): number {
  // compare() returns the difference in milliseconds
  return end.compare(start);
}

/**
 * Parse relative time (e.g., "7d", "24h", "30m")
 * @param lastParam - Relative time string
 * @param interval - The interval type (5m, 30m, 1d)
 * @param systemTimezoneOffset - System's standard timezone offset in hours
 * @returns Tuple of [start, end] as either ZonedDateTime or CalendarDate based on interval
 */
export function parseRelativeTime(
  lastParam: string,
  interval: string,
  systemTimezoneOffset: number
): [ZonedDateTime | CalendarDate, ZonedDateTime | CalendarDate] {
  const match = lastParam.match(/^(\d+)([dhm])$/i);
  if (!match) {
    throw new Error(`Invalid relative time format. Use format like 7d, 24h, or 30m. Got: ${lastParam}`);
  }
  
  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  
  const nowTime = now('Australia/Brisbane');
  
  if (interval === '1d') {
    // For daily intervals, work with calendar dates
    const today = new CalendarDate(nowTime.year, nowTime.month, nowTime.day);
    let startDate: CalendarDate;
    
    switch (unit) {
      case 'd':
        startDate = today.subtract({ days: amount - 1 }); // Include today
        break;
      case 'h':
      case 'm':
        throw new Error(`Hours and minutes not supported for daily intervals. Use days (e.g., 30d)`);
      default:
        throw new Error(`Invalid time unit: ${unit}`);
    }
    
    return [startDate, today];
  } else {
    // For minute intervals, align end time to interval boundary
    const intervalMinutes = interval === '30m' ? 30 : 5;
    
    // Align current time to next interval boundary
    const endMinute = nowTime.minute;
    const endAlignedMinute = Math.ceil(endMinute / intervalMinutes) * intervalMinutes;
    const minutesToAdd = endAlignedMinute - endMinute;
    const endTime = nowTime.add({ minutes: minutesToAdd }).set({ second: 0, millisecond: 0 });
    
    // Calculate start time based on the aligned end time
    let startTime: ZonedDateTime;
    
    switch (unit) {
      case 'd':
        startTime = endTime.subtract({ days: amount });
        break;
      case 'h':
        startTime = endTime.subtract({ hours: amount });
        break;
      case 'm':
        startTime = endTime.subtract({ minutes: amount });
        break;
      default:
        throw new Error(`Invalid time unit: ${unit}`);
    }
    
    return [startTime, endTime];
  }
}