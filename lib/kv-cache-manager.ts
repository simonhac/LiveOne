import { kv, kvKey } from "./kv";
import { Point } from "@/lib/ids";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { LatestValue, LatestValuesMap } from "./latest-values-store";
import { getAreaBindings } from "@/lib/areas/bindings";
import { getBindinglessAreaMemberPoints } from "@/lib/areas/members";

// Re-export canonical types for backwards compatibility
export type { LatestValue, LatestValuesMap };

/**
 * @deprecated Use LatestValue instead
 */
export type LatestPointValue = LatestValue;

/**
 * @deprecated Use LatestValuesMap instead
 */
export type LatestPointValues = LatestValuesMap;

/**
 * Subscription registry entry - maps source point to subscriber points that subscribe to it
 */
export interface SubscriptionRegistryEntry {
  /**
   * Map of source point UUID to array of subscriber point references that subscribe to it.
   * Key: `point_info.point_uid` (canonical uuid) — NOT the integer point index. Config-v4 slice E
   * PR 2b re-keyed this map when `area_bindings` lost its `(point_system_id, point_id)` pair.
   * Value: array of SUBSCRIBER references, `"{areaHandle}.{ordinal}"` — an AREA handle and a binding
   * ordinal, NOT a `point_info.index`. It never was one, so the pre-terminal retirement of the
   * `"{systemId}.{pointIndex}"` POINT address left this untouched; only the `.` split for the handle
   * half is read (`updateLatestPointValue`, `system-summary-store.getSubscriberSystemIds`) and the
   * ordinal half is vestigial (a subscriber's latest hash is keyed by logicalPath).
   *
   * Example: { "0199…-…": ["100.0", "101.2"] }
   *
   * NOTE (deliberate, not an oversight): the enclosing `subscriptions:system:N` / `latest:system:N`
   * KV keys are STILL integer-addressed. They move in Phase 13 with `systems.id`.
   */
  pointSubscribers: Record<string, string[]>;
  lastUpdatedTimeMs: number; // Unix timestamp in milliseconds when registry was last updated
}

/**
 * Get the KV key for a system's latest point values
 */
function getLatestValuesKey(systemId: number): string {
  return kvKey(`latest:system:${systemId}`);
}

/**
 * Get the KV key for a system's subscription registry
 */
function getSubscriptionsKey(systemId: number): string {
  return kvKey(`subscriptions:system:${systemId}`);
}

/**
 * Update the latest value for a point in a system's cache
 * Also updates all subscriber systems that subscribe to this specific point
 *
 * @param systemId - Source device handle: the `latest:system:N` hash key AND the stored
 *                   `sourceSystemId` (integer until Phase 13 retires the keyspace)
 * @param pointUid - Source point's `point_info.point_uid` — the subscription-map lookup key AND, as a
 *                   `pt_` TypeID, the stored `pointReference`
 * @param pointPath - Point path string (e.g., "source.solar.local/power")
 * @param value - Latest value (numeric or string for text/json types)
 * @param measurementTimeMs - Unix timestamp in milliseconds when value was measured
 * @param receivedTimeMs - Unix timestamp in milliseconds when value was received from vendor
 * @param metricUnit - Unit of measurement (e.g., "W", "kWh", "%", "text", "json")
 * @param displayName - Display name from point_info
 * @param _sourceSystemName - DEPRECATED: no longer stored (`sourceSystemId` identifies the source)
 * @param sessionId - Session ID that wrote this value
 * @param sessionLabel - Session label/name for display
 */
export async function updateLatestPointValue(
  systemId: number,
  pointUid: string,
  pointPath: string,
  value: number | string | null,
  measurementTimeMs: number,
  receivedTimeMs: number,
  metricUnit: string,
  displayName: string,
  _sourceSystemName?: string,
  sessionId?: string,
  sessionLabel?: string,
): Promise<void> {
  const pointValue: LatestValue = {
    value,
    logicalPath: pointPath,
    measurementTimeMs,
    receivedTimeMs,
    metricUnit,
    displayName,
    // config-v4 pre-terminal prep: `pointReference` was `"{systemId}.{pointIndex}"`. Its index half
    // came from `point_info.index`, which `points` has no counterpart to, so the terminal drop would
    // have made the value unreproducible. It is now the point's `pt_` TypeID — the locked public ID
    // scheme, not a second bespoke grammar — and the source DEVICE, the only fact any consumer
    // actually derived from the old string, moves to its own field. The two grammars are mutually
    // unambiguous (`pt_…` vs `"9.7"`), so a stale KV entry written by an older build can never be
    // mis-parsed as the new one; it simply reads as absent.
    pointReference: Point.encode(pointUid),
    sourceSystemId: systemId,
    ...(sessionId && { sessionId }),
    ...(sessionLabel && { sessionLabel }),
  };

  // Update source system's cache
  const key = getLatestValuesKey(systemId);
  await kv.hset(key, { [pointPath]: pointValue });

  // Look up subscriber points that subscribe to this specific source point
  const subscriberPointRefs = await getPointSubscribers(systemId, pointUid);

  // Update each subscriber system's cache (only for subscribed points)
  if (subscriberPointRefs && subscriberPointRefs.length > 0) {
    // Group by subscriber system ID for efficient batching
    const updatesBySystem = new Map<number, Record<string, LatestValue>>();

    for (const subscriberPointRef of subscriberPointRefs) {
      // Parse the subscriber reference (e.g., "100.0" → area handle 100). The ordinal half is unused.
      const [subscriberSystemIdStr] = subscriberPointRef.split(".");
      const subscriberSystemId = parseInt(subscriberSystemIdStr);

      if (!updatesBySystem.has(subscriberSystemId)) {
        updatesBySystem.set(subscriberSystemId, {});
      }

      // Add this point's value to the batch for this subscriber system
      updatesBySystem.get(subscriberSystemId)![pointPath] = pointValue;
    }

    // Execute batched updates per subscriber system
    const updates = Array.from(updatesBySystem.entries()).map(
      ([subscriberSystemId, pointValues]) => {
        const subscriberKey = getLatestValuesKey(subscriberSystemId);
        return kv.hset(subscriberKey, pointValues);
      },
    );

    await Promise.all(updates);
  }
}

/**
 * Get all latest point values for a system
 *
 * @param systemId - System ID
 * @returns Map of point paths to their latest values
 */
export async function getLatestPointValues(
  systemId: number,
): Promise<LatestValuesMap> {
  const key = getLatestValuesKey(systemId);
  const values = await kv.hgetall(key);

  return (values as LatestValuesMap) || {};
}

/**
 * Get point-specific subscribers for a source system point
 *
 * @param sourceSystemId - Source system ID (selects the `subscriptions:system:N` KV entry)
 * @param sourcePointUid - Source point's `point_info.point_uid`
 * @returns Array of subscriber references (format: "{areaHandle}.{ordinal}")
 */
async function getPointSubscribers(
  sourceSystemId: number,
  sourcePointUid: string,
): Promise<string[]> {
  const key = getSubscriptionsKey(sourceSystemId);
  const entry = await kv.get<SubscriptionRegistryEntry>(key);

  if (!entry?.pointSubscribers) {
    return [];
  }

  return entry.pointSubscribers[sourcePointUid] || [];
}

/**
 * Build the subscription registry for all subscriber systems
 * This creates a reverse mapping: source point → subscriber points that subscribe to it
 *
 * Should be called:
 * - On application startup
 * - When subscriber system metadata changes
 * - Periodically (e.g., daily) as a safety net
 */
/**
 * Insert one (source point → subscriber point ref) edge into the reverse-subscription map. The map is
 * `sourceSystemId → sourcePointUid → subscriberPointRefs`: the outer key is still the integer system
 * (it is the KV key) but the inner key is the point's uuid.
 */
function addSubscription(
  subscriptions: Map<number, Map<string, Set<string>>>,
  sourceSystemId: number,
  sourcePointUid: string,
  subscriberPointRef: string,
): void {
  if (!subscriptions.has(sourceSystemId)) {
    subscriptions.set(sourceSystemId, new Map());
  }
  const sourceSystemMap = subscriptions.get(sourceSystemId)!;
  if (!sourceSystemMap.has(sourcePointUid)) {
    sourceSystemMap.set(sourcePointUid, new Set());
  }
  sourceSystemMap.get(sourcePointUid)!.add(subscriberPointRef);
}

/**
 * Reverse-subscription map (source point → subscribing areas-backed handle). Two sources, unioned:
 * (1) typed `area_bindings` for curated multi-device Areas (every existing subscriber); (2) the member
 * devices' own points for **binding-less** multi-device Areas (union-default — empty for today's data,
 * since both prod subscribers have bindings). Together this is "the area's resolved point set", in SQL.
 */
async function buildSubscriptionsFromBindings(): Promise<
  Map<number, Map<string, Set<string>>>
> {
  const subscriptions = new Map<number, Map<string, Set<string>>>();
  for (const b of await getAreaBindings()) {
    addSubscription(
      subscriptions,
      b.sourceSystemId,
      b.pointUid,
      `${b.handle}.${b.ordinal}`,
    );
  }
  // Binding-less multi-device Areas: fan out each member device's own points to the handle. The ref's
  // index half is vestigial (latest is keyed by logicalPath), so a per-handle running ordinal is fine.
  const ordByHandle = new Map<number, number>();
  for (const m of await getBindinglessAreaMemberPoints()) {
    const ord = ordByHandle.get(m.handle) ?? 0;
    ordByHandle.set(m.handle, ord + 1);
    addSubscription(
      subscriptions,
      m.sourceSystemId,
      m.pointUid,
      `${m.handle}.${ord}`,
    );
  }
  return subscriptions;
}

export async function buildSubscriptionRegistry(): Promise<void> {
  // Build reverse mapping: sourceSystemId → { sourcePointUid → [subscriberPointRefs] }
  // Example: { 6: { "0199a1…": ["100.0", "101.2"] } }
  // ⚠️ Re-running this is REQUIRED after deploying slice E PR 2b: entries written by an earlier build
  // are keyed by the integer point index and will never match a uuid lookup.
  // Edges come from the typed area_bindings (the authoritative subscriber role→point mapping). The
  // subscriberPointRef's index half is vestigial (updateLatestPointValue keys the subscriber's latest
  // hash by logicalPath, not by index).
  const subscriptions = await buildSubscriptionsFromBindings();

  // First, scan for existing subscription keys and delete any that are no longer needed
  const pattern = kvKey("subscriptions:system:*");
  const existingKeys = await kv.keys(pattern);
  const validSystemIds = new Set(subscriptions.keys());

  // Delete stale subscription keys (systems that no longer have subscribers)
  const deletions: Promise<any>[] = [];
  for (const existingKey of existingKeys) {
    // Extract system ID from key (e.g., "dev:subscriptions:system:10001" -> 10001)
    const match = existingKey.match(/subscriptions:system:(\d+)$/);
    if (match) {
      const existingSystemId = parseInt(match[1], 10);
      if (!validSystemIds.has(existingSystemId)) {
        console.log(
          `[SubscriptionRegistry] Deleting stale subscription key for system ${existingSystemId}`,
        );
        deletions.push(kv.del(existingKey));
      }
    }
  }
  await Promise.all(deletions);

  // Write subscriptions to KV with timestamp
  const updates: Promise<any>[] = [];
  const now = Date.now();

  for (const [sourceSystemId, pointMap] of subscriptions.entries()) {
    const key = getSubscriptionsKey(sourceSystemId);

    // Convert Map<string, Set<string>> to Record<string, string[]>
    const pointSubscribers: Record<string, string[]> = {};
    for (const [pointUid, subscriberRefs] of pointMap.entries()) {
      pointSubscribers[pointUid] = Array.from(subscriberRefs);
    }

    const entry: SubscriptionRegistryEntry = {
      pointSubscribers,
      lastUpdatedTimeMs: now,
    };
    updates.push(kv.set(key, entry));
  }

  await Promise.all(updates);

  console.log(
    `Built subscription registry for ${subscriptions.size} source systems (deleted ${deletions.length} stale entries)`,
  );
}

/**
 * Invalidate the subscription registry for a specific system or all systems
 *
 * @param systemId - Optional system ID. If provided, only that system's subscriptions are cleared.
 *                   If omitted, all subscription keys are deleted (requires rebuild).
 */
export async function invalidateSubscriptionRegistry(
  systemId?: number,
): Promise<void> {
  if (systemId) {
    // Delete specific subscription key
    const key = getSubscriptionsKey(systemId);
    await kv.del(key);
  } else {
    // Delete all subscription keys
    // Note: This requires scanning all keys with pattern "subscriptions:system:*"
    // In practice, it's better to just rebuild the registry
    console.warn(
      "Full subscription registry invalidation requested - rebuilding is recommended",
    );
    await buildSubscriptionRegistry();
  }
}
