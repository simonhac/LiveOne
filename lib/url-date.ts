/**
 * URL Date Encoding/Decoding Utilities
 *
 * Converts between ISO timestamps and URL-friendly local time formats.
 * Format: YYYY-MM-DD_HH.MM (e.g., "2025-11-02_14.15")
 */

/**
 * Encode an ISO timestamp and timezone offset into a URL-friendly format
 *
 * @param isoTimestamp - ISO 8601 timestamp (e.g., "2025-11-02T14:15:00Z")
 * @param timezoneOffsetMin - Timezone offset in minutes (e.g., 600 for AEST)
 * @returns URL-friendly date string (e.g., "2025-11-02_14.15")
 */
export function encodeUrlDate(
  isoTimestamp: string,
  timezoneOffsetMin: number,
): string {
  const date = new Date(isoTimestamp);

  // Apply timezone offset to get local time
  const localTime = new Date(date.getTime() + timezoneOffsetMin * 60 * 1000);

  // Format as YYYY-MM-DD_HH.MM
  const year = localTime.getUTCFullYear();
  const month = String(localTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localTime.getUTCDate()).padStart(2, "0");
  const hours = String(localTime.getUTCHours()).padStart(2, "0");
  const minutes = String(localTime.getUTCMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}_${hours}.${minutes}`;
}

/**
 * Decode a URL-friendly date string back to ISO timestamp
 *
 * @param urlDate - URL-friendly date string (e.g., "2025-11-02_14.15")
 * @param timezoneOffsetMin - Timezone offset in minutes (e.g., 600 for AEST)
 * @returns ISO 8601 timestamp string
 */
export function decodeUrlDate(
  urlDate: string,
  timezoneOffsetMin: number,
): string {
  // Parse YYYY-MM-DD_HH.MM
  const [datePart, timePart] = urlDate.split("_");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hours, minutes] = timePart.split(".").map(Number);

  // Create date in UTC representing the local time
  const localTime = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

  // Convert back to UTC by subtracting the timezone offset
  const utcTime = new Date(localTime.getTime() - timezoneOffsetMin * 60 * 1000);

  return utcTime.toISOString();
}

/**
 * Encode timezone offset for URL
 *
 * @param offsetMinutes - Offset in minutes (e.g., 600)
 * @returns URL-friendly offset string (e.g., "600m")
 */
export function encodeUrlOffset(offsetMinutes: number): string {
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
