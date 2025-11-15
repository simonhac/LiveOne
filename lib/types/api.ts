/**
 * Shared TypeScript types for API responses
 *
 * Note: The API uses jsonResponse() which automatically transforms:
 * - measurementTimeMs -> measurementTime (formatted as ISO8601 AEST string)
 * - receivedTimeMs -> receivedTime (formatted as ISO8601 AEST string)
 *
 * On the client side, JSON.parse with ISO8601 revivor will deserialize these strings back to Date objects.
 */

/**
 * Point value as returned by API endpoints and deserialized on client
 *
 * Backend sends ISO8601 strings, client's JSON revivor deserializes to Date objects.
 */
export interface LatestPointValue {
  value: number;
  measurementTime: Date; // Auto-deserialized from ISO8601 string by JSON revivor
  receivedTime: Date; // Auto-deserialized from ISO8601 string by JSON revivor
  metricUnit: string; // Unit of measurement (e.g., "W", "kWh", "%")
}

/**
 * Map of point paths to their latest values (API response format)
 * Key format: "type.subtype.extension/metricType" (e.g., "source.solar.local/power")
 */
export type LatestPointValues = Record<string, LatestPointValue>;
