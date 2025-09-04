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
 * Get yesterday's date in YYYY-MM-DD format in the system's timezone
 * @param timezoneOffsetMinutes - System's timezone offset in minutes (e.g., 600 for AEST)
 * @returns Date string in YYYY-MM-DD format
 */
export function getYesterdayDate(timezoneOffsetMinutes: number): string {
  // Get current UTC time
  const nowUTC = new Date();
  
  // Apply timezone offset to get local time
  const localTime = new Date(nowUTC.getTime() + timezoneOffsetMinutes * 60 * 1000);
  
  // Subtract one day
  localTime.setDate(localTime.getDate() - 1);
  
  // Format as YYYY-MM-DD
  const year = localTime.getFullYear();
  const month = String(localTime.getMonth() + 1).padStart(2, '0');
  const day = String(localTime.getDate()).padStart(2, '0');
  
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
  systemTimezoneOffsetMin: number
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
  isStartOfDay: boolean
): ZonedDateTime {
  // Check if it's a date-only string (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) {
    // Parse as date and convert to ZonedDateTime at start or end of day
    const date = parseDate(timeStr);
    
    // Create timezone string (e.g., "+10:00" for AEST, no DST)
    const offsetHours = Math.floor(Math.abs(systemTimezoneOffsetMin) / 60);
    const offsetMinutes = Math.abs(systemTimezoneOffsetMin) % 60;
    const offsetSign = systemTimezoneOffsetMin >= 0 ? '+' : '-';
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
 * @param timezoneOffsetMin - Timezone offset in minutes
 * @returns ZonedDateTime object
 */
export function fromUnixTimestamp(unixSeconds: number, timezoneOffsetMin: number): ZonedDateTime {
  // Convert Unix seconds to milliseconds
  const epochMillis = unixSeconds * 1000;
  
  // fromDate requires a Date object, not a number
  // Create a Date object from the epoch milliseconds
  const date = new Date(epochMillis);
  
  // Use fromDate with the Date object
  const timezone = timezoneOffsetMin === 600 ? 'Australia/Brisbane' : 'UTC';
  
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
 * @param systemTimezoneOffsetMin - System's standard timezone offset in minutes
 * @returns Tuple of [start, end] as either ZonedDateTime or CalendarDate based on interval
 */
export function parseRelativeTime(
  lastParam: string,
  interval: string,
  systemTimezoneOffsetMin: number
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
    // Always end with yesterday since today's data isn't complete
    const today = new CalendarDate(nowTime.year, nowTime.month, nowTime.day);
    const yesterday = today.subtract({ days: 1 });
    let startDate: CalendarDate;
    
    switch (unit) {
      case 'd':
        startDate = yesterday.subtract({ days: amount - 1 }); // Count back from yesterday
        break;
      case 'h':
      case 'm':
        throw new Error(`Hours and minutes not supported for daily intervals. Use days (e.g., 30d)`);
      default:
        throw new Error(`Invalid time unit: ${unit}`);
    }
    
    return [startDate, yesterday];
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

/**
 * Get a ZonedDateTime for the current time adjusted to a specific timezone offset
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC (e.g., 600 for UTC+10)
 * @returns ZonedDateTime adjusted for the timezone offset
 */
export function getZonedNow(timezoneOffsetMin: number): ZonedDateTime {
  // Start with UTC time
  const nowUTC = now('UTC');
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
export function getYesterdayInTimezone(timezoneOffsetMin: number): CalendarDate {
  const today = getTodayInTimezone(timezoneOffsetMin);
  return today.subtract({ days: 1 });
}

/**
 * Get a CalendarDate N days ago for a given timezone
 * @param daysAgo - Number of days in the past (0 = today, 1 = yesterday, etc.)
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC
 * @returns CalendarDate N days ago in the given timezone
 */
export function getCalendarDateDaysAgo(daysAgo: number, timezoneOffsetMin: number): CalendarDate {
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
  timezoneOffsetMin: number
): [number, number] {
  // Create a ZonedDateTime at midnight UTC for the given date
  const midnightUTC = now('UTC').set({
    year: date.year,
    month: date.month,
    day: date.day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0
  });
  
  // Subtract the timezone offset to get the UTC time that corresponds to midnight local
  // If the timezone is +600 (10 hours ahead), midnight local is 10 hours earlier in UTC
  const startOfDay = midnightUTC.subtract({ minutes: timezoneOffsetMin });
  const startUnix = Math.floor(startOfDay.toDate().getTime() / 1000);
  
  // End of day is start of next day (midnight of next day)
  const nextDay = date.add({ days: 1 });
  const nextMidnightUTC = now('UTC').set({
    year: nextDay.year,
    month: nextDay.month,
    day: nextDay.day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0
  });
  
  const endOfDay = nextMidnightUTC.subtract({ minutes: timezoneOffsetMin });
  const endUnix = Math.floor(endOfDay.toDate().getTime() / 1000);
  
  return [startUnix, endUnix];
}

/**
 * Format a date/time range intelligently to avoid redundant information
 * Uses en-dash (–) between dates as per typographic standards
 * 
 * Examples:
 * - Same day, different times: "4:30pm – 7:35pm, 2 Sept 2025"
 * - Different days, same year: "4:35pm, 2 Oct – 7:10am, 11 Nov 2024"
 * - Different years: "4:35pm, 30 Dec 2024 – 7:10am, 2 Jan 2025"
 * - Same time (single point): "4:30pm, 2 Sept 2025"
 * 
 * @param start - Start ZonedDateTime
 * @param end - End ZonedDateTime
 * @param includeTime - Whether to include time in the output (default: false)
 * @returns Formatted date range string
 */
export function formatDateRange(
  start: ZonedDateTime,
  end: ZonedDateTime,
  includeTime = false
): string {
  // Determine if we need to show minutes (if either time has non-zero minutes)
  const needMinutes = includeTime && (start.minute !== 0 || end.minute !== 0);
  
  // Helper to format time in 12-hour format (e.g., "4:30pm" or "4:00pm" if needMinutes)
  const formatTime = (zdt: ZonedDateTime): string => {
    const hour = zdt.hour;
    const minute = zdt.minute;
    const period = hour >= 12 ? 'pm' : 'am';
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    // Include minutes if needed (either time has non-zero minutes)
    const minuteStr = needMinutes ? `:${String(minute).padStart(2, '0')}` : (minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`);
    return `${displayHour}${minuteStr}${period}`;
  };
  
  // Helper to format month using locale (e.g., "Sep", "Oct")
  const formatMonth = (month: number): string => {
    const date = new Date(2000, month - 1, 1);
    return date.toLocaleDateString('en-AU', { month: 'short' });
  };
  
  // Check if it's the same point in time
  if (start.compare(end) === 0) {
    if (includeTime) {
      return `${formatTime(start)}, ${start.day} ${formatMonth(start.month)} ${start.year}`;
    }
    return `${start.day} ${formatMonth(start.month)} ${start.year}`;
  }
  
  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
  const sameYear = start.year === end.year;
  
  if (includeTime) {
    if (sameDay) {
      // Same day, different times: "4:30pm – 7:35pm, 2 Sep 2025"
      return `${formatTime(start)} – ${formatTime(end)}, ${start.day} ${formatMonth(start.month)} ${start.year}`;
    } else if (sameYear) {
      // Different days, same year: "4:35pm, 2 Oct – 7:10am, 11 Nov 2024"
      return `${formatTime(start)}, ${start.day} ${formatMonth(start.month)} – ${formatTime(end)}, ${end.day} ${formatMonth(end.month)} ${end.year}`;
    } else {
      // Different years: "4:35pm, 30 Dec 2024 – 7:10am, 2 Jan 2025"
      return `${formatTime(start)}, ${start.day} ${formatMonth(start.month)} ${start.year} – ${formatTime(end)}, ${end.day} ${formatMonth(end.month)} ${end.year}`;
    }
  } else {
    // Date-only formatting (no time)
    if (sameDay) {
      // Same day: "2 Sep 2025" (not "2 – 2 Sep 2025")
      return `${start.day} ${formatMonth(start.month)} ${start.year}`;
    }
    
    const sameMonth = start.year === end.year && start.month === end.month;
    
    if (sameMonth) {
      // Same month and year: "3 – 5 Sep 2025"
      return `${start.day} – ${end.day} ${formatMonth(end.month)} ${end.year}`;
    } else if (sameYear) {
      // Different months, same year: "28 Nov – 3 Dec 2025"
      return `${start.day} ${formatMonth(start.month)} – ${end.day} ${formatMonth(end.month)} ${end.year}`;
    } else {
      // Different years: "30 Dec 2024 – 2 Jan 2025"
      return `${start.day} ${formatMonth(start.month)} ${start.year} – ${end.day} ${formatMonth(end.month)} ${end.year}`;
    }
  }
}