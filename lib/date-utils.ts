import { parseAbsolute, toZoned } from '@internationalized/date';

/**
 * Format a Date to AEST/AEDT timezone string without milliseconds
 * @param date - JavaScript Date object
 * @returns ISO string with timezone offset (e.g., "2025-08-16T20:36:41+10:00")
 */
export function formatToAEST(date: Date): string {
  // Convert JavaScript Date to ISO string, then parse as an absolute date
  const isoString = date.toISOString();
  const absoluteDate = parseAbsolute(isoString, 'UTC');
  
  // Convert to AEST/AEDT (Australia/Sydney handles DST automatically)
  const zonedDate = toZoned(absoluteDate, 'Australia/Sydney');
  
  // Format as ISO string with timezone offset
  // The toString() method returns format like: 2025-08-16T20:36:41.999+10:00[Australia/Sydney]
  const fullString = zonedDate.toString();
  
  // Extract just the date, time and offset (remove timezone name and milliseconds)
  const match = fullString.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{3})?([\+\-]\d{2}:\d{2})/);
  if (match) {
    return match[1] + match[2];
  }
  
  // Fallback (shouldn't happen)
  return date.toISOString().slice(0, 19) + '+10:00';
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
 * Round a number to 3 decimal places
 * @param value - Number to round
 * @returns Rounded number or null if input is null/undefined
 */
export function roundToThree(value: number | null | undefined): number | null {
  return value != null ? Math.round(value * 1000) / 1000 : null;
}