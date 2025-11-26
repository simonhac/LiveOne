/**
 * Shared TypeScript types for API responses
 *
 * Note: The API uses jsonResponse() which automatically transforms:
 * - measurementTimeMs -> measurementTime (formatted as ISO8601 AEST string)
 *
 * On the client side, JSON.parse with ISO8601 revivor will deserialize these strings back to Date objects.
 */

// Re-export backend types for convenience
export type { LatestValue, LatestValuesMap } from "@/lib/latest-values-store";

/**
 * Point value as returned by /api/data endpoint and deserialized on client
 *
 * This type is for the dashboard which only uses numeric power/energy values.
 * For the full LatestValue type (supporting strings), use LatestValue from latest-values-store.
 *
 * Backend sends ISO8601 strings, client's JSON revivor deserializes to Date objects.
 */
export interface LatestPointValue {
  value: number;
  logicalPath: string;
  measurementTime: Date; // Auto-deserialized from ISO8601 string by JSON revivor
  metricUnit: string; // Unit of measurement (e.g., "W", "kWh", "%")
  displayName: string; // Display name from point_info
}

/**
 * Map of point paths to their latest values (API response format)
 * Key format: "type.subtype.extension/metricType" (e.g., "source.solar.local/power")
 */
export type LatestPointValues = Record<string, LatestPointValue>;
