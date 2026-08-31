/**
 * Rebuild the derived tables for one device's days — the SCOPED alternative to `aggregateRange`.
 *
 * `aggregateRange` is the nightly fleet sweep: it rebuilds `agg_1d` for every device over the range,
 * then re-runs HWS, battery learning, provenance, run periods and two backlog reheal passes — most
 * of them from the range start to NOW, and none of them scoped to a device. That is the right shape
 * for `cron/daily`. It is the wrong shape for a backfill that touched one device on a handful of
 * days: measured on prod, a ONE-DAY Sigenergy backfill spent the route's entire 300 s `maxDuration`
 * in it and returned an empty response, every run.
 *
 * The work that actually follows from "these device-days changed" is what the coverage-repair runner
 * has always done, and this is that logic lifted out of it so both callers share one implementation:
 *
 *  1. `agg_1d` for each touched (device, day).
 *  2. For each Area the device's points bind into: refresh the attributed flow matrix
 *     (`flow_attr_1d`) over the span of those days, re-folding the battery blend first where the
 *     Area has one.
 *
 * ⚠️ It deliberately does NOT run the reheal passes. Those exist to find days that went stale for
 * reasons NOT connected to this run — a `FLOW_ATTR_VERSION` bump, a late Amber revision — and
 * sweeping the whole fleet's backlog is `cron/daily`'s job, not a per-backfill cost.
 *
 * ⚠️ Best-effort throughout, per the runner it came from: a failure recomputing one day or one Area
 * is logged and the rest proceed. The nightly sweep is the backstop for anything missed here.
 */
import { sql } from "drizzle-orm";
import { parseDate } from "@internationalized/date";
import type { planetscaleDb } from "@/lib/db/planetscale";
import { recomputeAgg1dForDay } from "@/lib/db/planetscale/aggregate-points-pg";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import { learnAllForHandle } from "@/lib/db/planetscale/battery-provenance-daily-pg";
import { recomputeBatteryProvenanceForWindow } from "@/lib/db/planetscale/battery-provenance-pg";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";

type PgDb = NonNullable<typeof planetscaleDb>;

/** What `recomputeAgg1dForDay` needs, and all this module needs of a device. */
export interface ScopedRecomputeDevice {
  id: number;
  timezoneOffsetMin: number;
}

export interface ScopedRecomputeResult {
  agg1dDays: number;
  provenanceAreas: number;
}

/**
 * The Areas a device's points bind into.
 *
 * ⚠️ HAND-WRITTEN `sql` — invisible to `tsc`, and its failure mode is silent under-resolution (no
 * Areas found → no flow refresh, no error). The device test goes through the binding's `point_uid`,
 * hopping `points.device_id → devices.rid` (the seam invariant `devices.rid == systems.id`).
 *
 * ⚠️ `handle` comes from `legacy_handles`, NOT the dropped `areas.legacy_system_id`. Because this is
 * raw SQL a stale column name would be a RUNTIME 42703 swallowed into "no areas found" — so this
 * path must be exercised, not merely compiled. LEFT JOIN, not JOIN: the loop below relies on
 * `handle == null` to skip, so an Area without a handle must survive the join rather than vanish.
 * `legacy_handles.area_id` is uniquely indexed, so the join cannot fan the `DISTINCT` out.
 */
async function areasForDevice(
  db: PgDb,
  systemId: number,
): Promise<
  { id: string; handle: number | null; tz: number; isBattery: boolean }[]
> {
  const res = await db.execute(sql`
    SELECT DISTINCT a.id,
           lh.handle AS handle,
           a.timezone_offset_min AS tz,
           EXISTS (SELECT 1 FROM area_bindings b2
                   WHERE b2.area_id = a.id AND b2.role='battery' AND b2.metric_type='power') AS is_battery
    FROM area_bindings b
    JOIN areas a ON a.id = b.area_id
    LEFT JOIN legacy_handles lh ON lh.area_id = a.id
    JOIN points p ON p.id = b.point_uid
    JOIN devices d ON d.id = p.device_id
    WHERE d.rid = ${systemId}
  `);
  return (res.rows ?? []).map((r) => ({
    id: String((r as { id: unknown }).id),
    handle:
      (r as { handle: unknown }).handle == null
        ? null
        : Number((r as { handle: unknown }).handle),
    tz: Number((r as { tz: unknown }).tz),
    isBattery: Boolean((r as { is_battery: unknown }).is_battery),
  }));
}

/**
 * Recompute `agg_1d` and the per-Area flow matrix for `days` (local "YYYY-MM-DD") of one device.
 *
 * `label` only prefixes log lines, so a failure can be traced to the caller that asked for it.
 */
export async function recomputeDerivedForDeviceDays(
  db: PgDb,
  device: ScopedRecomputeDevice,
  days: readonly string[],
  nowMs: number,
  label = "ScopedRecompute",
): Promise<ScopedRecomputeResult> {
  const out: ScopedRecomputeResult = { agg1dDays: 0, provenanceAreas: 0 };
  if (days.length === 0) return out;

  for (const day of days) {
    try {
      await recomputeAgg1dForDay(db, device, parseDate(day));
      out.agg1dDays++;
    } catch (err) {
      console.error(
        `[${label}] agg_1d recompute failed sys=${device.id} day=${day}:`,
        err,
      );
    }
  }

  let areaRows: Awaited<ReturnType<typeof areasForDevice>> = [];
  try {
    areaRows = await areasForDevice(db, device.id);
  } catch (err) {
    console.error(`[${label}] area lookup failed sys=${device.id}:`, err);
  }

  const sorted = [...days].sort();
  for (const area of areaRows) {
    if (area.handle == null) continue;
    try {
      const ls = await resolveLogicalSystem(area.handle);
      if (!ls || !ls.isComplete) continue;
      // Battery Areas re-fold the blend first — best-effort, so a learn hiccup cannot block the
      // flow refresh; battery-less Areas get the energy + grid/solar attribution rollup only.
      if (area.isBattery) {
        try {
          await learnAllForHandle(db, area.handle, nowMs, { rebuild: false });
        } catch (err) {
          console.error(
            `[${label}] battery learn failed area=${area.id}:`,
            err,
          );
        }
      }
      const [winStartSec] = dayToUnixRangeForAggregation(
        parseDate(sorted[0]),
        area.tz,
      );
      const [, winEndSec] = dayToUnixRangeForAggregation(
        parseDate(sorted[sorted.length - 1]),
        area.tz,
      );
      await recomputeBatteryProvenanceForWindow(
        db,
        area.handle,
        winStartSec * 1000,
        winEndSec * 1000,
        { writeRollup: true, writeCheckpoints: true, updateLatest: false },
      );
      out.provenanceAreas++;
    } catch (err) {
      console.error(`[${label}] flow refresh failed area=${area.id}:`, err);
    }
  }
  return out;
}
