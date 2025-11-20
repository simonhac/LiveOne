/**
 * Frontend date formatting utilities
 * Provides consistent date/time formatting across all UI components
 */

/**
 * Format a date/time for display in the UI
 * Returns time in 12-hour format with no leading zero and lowercase am/pm
 * Date in short month format
 *
 * @param date - Date to format (Date object or ISO string) - must not be null
 * @param options - Formatting options
 * @returns Object with formatted strings and metadata
 *
 * Examples:
 * - Time: "6:23:45 am" (with non-breaking space before am/pm)
 * - Date: "12 Sept 2025" (with non-breaking spaces)
 */
export function formatDateTime(
  date: Date | string,
  options: {
    includeSeconds?: boolean;
    includeDate?: boolean;
  } = {},
): {
  time: string;
  date: string;
  isToday: boolean;
  display: string; // Combined display string
} {
  const { includeSeconds = true, includeDate = true } = options;

  // Convert to Date object if string
  const dateObj = typeof date === "string" ? new Date(date) : date;

  // Check if it's today
  const now = new Date();
  const isToday =
    dateObj.getDate() === now.getDate() &&
    dateObj.getMonth() === now.getMonth() &&
    dateObj.getFullYear() === now.getFullYear();

  // Format time (12-hour, no leading zero, lowercase am/pm)
  const hours = dateObj.getHours();
  const minutes = dateObj.getMinutes();
  const seconds = dateObj.getSeconds();

  const period = hours >= 12 ? "pm" : "am";
  const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;

  // Build time string
  let timeStr = `${displayHour}:${minutes.toString().padStart(2, "0")}`;
  if (includeSeconds) {
    timeStr += `:${seconds.toString().padStart(2, "0")}`;
  }
  timeStr += `\u00A0${period}`; // Non-breaking space before am/pm

  // Format date (short month)
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sept",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = dateObj.getDate();
  const month = months[dateObj.getMonth()];
  const year = dateObj.getFullYear();

  // Build date string with non-breaking spaces
  const dateStr = `${day}\u00A0${month}\u00A0${year}`;

  // Build combined display string
  let display = timeStr;
  if (includeDate && !isToday) {
    display = `${timeStr}, ${dateStr}`;
  }

  return {
    time: timeStr,
    date: dateStr,
    isToday,
    display,
  };
}

/**
 * Format just the time portion
 * @param date - Date to format - must not be null
 * @param includeSeconds - Whether to include seconds
 * @returns Formatted time string
 */
export function formatTime(date: Date | string, includeSeconds = true): string {
  return formatDateTime(date, { includeSeconds, includeDate: false }).time;
}

/**
 * Format just the date portion
 * @param date - Date to format - must not be null
 * @returns Formatted date string
 */
export function formatDate(date: Date | string): string {
  return formatDateTime(date, { includeDate: true }).date;
}

/**
 * Format duration in a human-readable way
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 *
 * Examples:
 * - < 1s: "0.3 s"
 * - 1-60s: "1.5 s"
 * - > 60s: "2m 15s"
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;

  if (seconds < 60) {
    // Show one decimal place for seconds, always use "s" format
    return `${seconds.toFixed(1)}\u00A0s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m\u00A0${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    if (remainingMinutes > 0) {
      return `${hours}h\u00A0${remainingMinutes}m`;
    }
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (remainingHours > 0) {
    return `${days}d\u00A0${remainingHours}h`;
  }
  return `${days}d`;
}

/**
 * Format a relative time (e.g., "5 minutes ago", "in 2 hours")
 * @param date - Date to compare to now - must not be null
 * @returns Relative time string
 */
export function formatRelativeTime(date: Date | string): string {
  const dateObj = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const absDiffMs = Math.abs(diffMs);

  // Less than a minute
  if (absDiffMs < 60000) {
    const seconds = Math.floor(absDiffMs / 1000);
    if (seconds < 5) {
      return "just now";
    }
    return diffMs > 0 ? `${seconds}s ago` : `in ${seconds}s`;
  }

  // Less than an hour
  if (absDiffMs < 3600000) {
    const minutes = Math.floor(absDiffMs / 60000);
    return diffMs > 0 ? `${minutes}m ago` : `in ${minutes}m`;
  }

  // Less than a day
  if (absDiffMs < 86400000) {
    const hours = Math.floor(absDiffMs / 3600000);
    return diffMs > 0 ? `${hours}h ago` : `in ${hours}h`;
  }

  // Less than a week
  if (absDiffMs < 604800000) {
    const days = Math.floor(absDiffMs / 86400000);
    return diffMs > 0 ? `${days}d ago` : `in ${days}d`;
  }

  // Default to absolute date/time
  return formatDateTime(dateObj).display;
}

/**
 * Format seconds since an event for display
 * @param seconds - Number of seconds since the event
 * @returns Formatted string
 */
export function formatSecondsSince(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m ago`
      : `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a date/time range for display
 * Intelligently handles same day, same month, same year cases
 *
 * @param start - Start of the range (ZonedDateTime)
 * @param end - End of the range (ZonedDateTime)
 * @param includeTime - Whether to include time in the output (default: false)
 * @returns Formatted range string
 *
 * Examples:
 * - Same point: "2 Sept 2025" or "4:30pm, 2 Sept 2025"
 * - Same day: "4:30pm – 7:35pm, 2 Sept 2025"
 * - Same month: "3 – 5 Sept 2025"
 * - Same year: "28 Nov – 3 Dec 2025" or "4:35pm, 2 Oct – 7:10am, 11 Nov 2024"
 * - Different years: "30 Dec 2024 – 2 Jan 2025"
 */
export function formatDateTimeRange(
  start: import("@internationalized/date").ZonedDateTime,
  end: import("@internationalized/date").ZonedDateTime,
  includeTime = false,
): string {
  // Determine if we need to show minutes (if either time has non-zero minutes)
  const needMinutes = includeTime && (start.minute !== 0 || end.minute !== 0);

  // Helper to format time in 12-hour format (e.g., "4:30pm" or "4:00pm" if needMinutes)
  const formatTimeInner = (
    zdt: import("@internationalized/date").ZonedDateTime,
  ): string => {
    const hour = zdt.hour;
    const minute = zdt.minute;
    const period = hour >= 12 ? "pm" : "am";
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    // Include minutes if needed (either time has non-zero minutes)
    const minuteStr = needMinutes
      ? `:${String(minute).padStart(2, "0")}`
      : minute === 0
        ? ""
        : `:${String(minute).padStart(2, "0")}`;
    return `${displayHour}${minuteStr}${period}`;
  };

  // Helper to format month using locale (e.g., "Sep", "Oct")
  const formatMonth = (month: number): string => {
    const date = new Date(2000, month - 1, 1);
    return date.toLocaleDateString("en-AU", { month: "short" });
  };

  // Check if it's the same point in time
  if (start.compare(end) === 0) {
    if (includeTime) {
      return `${formatTimeInner(start)}, ${start.day} ${formatMonth(start.month)} ${start.year}`;
    }
    return `${start.day} ${formatMonth(start.month)} ${start.year}`;
  }

  const sameDay =
    start.year === end.year &&
    start.month === end.month &&
    start.day === end.day;
  const sameYear = start.year === end.year;

  if (includeTime) {
    if (sameDay) {
      // Same day, different times: "4:30pm – 7:35pm, 2 Sep 2025"
      return `${formatTimeInner(start)} – ${formatTimeInner(end)}, ${start.day} ${formatMonth(start.month)} ${start.year}`;
    } else if (sameYear) {
      // Different days, same year: "4:35pm, 2 Oct – 7:10am, 11 Nov 2024"
      return `${formatTimeInner(start)}, ${start.day} ${formatMonth(start.month)} – ${formatTimeInner(end)}, ${end.day} ${formatMonth(end.month)} ${end.year}`;
    } else {
      // Different years: "4:35pm, 30 Dec 2024 – 7:10am, 2 Jan 2025"
      return `${formatTimeInner(start)}, ${start.day} ${formatMonth(start.month)} ${start.year} – ${formatTimeInner(end)}, ${end.day} ${formatMonth(end.month)} ${end.year}`;
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
