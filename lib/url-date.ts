/**
 * URL Date Encoding/Decoding Utilities
 *
 * Converts between ISO timestamps and URL-friendly local time formats.
 * - 1D/7D Format: YYYY-MM-DD_HH.MM (e.g., "2025-11-02_14.15")
 * - 30D Format: YYYY-MM-DD (e.g., "2025-11-07")
 */

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
