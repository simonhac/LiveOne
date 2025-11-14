import { kv, kvKey } from "./kv";
import { db } from "./db";
import { systems as systemsTable } from "./db/schema";
import { eq } from "drizzle-orm";
import { PointReference } from "./identifiers";

/**
 * Latest point value entry in cache
 */
export interface LatestPointValue {
  value: number;
  measurementTimeMs: number; // Unix timestamp in milliseconds
  receivedTimeMs: number; // Unix timestamp in milliseconds
  metricUnit: string; // Unit of measurement (e.g., "W", "kWh", "%")
}

/**
 * Map of point paths to their latest values
 * Key format: "type.subtype.extension/metricType" (e.g., "source.solar.local/power")
 */
export type LatestPointValues = Record<string, LatestPointValue>;

/**
 * Subscription registry entry
 */
export interface SubscriptionRegistryEntry {
  subscribers: number[]; // Array of composite system IDs
  lastUpdatedMs: number; // Unix timestamp in milliseconds when registry was last updated
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
 * Also updates all composite systems that subscribe to this point
 *
 * @param systemId - Source system ID
 * @param pointPath - Point path string (e.g., "source.solar.local/power")
 * @param value - Latest value
 * @param measurementTimeMs - Unix timestamp in milliseconds when value was measured
 * @param metricUnit - Unit of measurement (e.g., "W", "kWh", "%")
 */
export async function updateLatestPointValue(
  systemId: number,
  pointPath: string,
  value: number,
  measurementTimeMs: number,
  metricUnit: string,
): Promise<void> {
  const receivedTimeMs = Date.now();

  const pointValue: LatestPointValue = {
    value,
    measurementTimeMs,
    receivedTimeMs,
    metricUnit,
  };

  // Update source system's cache
  const key = getLatestValuesKey(systemId);
  await kv.hset(key, { [pointPath]: pointValue });

  // Look up composite systems that subscribe to this system
  const subscribers = await getSubscribers(systemId);

  // Update each composite system's cache
  if (subscribers && subscribers.length > 0) {
    const updates = subscribers.map((compositeId) => {
      const compositeKey = getLatestValuesKey(compositeId);
      return kv.hset(compositeKey, { [pointPath]: pointValue });
    });

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
): Promise<LatestPointValues> {
  const key = getLatestValuesKey(systemId);
  const values = await kv.hgetall(key);

  return (values as LatestPointValues) || {};
}

/**
 * Get the list of composite systems that subscribe to a source system
 *
 * @param sourceSystemId - Source system ID
 * @returns Array of composite system IDs
 */
async function getSubscribers(sourceSystemId: number): Promise<number[]> {
  const key = getSubscriptionsKey(sourceSystemId);
  const entry = await kv.get<SubscriptionRegistryEntry>(key);

  return entry?.subscribers || [];
}

/**
 * Build the subscription registry for all composite systems
 * This creates a reverse mapping: source system → composite systems that use it
 *
 * Should be called:
 * - On application startup
 * - When composite system metadata changes
 * - Periodically (e.g., daily) as a safety net
 */
export async function buildSubscriptionRegistry(): Promise<void> {
  // Query all composite systems
  const compositeSystems = await db
    .select()
    .from(systemsTable)
    .where(eq(systemsTable.vendorType, "composite"));

  // Build reverse mapping: sourceSystemId → [compositeIds]
  const subscriptions = new Map<number, Set<number>>();

  for (const composite of compositeSystems) {
    const metadata = composite.metadata as any;

    // Validate version 2 format
    if (!metadata || metadata.version !== 2 || !metadata.mappings) {
      continue;
    }

    // Extract all point references from mappings
    const pointRefs: string[] = [];
    for (const refs of Object.values(metadata.mappings)) {
      if (Array.isArray(refs)) {
        pointRefs.push(...(refs as string[]));
      }
    }

    // Parse point references to get source system IDs
    const sourceSystemIds = new Set<number>();
    for (const refStr of pointRefs) {
      const pointRef = PointReference.parse(refStr);
      if (pointRef) {
        sourceSystemIds.add(pointRef.systemId);
      }
    }

    // Add this composite to each source system's subscriber list
    for (const sourceId of sourceSystemIds) {
      if (!subscriptions.has(sourceId)) {
        subscriptions.set(sourceId, new Set());
      }
      subscriptions.get(sourceId)!.add(composite.id);
    }
  }

  // Write subscriptions to KV with timestamp
  const updates: Promise<any>[] = [];
  const now = Date.now();

  for (const [sourceId, compositeIds] of subscriptions.entries()) {
    const key = getSubscriptionsKey(sourceId);
    const entry: SubscriptionRegistryEntry = {
      subscribers: Array.from(compositeIds),
      lastUpdatedMs: now,
    };
    updates.push(kv.set(key, entry));
  }

  await Promise.all(updates);

  console.log(
    `Built subscription registry for ${subscriptions.size} source systems`,
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
