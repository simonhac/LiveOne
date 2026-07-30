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
import { latestValuesKey, type KvSubject } from "./kv-keys";
import { kvSubjectsForHandle } from "./kv-subjects";

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
  /**
   * Source device handle (`devices.rid`) — the fact consumers used to split out of `pointReference`.
   *
   * ⚠️ **PERSISTED in KV, and deliberately UNCHANGED by the Phase 13 PR 3 keyspace move** (name, type
   * and meaning all identical). It is a payload field, not part of any key: nothing about the
   * `latest:device:{dv_…}` / `latest:area:{ar_…}` rename requires it to move, and changing it would (a)
   * invalidate the field in every entry written by an older build, for which readers have no
   * discriminator (unlike `pointReference`, whose `pt_…` and `"9.7"` grammars are mutually
   * unambiguous — an integer here stays a valid integer), and (b) change `/api/data`'s readings rows,
   * which put it on the wire verbatim. It retires with the integer handle itself, in PR 6/Phase 14.
   */
  sourceSystemId?: number;
  sessionId?: string; // Session ID that wrote this value (UUIDv7 text)
  sessionLabel?: string; // Session label/name for display
}

/**
 * Map of logicalPath to LatestValue
 */
export type LatestValuesMap = Record<string, LatestValue>;

/**
 * Get all latest values for ONE subject's hash.
 *
 * This is the ONLY reader of the latest-values hash. `kv-cache-manager.getLatestPointValues` was a
 * byte-identical second copy of it (same key builder, same `hgetall`, same cast) and is gone.
 */
export async function getLatestValuesForSubject(
  subject: KvSubject,
): Promise<LatestValuesMap> {
  const values = await kv.hgetall(latestValuesKey(subject));
  return (values as LatestValuesMap) || {};
}

/**
 * Get all latest values addressed by an integer handle — the **union over every subject that handle
 * names**, device leg last (so a device's own direct reading wins a logicalPath tie over a propagated
 * copy).
 *
 * 🛑 The union is what makes the PR 3 keyspace split behaviour-preserving: before it, a handle's two
 * legs shared one `latest:system:N` hash, so that hash *was* the union. See `lib/kv-subjects.ts` for the
 * worked case (handle 13 = device Kutis + 3-member Area Kutis, whose 12-field hash is 6 of the device's
 * own points and 6 propagated from device 16).
 *
 * The extra hash reads are issued concurrently, so wall-clock latency is unchanged, and at most two
 * are ever issued (a handle has at most two legs).
 *
 * @param systemId - Integer addressing handle
 * @returns Map of logicalPath to LatestValue, or empty object if none cached
 */
export async function getLatestValues(
  systemId: number,
): Promise<LatestValuesMap> {
  const subjects = await kvSubjectsForHandle(systemId);
  if (subjects.length === 0) return {};
  if (subjects.length === 1) return getLatestValuesForSubject(subjects[0]);

  const maps = await Promise.all(subjects.map(getLatestValuesForSubject));
  return Object.assign({}, ...maps) as LatestValuesMap;
}
