/**
 * Frontend date formatting utilities
 * Provides consistent date/time formatting across all UI components
 */

/**
 * Format a date/time for display in the UI
 * Returns time in 12-hour format with no leading zero and lowercase am/pm
 * Date in short month format
 *
 * @param date - Date to format (Date object or ISO string)
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
  } = {}
): {
  time: string;
  date: string;
  isToday: boolean;
  display: string; // Combined display string
} {
  const { includeSeconds = true, includeDate = true } = options;

  // Convert to Date object if string
  const dateObj = typeof date === 'string' ? new Date(date) : date;

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

  const period = hours >= 12 ? 'pm' : 'am';
  const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;

  // Build time string
  let timeStr = `${displayHour}:${minutes.toString().padStart(2, '0')}`;
  if (includeSeconds) {
    timeStr += `:${seconds.toString().padStart(2, '0')}`;
  }
  timeStr += `\u00A0${period}`; // Non-breaking space before am/pm

  // Format date (short month)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
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
    display
  };
}

/**
 * Format just the time portion
 * @param date - Date to format
 * @param includeSeconds - Whether to include seconds
 * @returns Formatted time string
 */
export function formatTime(date: Date | string, includeSeconds = true): string {
  return formatDateTime(date, { includeSeconds, includeDate: false }).time;
}

/**
 * Format just the date portion
 * @param date - Date to format
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
 * - < 1s: "250ms"
 * - 1-60s: "1.5s"
 * - > 60s: "2m 15s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    // Show one decimal place for seconds
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    if (remainingMinutes > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (remainingHours > 0) {
    return `${days}d ${remainingHours}h`;
  }
  return `${days}d`;
}

/**
 * Format a relative time (e.g., "5 minutes ago", "in 2 hours")
 * @param date - Date to compare to now
 * @returns Relative time string
 */
export function formatRelativeTime(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const absDiffMs = Math.abs(diffMs);

  // Less than a minute
  if (absDiffMs < 60000) {
    const seconds = Math.floor(absDiffMs / 1000);
    if (seconds < 5) {
      return 'just now';
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