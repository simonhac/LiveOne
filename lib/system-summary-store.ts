/**
 * System Summary Store
 *
 * Stores pre-aggregated power/energy readings per system in a single Redis hash
 * for fast dashboard retrieval. This is IN ADDITION to the per-point
 * latest:system:{systemId} hashes.
 *
 * KV Key: {env}:system-summaries (Redis Hash)
 * Fields: System IDs (strings)
 * Values: SystemSummary objects
 */

import { kv, kvKey } from "./kv";
import { getLatestValues, LatestValuesMap } from "./latest-values-store";

/**
 * Summary readings for a system - fields are OMITTED when no data available
 */
export interface SystemSummaryReadings {
  /** Solar power in W - master value OR sum of children */
  "source.solar/power"?: number;
  /** Load power in W - master value OR sum of children */
  "load/power"?: number;
  /** Battery state of charge in % */
  "bidi.battery/soc"?: number;
  /** Grid power in W (positive = import, negative = export) */
  "bidi.grid/power"?: number;
}

/**
 * System summary stored in KV
 */
export interface SystemSummary {
  /** Unix timestamp in ms when readings were measured */
  measurementTimeMs: number;
  /** Aggregated readings - fields omitted when no data */
  readings: SystemSummaryReadings;
}

/**
 * Map of system ID to summary
 */
export type SystemSummariesMap = Record<string, SystemSummary>;

/**
 * Get the KV key for the system summaries hash
 */
function getSummariesKey(): string {
  return kvKey("system-summaries");
}

/**
 * Aggregate readings from point values into summary format
 *
 * Rules:
 * - source.solar/power: Use master if exists, else sum children source.solar.* /power
 * - load/power: Use master if exists, else sum children load.* /power
 * - bidi.battery/soc: Direct lookup
 * - bidi.grid/power: Direct lookup
 *
 * @param values - Array of {logicalPath, value} from point readings
 * @returns Aggregated readings (fields omitted if no matching data)
 */
export function aggregateSummaryReadings(
  values: Array<{ logicalPath: string; value: number }>,
): SystemSummaryReadings {
  const readings: SystemSummaryReadings = {};

  // Solar: master or sum children
  const solarMaster = values.find(
    (v) => v.logicalPath === "source.solar/power",
  );
  if (solarMaster) {
    readings["source.solar/power"] = solarMaster.value;
  } else {
    const solarChildren = values.filter(
      (v) =>
        v.logicalPath.startsWith("source.solar.") &&
        v.logicalPath.endsWith("/power"),
    );
    if (solarChildren.length > 0) {
      readings["source.solar/power"] = solarChildren.reduce(
        (sum, v) => sum + v.value,
        0,
      );
    }
  }

  // Load: master or sum children
  const loadMaster = values.find((v) => v.logicalPath === "load/power");
  if (loadMaster) {
    readings["load/power"] = loadMaster.value;
  } else {
    const loadChildren = values.filter(
      (v) =>
        v.logicalPath.startsWith("load.") && v.logicalPath.endsWith("/power"),
    );
    if (loadChildren.length > 0) {
      readings["load/power"] = loadChildren.reduce(
        (sum, v) => sum + v.value,
        0,
      );
    }
  }

  // Battery SOC: direct lookup
  const batterySOC = values.find((v) => v.logicalPath === "bidi.battery/soc");
  if (batterySOC) {
    readings["bidi.battery/soc"] = batterySOC.value;
  }

  // Grid power: direct lookup
  const gridPower = values.find((v) => v.logicalPath === "bidi.grid/power");
  if (gridPower) {
    readings["bidi.grid/power"] = gridPower.value;
  }

  return readings;
}

/**
 * Update system summary from point values
 *
 * @param systemId - System ID
 * @param values - Array of {logicalPath, value} from point readings
 * @param measurementTimeMs - Timestamp of the readings
 */
export async function updateSystemSummary(
  systemId: number,
  values: Array<{ logicalPath: string; value: number }>,
  measurementTimeMs: number,
): Promise<void> {
  if (values.length === 0) return;

  const readings = aggregateSummaryReadings(values);

  // Only store if we have at least one reading
  if (Object.keys(readings).length === 0) return;

  const summary: SystemSummary = {
    measurementTimeMs,
    readings,
  };

  const key = getSummariesKey();
  await kv.hset(key, { [systemId.toString()]: summary });
}

/**
 * Get summary for a single system
 *
 * @param systemId - System ID
 * @returns Summary or null if not cached
 */
export async function getSystemSummary(
  systemId: number,
): Promise<SystemSummary | null> {
  const key = getSummariesKey();
  const value = await kv.hget(key, systemId.toString());
  return (value as SystemSummary) || null;
}

/**
 * Get all system summaries in a single KV call
 *
 * @returns Map of system ID to summary, or empty object if none cached
 */
export async function getAllSystemSummaries(): Promise<SystemSummariesMap> {
  const key = getSummariesKey();
  const values = await kv.hgetall(key);
  return (values as SystemSummariesMap) || {};
}

/**
 * Get system summaries with pagination using HSCAN
 * Use for deployments with >100 systems
 *
 * @param cursor - Cursor from previous call, 0 for first call
 * @param count - Number of entries per page (default 100)
 * @returns Next cursor and summaries. Cursor is 0 when complete.
 */
export async function getSystemSummariesPaginated(
  cursor: number = 0,
  count: number = 100,
): Promise<{ cursor: number; summaries: SystemSummariesMap }> {
  const key = getSummariesKey();
  const [nextCursor, results] = await kv.hscan(key, cursor, { count });

  // HSCAN returns flat array: [field1, value1, field2, value2, ...]
  const summaries: SystemSummariesMap = {};
  for (let i = 0; i < results.length; i += 2) {
    const systemId = String(results[i]);
    const summary = results[i + 1] as unknown as SystemSummary;
    summaries[systemId] = summary;
  }

  return { cursor: Number(nextCursor), summaries };
}

/**
 * Clear summary for a system (e.g., when system is removed)
 *
 * @param systemId - System ID
 */
export async function clearSystemSummary(systemId: number): Promise<void> {
  const key = getSummariesKey();
  await kv.hdel(key, systemId.toString());
}

/**
 * Get the KV key for a system's subscription registry
 */
function getSubscriptionsKey(systemId: number): string {
  return kvKey(`subscriptions:system:${systemId}`);
}

/**
 * Get all composite system IDs that subscribe to a source system
 *
 * @param sourceSystemId - Source system ID
 * @returns Array of unique composite system IDs
 */
export async function getSubscriberSystemIds(
  sourceSystemId: number,
): Promise<number[]> {
  const key = getSubscriptionsKey(sourceSystemId);
  const entry = await kv.get<{
    pointSubscribers: Record<string, string[]>;
    lastUpdatedTimeMs: number;
  }>(key);

  if (!entry?.pointSubscribers) {
    return [];
  }

  // Extract unique composite system IDs from all point subscribers
  const subscriberIds = new Set<number>();
  for (const compositeRefs of Object.values(entry.pointSubscribers)) {
    for (const ref of compositeRefs) {
      // Parse "systemId.pointIndex" format
      const [systemIdStr] = ref.split(".");
      const systemId = parseInt(systemIdStr);
      if (!isNaN(systemId)) {
        subscriberIds.add(systemId);
      }
    }
  }

  return Array.from(subscriberIds);
}

/**
 * Update summary for a subscriber system using its current latest values
 *
 * @param subscriberSystemId - Composite system ID to update
 */
export async function updateSubscriberSummary(
  subscriberSystemId: number,
): Promise<void> {
  // Get latest values for the subscriber system
  const latestValues = await getLatestValues(subscriberSystemId);

  if (!latestValues || Object.keys(latestValues).length === 0) {
    return;
  }

  // Convert LatestValuesMap to values array for aggregation
  const values: Array<{ logicalPath: string; value: number }> = [];
  let maxTimestamp = 0;

  for (const entry of Object.values(latestValues)) {
    // Skip entries without logicalPath (stale cache data)
    if (entry && typeof entry.value === "number" && entry.logicalPath) {
      values.push({
        logicalPath: entry.logicalPath,
        value: entry.value,
      });
      if (entry.measurementTimeMs > maxTimestamp) {
        maxTimestamp = entry.measurementTimeMs;
      }
    }
  }

  if (values.length === 0 || maxTimestamp === 0) {
    return;
  }

  // Aggregate and update the summary
  const readings = aggregateSummaryReadings(values);

  if (Object.keys(readings).length === 0) {
    return;
  }

  const summary: SystemSummary = {
    measurementTimeMs: maxTimestamp,
    readings,
  };

  const key = getSummariesKey();
  await kv.hset(key, { [subscriberSystemId.toString()]: summary });
}

/**
 * Update summaries for all subscribers of a source system
 *
 * @param sourceSystemId - Source system ID
 */
export async function updateSubscriberSummaries(
  sourceSystemId: number,
): Promise<void> {
  const subscriberIds = await getSubscriberSystemIds(sourceSystemId);

  if (subscriberIds.length === 0) {
    return;
  }

  // Update each subscriber's summary in parallel
  await Promise.all(
    subscriberIds.map((subscriberId) =>
      updateSubscriberSummary(subscriberId).catch((err) =>
        console.error(
          `Failed to update summary for subscriber ${subscriberId}:`,
          err,
        ),
      ),
    ),
  );
}
