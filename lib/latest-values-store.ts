/**
 * Clean interface for storing and retrieving latest values in KV cache
 *
 * This abstraction hides KV implementation details and provides a simple
 * key-value interface for "latest" values per system.
 */

import { kv, kvKey } from "./kv";

/**
 * A latest value entry stored in the cache
 */
export interface LatestValue {
  value: number | string; // Can be numeric or string (e.g., tariff period "pk")
  logicalPath: string; // Format: "path/metricType" (e.g., "bidi.grid.import/rate")
  measurementTimeMs: number; // When the value was measured
  receivedTimeMs: number; // When the value was received/cached (Unix timestamp)
  metricUnit: string; // Unit of measurement (e.g., "c/kWh", "%", "text")
  displayName: string; // Human-readable name
}

/**
 * Map of logicalPath to LatestValue
 */
export type LatestValuesMap = Record<string, LatestValue>;

/**
 * Get the KV key for a system's latest values
 */
function getLatestValuesKey(systemId: number): string {
  return kvKey(`latest:system:${systemId}`);
}

/**
 * Store multiple latest values for a system
 *
 * Values are merged with existing values (does not delete existing keys).
 * Uses Redis hash for efficient batch operations.
 *
 * @param systemId - System ID
 * @param values - Array of LatestValue objects to store
 */
export async function setLatestValues(
  systemId: number,
  values: LatestValue[],
): Promise<void> {
  if (values.length === 0) return;

  const key = getLatestValuesKey(systemId);

  // Convert array to hash fields (logicalPath -> LatestValue)
  const fields: Record<string, LatestValue> = {};
  for (const value of values) {
    fields[value.logicalPath] = value;
  }

  await kv.hset(key, fields);
}

/**
 * Get all latest values for a system
 *
 * @param systemId - System ID
 * @returns Map of logicalPath to LatestValue, or empty object if none cached
 */
export async function getLatestValues(
  systemId: number,
): Promise<LatestValuesMap> {
  const key = getLatestValuesKey(systemId);
  const values = await kv.hgetall(key);

  return (values as LatestValuesMap) || {};
}

/**
 * Get a single latest value by logicalPath
 *
 * @param systemId - System ID
 * @param logicalPath - The path to retrieve (e.g., "bidi.grid.import/rate")
 * @returns The LatestValue or null if not found
 */
export async function getLatestValue(
  systemId: number,
  logicalPath: string,
): Promise<LatestValue | null> {
  const key = getLatestValuesKey(systemId);
  const value = await kv.hget(key, logicalPath);

  return (value as LatestValue) || null;
}

/**
 * Clear all latest values for a system
 *
 * @param systemId - System ID
 */
export async function clearLatestValues(systemId: number): Promise<void> {
  const key = getLatestValuesKey(systemId);
  await kv.del(key);
}
