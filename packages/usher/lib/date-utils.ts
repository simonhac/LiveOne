/**
 * Format a Date object to a local datetime string with timezone offset
 * Format: YYYY-MM-DDTHH:mm:ss±HH:mm
 * Example: 2025-09-13T14:30:45+10:00
 */
export function formatLocalDateTime(date: Date): string {
  // Get timezone offset in minutes and convert to hours and minutes
  const offset = -date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  const offsetSign = offset >= 0 ? "+" : "-";
  const offsetString = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;

  // Format the date in local time
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetString}`;
}

/**
 * Format a date value that could be Date, string, or undefined
 * Returns formatted string or undefined
 */
export function formatDateValue(
  value: Date | string | undefined | null,
): string | undefined {
  if (!value) return undefined;

  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return undefined;

  return formatLocalDateTime(date);
}
