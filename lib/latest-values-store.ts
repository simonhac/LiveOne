/**
 * Clean interface for storing and retrieving latest values in KV cache
 *
 * This abstraction hides KV implementation details and provides a simple
 * key-value interface for "latest" values per system.
 *
 * This module owns the {@link LatestValue} SHAPE and the read/write primitives over the latest-values
 * hash. It does NOT own the key string — `lib/kv-keys.ts` does, for every family (it used to hold a
 * second, independent copy of the `latest:system:N` builder; see that module's header for why that is
 * a silent-cache-split hazard rather than harmless duplication).
 */

import { kv } from "./kv";
import { latestValuesKey } from "./kv-keys";

/**
 * A latest value entry stored in the cache
 */
export interface LatestValue {
  value: number | string | null; // Can be numeric or string (for text/json types)
  logicalPath: string; // Format: "path/metricType" (e.g., "bidi.grid.import/rate")
  measurementTimeMs: number; // When the value was measured
  receivedTimeMs: number; // When the value was received/cached (Unix timestamp)
  metricUnit: string; // Unit of measurement (e.g., "c/kWh", "%", "text", "json")
  displayName: string; // Human-readable name
  /**
   * The source point's `pt_` TypeID (e.g. "pt_01k9…"). Was `"{systemId}.{pointIndex}"` until the
   * config-v4 pre-terminal prep — the index half came from `point_info.index`, which `points` has no
   * counterpart to, so the terminal drop would have made the value unreproducible.
   *
   * ⚠️ PERSISTED in KV. Entries written by an older build still hold the old grammar; readers must
   * treat an unrecognised shape as absent rather than parse it. Active points are rewritten on the
   * next poll; a cold rebuild is `npm run db:rebuild-dev-kv` (dev).
   */
  pointReference?: string;
  /** Source device handle (`devices.rid`) — the fact consumers used to split out of `pointReference`. */
  sourceSystemId?: number;
  sessionId?: string; // Session ID that wrote this value (UUIDv7 text)
  sessionLabel?: string; // Session label/name for display
}

/**
 * Map of logicalPath to LatestValue
 */
export type LatestValuesMap = Record<string, LatestValue>;

/**
 * Get all latest values for a system.
 *
 * This is the ONLY reader of the latest-values hash. `kv-cache-manager.getLatestPointValues` was a
 * byte-identical second copy of it (same key builder, same `hgetall`, same cast) and is gone.
 *
 * @param systemId - System ID
 * @returns Map of logicalPath to LatestValue, or empty object if none cached
 */
export async function getLatestValues(
  systemId: number,
): Promise<LatestValuesMap> {
  const key = latestValuesKey(systemId);
  const values = await kv.hgetall(key);

  return (values as LatestValuesMap) || {};
}
