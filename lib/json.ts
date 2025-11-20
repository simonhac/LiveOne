/**
 * JSON utilities for client and server
 * - Client: Auto-parse ISO8601 dates when deserializing API responses
 * - Server: Auto-format dates to ISO8601 and rename timestamp fields when serializing
 */

import { NextResponse } from "next/server";
import { formatTime_fromJSDate } from "./date-utils";
import { CalendarDate } from "@internationalized/date";

// ============================================================================
// CLIENT-SIDE: JSON Deserialization with Date Parsing
// ============================================================================

/**
 * ISO8601 date pattern with timezone
 * Matches: YYYY-MM-DDTHH:MM:SS+HH:MM (e.g., "2025-11-15T05:57:03+10:00")
 */
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/**
 * JSON revivor that automatically converts ISO8601 date strings to Date objects
 *
 * Usage:
 * ```typescript
 * const response = await fetch('/api/data');
 * const text = await response.text();
 * const data = JSON.parse(text, iso8601Revivor);
 * ```
 *
 * Or use the parseJsonWithDates helper:
 * ```typescript
 * const response = await fetch('/api/data');
 * const data = await parseJsonWithDates(response);
 * ```
 */
export function iso8601Revivor(_key: string, value: any): any {
  if (typeof value === "string" && ISO8601_PATTERN.test(value)) {
    return new Date(value);
  }
  return value;
}

/**
 * Helper to parse JSON response with automatic date conversion
 * Use this instead of response.json() to get Date objects for ISO8601 timestamps
 */
export async function parseJsonWithDates(response: Response): Promise<any> {
  const text = await response.text();
  return JSON.parse(text, iso8601Revivor);
}

// ============================================================================
// SERVER-SIDE: JSON Serialization with Date Formatting
// ============================================================================

/**
 * Default timezone offset for AEST formatting (10 hours = 600 minutes)
 */
const DEFAULT_TIMEZONE_OFFSET_MIN = 600;

/**
 * Transform object to convert Unix timestamp fields to formatted dates and rename them
 * - Fields ending in "TimeMs" are converted to ISO8601 dates and renamed (remove "Ms" suffix)
 * - Date objects are converted to AEST formatted ISO8601 strings
 * - CalendarDate objects are converted to ISO8601 date strings (YYYY-MM-DD)
 */
function transformDates(obj: any, timezoneOffsetMin: number): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle Date objects
  if (obj instanceof Date) {
    return formatTime_fromJSDate(obj, timezoneOffsetMin);
  }

  // Handle CalendarDate objects (must check before generic objects)
  if (obj instanceof CalendarDate) {
    return obj.toString();
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => transformDates(item, timezoneOffsetMin));
  }

  // Handle objects
  if (typeof obj === "object") {
    const transformed: any = {};

    for (const [key, value] of Object.entries(obj)) {
      // Check if this is a Unix timestamp field that needs conversion
      if (key.endsWith("TimeMs") && typeof value === "number") {
        // Convert to date and rename field (remove "Ms" suffix)
        const newKey = key.slice(0, -2); // Remove "Ms" from end
        const date = new Date(value);
        transformed[newKey] = formatTime_fromJSDate(date, timezoneOffsetMin);
      } else {
        // Recursively transform nested objects
        transformed[key] = transformDates(value, timezoneOffsetMin);
      }
    }

    return transformed;
  }

  // Return primitives as-is
  return obj;
}

/**
 * Transform data for storage in database
 * Similar to transformDates but doesn't create NextResponse
 * Use this when storing JSON in database fields
 *
 * @param data - Data to transform
 * @param timezoneOffsetMin - Timezone offset in minutes (default: 600 = AEST)
 * @returns Transformed data ready for JSON.stringify
 */
export function transformForStorage(
  data: any,
  timezoneOffsetMin: number = DEFAULT_TIMEZONE_OFFSET_MIN,
): any {
  return transformDates(data, timezoneOffsetMin);
}

/**
 * Create a NextResponse with JSON body that auto-formats dates to AEST ISO8601
 *
 * This automatically:
 * - Converts Date objects to ISO8601 strings with timezone
 * - Renames fields ending in "TimeMs" to remove the "Ms" suffix
 * - Converts Unix timestamps (in *TimeMs fields) to ISO8601 date strings
 *
 * @param data - Data to serialize
 * @param timezoneOffsetMin - Timezone offset in minutes (default: 600 = AEST)
 * @param init - Optional ResponseInit options
 *
 * @example
 * ```typescript
 * return jsonResponse({
 *   points: {
 *     "solar/power": {
 *       value: 5000,
 *       measurementTimeMs: 1731627423000,  // Will become "measurementTime": "2025-11-15T05:57:03+10:00"
 *       receivedTimeMs: 1731627425000      // Will become "receivedTime": "2025-11-15T05:57:05+10:00"
 *     }
 *   }
 * }, system.timezoneOffsetMin);
 * ```
 */
export function jsonResponse(
  data: any,
  timezoneOffsetMin: number = DEFAULT_TIMEZONE_OFFSET_MIN,
  init?: ResponseInit,
): NextResponse {
  // Transform the data to convert timestamps and rename fields
  const transformed = transformDates(data, timezoneOffsetMin);

  // Serialize to JSON
  const jsonString = JSON.stringify(transformed);

  return new NextResponse(jsonString, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}
