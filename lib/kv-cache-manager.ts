import { kv, kvKey } from "./kv";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { LatestValue, LatestValuesMap } from "./latest-values-store";
import { getAreaBindings } from "@/lib/areas/bindings";
import { getBindinglessAreaMemberPoints } from "@/lib/areas/devices";

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
   * Map of source point ID to array of subscriber point references that subscribe to it
   * Key: pointId (e.g., "1" for point with id=1)
   * Value: array of subscriber point references (format: "systemId.pointIndex")
   *
   * Example: { "1": ["100.0", "101.2"], "2": ["100.1"] }
   * Means: source point 1 is subscribed to by subscriber system 100 point 0 and subscriber system 101 point 2
   *        source point 2 is subscribed to by subscriber system 100 point 1
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
 * @param systemId - Source system ID
 * @param pointId - Source point ID (database id/index)
 * @param pointPath - Point path string (e.g., "source.solar.local/power")
 * @param value - Latest value (numeric or string for text/json types)
 * @param measurementTimeMs - Unix timestamp in milliseconds when value was measured
 * @param receivedTimeMs - Unix timestamp in milliseconds when value was received from vendor
 * @param metricUnit - Unit of measurement (e.g., "W", "kWh", "%", "text", "json")
 * @param displayName - Display name from point_info
 * @param _sourceSystemName - DEPRECATED: No longer stored (pointReference encodes systemId)
 * @param sessionId - Session ID that wrote this value
 * @param sessionLabel - Session label/name for display
 */
export async function updateLatestPointValue(
  systemId: number,
  pointId: number,
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
    pointReference: `${systemId}.${pointId}`,
    ...(sessionId && { sessionId }),
    ...(sessionLabel && { sessionLabel }),
  };

  // Update source system's cache
  const key = getLatestValuesKey(systemId);
  await kv.hset(key, { [pointPath]: pointValue });

  // Look up subscriber points that subscribe to this specific source point
  const subscriberPointRefs = await getPointSubscribers(systemId, pointId);

  // Update each subscriber system's cache (only for subscribed points)
  if (subscriberPointRefs && subscriberPointRefs.length > 0) {
    // Group by subscriber system ID for efficient batching
    const updatesBySystem = new Map<number, Record<string, LatestValue>>();

    for (const subscriberPointRef of subscriberPointRefs) {
      // Parse subscriber point reference (e.g., "100.0" → systemId=100, pointIndex=0)
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
 * @param sourceSystemId - Source system ID
 * @param sourcePointId - Source point ID
 * @returns Array of subscriber point references (format: "systemId.pointIndex")
 */
async function getPointSubscribers(
  sourceSystemId: number,
  sourcePointId: number,
): Promise<string[]> {
  const key = getSubscriptionsKey(sourceSystemId);
  const entry = await kv.get<SubscriptionRegistryEntry>(key);

  if (!entry?.pointSubscribers) {
    return [];
  }

  return entry.pointSubscribers[sourcePointId.toString()] || [];
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
/** Insert one (source point → subscriber point ref) edge into the reverse-subscription map. */
function addSubscription(
  subscriptions: Map<number, Map<string, Set<string>>>,
  sourceSystemId: number,
  sourcePointId: string,
  subscriberPointRef: string,
): void {
  if (!subscriptions.has(sourceSystemId)) {
    subscriptions.set(sourceSystemId, new Map());
  }
  const sourceSystemMap = subscriptions.get(sourceSystemId)!;
  if (!sourceSystemMap.has(sourcePointId)) {
    sourceSystemMap.set(sourcePointId, new Set());
  }
  sourceSystemMap.get(sourcePointId)!.add(subscriberPointRef);
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
      b.pointSystemId,
      b.pointId.toString(),
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
      m.pointSystemId,
      m.pointId.toString(),
      `${m.handle}.${ord}`,
    );
  }
  return subscriptions;
}

export async function buildSubscriptionRegistry(): Promise<void> {
  // Build reverse mapping: sourceSystemId → { pointId → [subscriberPointRefs] }
  // Example: { 6: { "1": ["100.0", "101.2"], "2": ["100.1"] } }
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
    for (const [pointId, subscriberRefs] of pointMap.entries()) {
      pointSubscribers[pointId] = Array.from(subscriberRefs);
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
