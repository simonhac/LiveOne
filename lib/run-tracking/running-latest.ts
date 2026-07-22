/**
 * Publish each enabled device tracker's live "running" state into the generic KV latest map as a
 * derived `<role stem>/running` boolean point, so dashboards read run state from `/api/data` like
 * any other live value — instead of inferring it from the run-periods API response.
 *
 * Mirrors the HWS derived-point pattern (lib/hws/register.ts + recompute.ts): a normal `point_info`
 * row + a KV-latest write, no new table/migration, no point_readings history. Called from the
 * minutely run-periods cron AFTER reconcile; kept separate from recompute.ts to preserve its
 * "writes only device_run_periods" invariant. Best-effort per tracker (failures logged, not thrown).
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo } from "@/lib/db/planetscale/schema";
import { mintPointUid } from "@/lib/point/mint-point-uid";
import { updateLatestPointValue } from "@/lib/kv-cache-manager";
import { ROLES } from "@/lib/roles/registry";
import { listEnabledTrackers } from "./resolve";
import { isRunningNow } from "./live";
import {
  RUNNING_METRIC,
  RUNNING_UNIT,
  runningPathForRole,
} from "./running-point";

/**
 * Ensure a derived `<stem>/running` `point_info` row exists for `systemId`, returning its index
 * (the pointId used as the KV pointReference). Idempotent; inserts at the next free index. No
 * migration — `point_info` is a config table. Mirrors `ensureHwsTemperaturePoint`.
 */
async function ensureRunningPoint(
  systemId: number,
  stem: string,
  displayName: string,
): Promise<number> {
  const db = requirePlanetscaleDb();
  const [existing] = await db
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.logicalPathStem, stem),
        eq(pointInfo.metricType, RUNNING_METRIC),
      ),
    )
    .limit(1);
  if (existing) return existing.index;

  const all = await db
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));
  const nextIndex =
    all.length > 0 ? Math.max(...all.map((p) => p.index)) + 1 : 0;

  const physicalPathTail = `derived/${stem}/${RUNNING_METRIC}`;
  const [row] = await db
    .insert(pointInfo)
    .values({
      systemId,
      index: nextIndex,
      physicalPathTail,
      logicalPathStem: stem,
      metricType: RUNNING_METRIC,
      metricUnit: RUNNING_UNIT,
      defaultName: displayName,
      displayName,
      subsystem: null,
      transform: null,
      active: true,
      pointUid: await mintPointUid(systemId, physicalPathTail),
      createdAt: new Date(),
    })
    .returning({ index: pointInfo.index });
  return row.index;
}

/**
 * Write the live running state (1/0) of every enabled tracker to KV latest under
 * `<role stem>/running`. Returns how many trackers were published.
 */
export async function publishRunningLatest(
  nowMs: number,
): Promise<{ updated: number }> {
  const trackers = await listEnabledTrackers();
  let updated = 0;
  for (const t of trackers) {
    const stem = (ROLES as Record<string, { stem: string }>)[t.role]?.stem;
    const path = runningPathForRole(t.role);
    if (!stem || !path) continue; // role without a registry stem → skip
    try {
      const pointId = await ensureRunningPoint(t.systemId, stem, t.displayName);
      const running = await isRunningNow(t.systemId, t.role);
      await updateLatestPointValue(
        t.systemId,
        pointId,
        path,
        running ? 1 : 0,
        nowMs,
        nowMs,
        RUNNING_UNIT,
        t.displayName,
      );
      updated += 1;
    } catch (err) {
      console.error(
        `[RunTracking] publishRunningLatest failed for ${t.systemId}/${t.role}:`,
        err,
      );
    }
  }
  console.log(
    `[RunTracking] published running latest for ${updated} tracker(s)`,
  );
  return { updated };
}
