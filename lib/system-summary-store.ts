/**
 * System Summary Store
 *
 * Stores pre-aggregated power/energy readings per subject in a single Redis hash
 * for fast dashboard retrieval. This is IN ADDITION to the per-point
 * latest:device:{dv_…} / latest:area:{ar_…} hashes.
 *
 * KV Key: {env}:system-summaries (Redis Hash) — the key name is unchanged.
 * Fields: `dv_…` / `ar_…` TypeIDs. **config-v4 Phase 13 PR 3 moved these off the integer handle.**
 *   The field names were the one integer-keyed KV family the Phase 13 brief almost missed; they are
 *   migrated rather than left behind, because the fan-out that writes a SUBSCRIBER's summary now names
 *   its subject with an `ar_` TypeID and keeping the field integer would have needed a reverse
 *   handle lookup on the hot path for no benefit.
 * Values: SystemSummary objects
 */

import { kv } from "./kv";
import {
  subscriptionsKey,
  summariesField,
  summariesKey,
  type KvAreaSubject,
} from "./kv-keys";
import {
  kvDeviceSubjectForHandle,
  kvSourceSubjectForHandle,
} from "./kv-subjects";
import {
  getLatestValuesForSubject,
  LatestValuesMap,
} from "./latest-values-store";
import { Area, type AreaId } from "@/lib/ids";
import { ROLE_IDS, ROLES } from "@/lib/roles/registry";

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
 * Map of subject TypeID (`dv_…` / `ar_…`) to summary
 */
export type SystemSummariesMap = Record<string, SystemSummary>;

/**
 * Aggregate readings from point values into summary format, driven by the role registry
 * (`lib/roles/registry.ts`). For each role with a `summary` config it emits `${stem}/${metric}`:
 *
 * - `aggregable` roles (solar, load): use the master point if present, else the sum of its dotted
 *   children (`${stem}.* /${metric}`).
 * - non-`aggregable` roles (battery soc, grid power): direct lookup of the single point.
 *
 * Roles without a `summary` config (ev) are not summarised. Fields are omitted when no data exists.
 *
 * @param values - Array of {logicalPath, value} from point readings
 * @returns Aggregated readings (fields omitted if no matching data)
 */
export function aggregateSummaryReadings(
  values: Array<{ logicalPath: string; value: number }>,
): SystemSummaryReadings {
  const readings = {} as Record<string, number>;

  for (const id of ROLE_IDS) {
    const role = ROLES[id];
    if (!role.summary) continue;
    const { metric, aggregable } = role.summary;
    const masterPath = `${role.stem}/${metric}`;

    const master = values.find((v) => v.logicalPath === masterPath);
    if (master) {
      readings[masterPath] = master.value;
    } else if (aggregable) {
      const children = values.filter(
        (v) =>
          v.logicalPath.startsWith(`${role.stem}.`) &&
          v.logicalPath.endsWith(`/${metric}`),
      );
      if (children.length > 0) {
        readings[masterPath] = children.reduce((sum, v) => sum + v.value, 0);
      }
    }
  }

  return readings as SystemSummaryReadings;
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

  // Device-first, with the same area fallback `updateLatestPointValue` uses, so a subject's summary
  // always lands beside the latest values it was aggregated from.
  const subject = await kvSourceSubjectForHandle(systemId);
  if (!subject) return;
  await kv.hset(summariesKey(), { [summariesField(subject)]: summary });
}

/**
 * Get summary for a single system, addressed by its integer handle.
 *
 * @param systemId - Integer addressing handle
 * @returns Summary or null if not cached
 */
export async function getSystemSummary(
  systemId: number,
): Promise<SystemSummary | null> {
  const subject = await kvSourceSubjectForHandle(systemId);
  if (!subject) return null;
  const value = await kv.hget(summariesKey(), summariesField(subject));
  return (value as SystemSummary) || null;
}

/**
 * Get all system summaries in a single KV call
 *
 * @returns Map of system ID to summary, or empty object if none cached
 */
export async function getAllSystemSummaries(): Promise<SystemSummariesMap> {
  const key = summariesKey();
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
  const key = summariesKey();
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
  const subject = await kvSourceSubjectForHandle(systemId);
  if (!subject) return;
  await kv.hdel(summariesKey(), summariesField(subject));
}

/**
 * The Areas that subscribe to a source device, from its `subscriptions:device:{dv_…}` entry.
 *
 * config-v4 Phase 13 PR 3: was `getSubscriberSystemIds`, returning integer handles parsed out of the
 * `"{areaHandle}.{ordinal}"` ref grammar with `ref.split(".")`. The grammar is gone — a ref IS the
 * subscriber's `ar_` TypeID — so the split, the `parseInt` and the `isNaN` guard go with it. A ref left
 * by a pre-PR-3 build fails `Area.is` and is dropped, so a stale entry degrades to "no subscribers".
 *
 * @param sourceSystemId - Source device's integer handle
 */
export async function getSubscriberAreaIds(
  sourceSystemId: number,
): Promise<AreaId[]> {
  const device = await kvDeviceSubjectForHandle(sourceSystemId);
  if (!device) return [];
  const entry = await kv.get<{
    pointSubscribers: Record<string, string[]>;
    lastUpdatedTimeMs: number;
  }>(subscriptionsKey(device.id));

  if (!entry?.pointSubscribers) {
    return [];
  }

  const areaIds = new Set<AreaId>();
  for (const subscriberRefs of Object.values(entry.pointSubscribers)) {
    for (const ref of subscriberRefs) {
      if (Area.is(ref)) areaIds.add(ref);
    }
  }

  return Array.from(areaIds);
}

/**
 * Update the summary for a subscriber AREA from the latest values in its own hash.
 *
 * Reads `latest:area:{ar_…}` directly (not the handle union): an Area's summary should describe the
 * Area's resolved point set, which is exactly what the fan-out materialises there. For every subscriber
 * that exists today this is value-identical to the pre-PR-3 union read, because every point in the
 * colliding case (handle 13) is bound into the Area anyway.
 */
export async function updateSubscriberSummary(
  area: KvAreaSubject,
): Promise<void> {
  const latestValues = await getLatestValuesForSubject(area);

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

  await kv.hset(summariesKey(), { [summariesField(area)]: summary });
}

/**
 * Update summaries for all Areas subscribing to a source device.
 *
 * @param sourceSystemId - Source device's integer handle
 */
export async function updateSubscriberSummaries(
  sourceSystemId: number,
): Promise<void> {
  const areaIds = await getSubscriberAreaIds(sourceSystemId);

  if (areaIds.length === 0) {
    return;
  }

  // Update each subscriber's summary in parallel
  await Promise.all(
    areaIds.map((id) =>
      updateSubscriberSummary({ kind: "area", id }).catch((err) =>
        console.error(`Failed to update summary for subscriber ${id}:`, err),
      ),
    ),
  );
}
