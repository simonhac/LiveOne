import { kv, kvKey } from "./kv";
import { db } from "./db";
import { systems as systemsTable } from "./db/schema";
import { pointInfo as pointInfoTable } from "./db/schema-monitoring-points";
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
 * Subscription registry entry - maps source point to composite points that subscribe to it
 */
export interface SubscriptionRegistryEntry {
  /**
   * Map of source point ID to array of composite point references that subscribe to it
   * Key: pointId (e.g., "1" for point with id=1)
   * Value: array of composite point references (format: "systemId.pointIndex")
   *
   * Example: { "1": ["100.0", "101.2"], "2": ["100.1"] }
   * Means: source point 1 is subscribed to by composite system 100 point 0 and composite system 101 point 2
   *        source point 2 is subscribed to by composite system 100 point 1
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
 * Also updates all composite systems that subscribe to this specific point
 *
 * @param systemId - Source system ID
 * @param pointId - Source point ID (database id/index)
 * @param pointPath - Point path string (e.g., "source.solar.local/power")
 * @param value - Latest value
 * @param measurementTimeMs - Unix timestamp in milliseconds when value was measured
 * @param metricUnit - Unit of measurement (e.g., "W", "kWh", "%")
 */
export async function updateLatestPointValue(
  systemId: number,
  pointId: number,
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

  // Look up composite points that subscribe to this specific source point
  const compositePointRefs = await getPointSubscribers(systemId, pointId);

  // Update each composite system's cache (only for subscribed points)
  if (compositePointRefs && compositePointRefs.length > 0) {
    // Group by composite system ID for efficient batching
    const updatesBySystem = new Map<number, Record<string, LatestPointValue>>();

    for (const compositePointRef of compositePointRefs) {
      // Parse composite point reference (e.g., "100.0" → systemId=100, pointIndex=0)
      const [compositeSystemIdStr] = compositePointRef.split(".");
      const compositeSystemId = parseInt(compositeSystemIdStr);

      if (!updatesBySystem.has(compositeSystemId)) {
        updatesBySystem.set(compositeSystemId, {});
      }

      // Add this point's value to the batch for this composite system
      updatesBySystem.get(compositeSystemId)![pointPath] = pointValue;
    }

    // Execute batched updates per composite system
    const updates = Array.from(updatesBySystem.entries()).map(
      ([compositeSystemId, pointValues]) => {
        const compositeKey = getLatestValuesKey(compositeSystemId);
        return kv.hset(compositeKey, pointValues);
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
): Promise<LatestPointValues> {
  const key = getLatestValuesKey(systemId);
  const values = await kv.hgetall(key);

  return (values as LatestPointValues) || {};
}

/**
 * Get point-specific subscribers for a source system point
 *
 * @param sourceSystemId - Source system ID
 * @param sourcePointId - Source point ID
 * @returns Array of composite point references (format: "systemId.pointIndex")
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
 * Build the subscription registry for all composite systems
 * This creates a reverse mapping: source point → composite points that subscribe to it
 *
 * Should be called:
 * - On application startup
 * - When composite system metadata changes
 * - Periodically (e.g., daily) as a safety net
 */
export async function buildSubscriptionRegistry(): Promise<void> {
  // Query all composite systems with their points
  const compositeSystems = await db
    .select()
    .from(systemsTable)
    .where(eq(systemsTable.vendorType, "composite"));

  // Build reverse mapping: sourceSystemId → { pointId → [compositePointRefs] }
  // Example: { 6: { "1": ["100.0", "101.2"], "2": ["100.1"] } }
  const subscriptions = new Map<number, Map<string, Set<string>>>();

  for (const composite of compositeSystems) {
    const metadata = composite.metadata as any;

    // Validate version 2 format
    if (!metadata || metadata.version !== 2 || !metadata.mappings) {
      continue;
    }

    // Get all points for this composite system to map array index to point info
    const compositePoints = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, composite.id))
      .orderBy(pointInfoTable.index);

    // Build map: sourcePointRef → compositePointIndex
    // For each category in mappings (solar, battery, etc.)
    let compositePointIndex = 0;
    for (const [, sourcePointRefs] of Object.entries(metadata.mappings)) {
      if (!Array.isArray(sourcePointRefs)) continue;

      for (const sourcePointRefStr of sourcePointRefs as string[]) {
        // Parse source point reference (e.g., "6.1" → systemId=6, pointId=1)
        const sourcePointRef = PointReference.parse(sourcePointRefStr);
        if (!sourcePointRef) {
          console.warn(`Invalid point reference: ${sourcePointRefStr}`);
          continue;
        }

        const sourceSystemId = sourcePointRef.systemId;
        const sourcePointId = sourcePointRef.pointId.toString();

        // Composite point reference (e.g., "100.0" for composite system 100, point index 0)
        const compositePointRef = `${composite.id}.${compositePointIndex}`;

        // Add to subscriptions map
        if (!subscriptions.has(sourceSystemId)) {
          subscriptions.set(sourceSystemId, new Map());
        }
        const sourceSystemMap = subscriptions.get(sourceSystemId)!;

        if (!sourceSystemMap.has(sourcePointId)) {
          sourceSystemMap.set(sourcePointId, new Set());
        }
        sourceSystemMap.get(sourcePointId)!.add(compositePointRef);

        compositePointIndex++;
      }
    }
  }

  // Write subscriptions to KV with timestamp
  const updates: Promise<any>[] = [];
  const now = Date.now();

  for (const [sourceSystemId, pointMap] of subscriptions.entries()) {
    const key = getSubscriptionsKey(sourceSystemId);

    // Convert Map<string, Set<string>> to Record<string, string[]>
    const pointSubscribers: Record<string, string[]> = {};
    for (const [pointId, compositeRefs] of pointMap.entries()) {
      pointSubscribers[pointId] = Array.from(compositeRefs);
    }

    const entry: SubscriptionRegistryEntry = {
      pointSubscribers,
      lastUpdatedTimeMs: now,
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
