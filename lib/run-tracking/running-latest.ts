/**
 * Publish each enabled run detector's live "running" state into the generic KV latest map as a
 * derived `<role stem>/running` boolean point, so dashboards read run state from `/api/data` like
 * any other live value — instead of inferring it from the run-periods API response.
 *
 * Mirrors the HWS derived-point pattern (lib/hws/register.ts + recompute.ts): a normal `point_info`
 * row + a KV-latest write, no new table/migration, no point_readings history. Called from the
 * minutely derivations cron AFTER reconcile; kept separate from recompute.ts to preserve its
 * "writes only derived_intervals" invariant. Best-effort per detector (failures logged, not thrown).
 *
 * `point_info` and the KV keyspace stay integer-addressed until Phase 13, so this still writes
 * under the detector's `legacyHandle` — byte-identical to the pre-derivations behaviour.
 */
import { findPointByStemMetric, mintPoint } from "@/lib/point/mint-point";
import { updateLatestPointValue } from "@/lib/kv-cache-manager";
import { ROLES } from "@/lib/roles/registry";
import { listEnabledRunDetectors } from "@/lib/derivations/resolve";
import { isRunningNow } from "./live";
import {
  RUNNING_METRIC,
  RUNNING_UNIT,
  runningPathForRole,
} from "./running-point";

/**
 * Ensure a derived `<stem>/running` `point_info` row exists for `systemId`, returning its index
 * (the pointId used as the KV pointReference) AND its uuid (the KV subscription-map key). Idempotent.
 * No migration — `point_info` is a config table. Mirrors `ensureHwsTemperaturePoint`.
 */
async function ensureRunningPoint(
  systemId: number,
  stem: string,
  displayName: string,
): Promise<{ index: number; pointUid: string }> {
  const existing = await findPointByStemMetric(systemId, stem, RUNNING_METRIC);
  if (existing) return existing;

  // config-v4 slice M: `mintPoint` owns identity + index (points-primary). The max(index)+1 scan this
  // replaced never mirrored into `points`, so it was a live C7 hole.
  return mintPoint(systemId, {
    physicalPathTail: `derived/${stem}/${RUNNING_METRIC}`,
    logicalPathStem: stem,
    metricType: RUNNING_METRIC,
    metricUnit: RUNNING_UNIT,
    defaultName: displayName,
  });
}

/**
 * Write the live running state (1/0) of every enabled run detector to KV latest under
 * `<role stem>/running`. Returns how many detectors were published.
 */
export async function publishRunningLatest(
  nowMs: number,
): Promise<{ updated: number }> {
  const detectors = await listEnabledRunDetectors();
  let updated = 0;
  for (const t of detectors) {
    const stem = (ROLES as Record<string, { stem: string }>)[t.role]?.stem;
    const path = runningPathForRole(t.role);
    if (!stem || !path) continue; // role without a registry stem → skip
    try {
      const point = await ensureRunningPoint(t.legacyHandle, stem, t.name);
      const running = await isRunningNow(t.id);
      await updateLatestPointValue(
        t.legacyHandle,
        point.pointUid,
        path,
        running ? 1 : 0,
        nowMs,
        nowMs,
        RUNNING_UNIT,
        t.name,
      );
      updated += 1;
    } catch (err) {
      console.error(
        `[RunTracking] publishRunningLatest failed for ${t.legacyHandle}/${t.role}:`,
        err,
      );
    }
  }
  console.log(
    `[RunTracking] published running latest for ${updated} detector(s)`,
  );
  return { updated };
}
