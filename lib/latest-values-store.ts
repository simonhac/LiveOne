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
 * How long a chain winner's last measurement stays authoritative before a lower-priority binding is
 * allowed to answer for its path.
 *
 * 15 minutes = the 5-minute standard slot × `DEVICE_STALE_SLOTS` (3), the threshold this codebase
 * already uses for "that device has stopped, as opposed to blipped"
 * (`lib/monitoring/device-staleness.ts`). Deliberately ONE constant rather than a per-vendor budget:
 * the question here is not "is this device healthy" — the monitor owns that — but "has the preferred
 * instrument gone quiet long enough that showing the other one is the better answer".
 */
export const CHAIN_FALLBACK_STALE_MS = 15 * 60_000;

/**
 * The latest-hash field a chain FALLBACK publishes under: `"{path}#{rank}"`, rank ≥ 1.
 *
 * The winner keeps the bare path, so nothing about an uncontended Area's hash changes. Separating
 * the fields — rather than having the fallback's writer decide whether to overwrite the winner — is
 * what keeps the ingest path free of a read-modify-write: every writer writes its own field,
 * unconditionally, and precedence is settled at READ time, which is also the only moment staleness
 * can honestly be judged.
 *
 * `#` cannot occur in a real field name: a field is `"{logical_path}/{metric_type}"`, and both halves
 * are dotted/kebab identifiers.
 */
export function chainFallbackField(path: string, rank: number): string {
  return rank === 0 ? path : `${path}#${rank}`;
}

const CHAIN_FIELD = /^(.+)#(\d+)$/;

/**
 * Collapse chain fallback fields into the paths they stand in for.
 *
 * Precedence: the best-ranked candidate whose measurement is within
 * {@link CHAIN_FALLBACK_STALE_MS}; if NONE is fresh, the best-ranked one present. That second clause
 * is what makes this degrade rather than disappear — a site that is wholly offline still reports its
 * winner's last value, exactly as before chains existed, instead of silently promoting an equally
 * dead fallback.
 *
 * Exported for tests; `getLatestValuesForSubject` is the only production caller.
 */
export function resolveChainFields(
  raw: LatestValuesMap,
  nowMs: number,
): LatestValuesMap {
  const ranked = new Map<string, Array<{ rank: number; value: LatestValue }>>();
  for (const [field, value] of Object.entries(raw)) {
    const match = CHAIN_FIELD.exec(field);
    if (!match) continue;
    const [, path, rank] = match;
    const list = ranked.get(path);
    const entry = { rank: Number(rank), value };
    if (list) list.push(entry);
    else ranked.set(path, [entry]);
  }
  // Overwhelmingly the common case: no Area has a contended path, so this costs one regex per field.
  if (ranked.size === 0) return raw;

  const out: LatestValuesMap = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!CHAIN_FIELD.test(field)) out[field] = value;
  }
  for (const [path, fallbacks] of ranked) {
    const candidates = fallbacks.slice();
    const winner = raw[path];
    if (winner) candidates.push({ rank: 0, value: winner });
    candidates.sort((a, b) => a.rank - b.rank);
    const fresh = candidates.find(
      (c) =>
        typeof c.value?.measurementTimeMs === "number" &&
        nowMs - c.value.measurementTimeMs <= CHAIN_FALLBACK_STALE_MS,
    );
    const chosen = fresh ?? candidates[0];
    if (chosen) out[path] = chosen.value;
  }
  return out;
}

/**
 * Get all latest values for ONE subject's hash.
 *
 * This is the ONLY reader of the latest-values hash. `kv-cache-manager.getLatestPointValues` was a
 * byte-identical second copy of it (same key builder, same `hgetall`, same cast) and is gone. That
 * sole-reader property is what lets {@link resolveChainFields} run here and nowhere else: no other
 * consumer can see a `#`-suffixed field, so the fallback grammar never reaches a wire or a UI.
 */
export async function getLatestValuesForSubject(
  subject: KvSubject,
): Promise<LatestValuesMap> {
  const values = await kv.hgetall(latestValuesKey(subject));
  return resolveChainFields((values as LatestValuesMap) || {}, Date.now());
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
