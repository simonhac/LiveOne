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
import { summariesField, summariesKey } from "./kv-keys";
import { kvSourceSubjectForHandle } from "./kv-subjects";
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
 * Clear summary for a system (e.g., when system is removed)
 *
 * @param systemId - System ID
 *
 * @knipignore No caller — the eviction half of a cache nothing currently evicts.
 */
export async function clearSystemSummary(systemId: number): Promise<void> {
  const subject = await kvSourceSubjectForHandle(systemId);
  if (!subject) return;
  await kv.hdel(summariesKey(), summariesField(subject));
}
