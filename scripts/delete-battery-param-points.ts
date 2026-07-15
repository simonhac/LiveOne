#!/usr/bin/env tsx
/**
 * Delete the LEGACY battery-provenance param points — round-trip-efficiency / usable-capacity /
 * charge-efficiency / idle-loss on each battery Area's helper device — plus their `area_bindings`
 * (ordinals 110-113) and their `point_readings_agg_5m` step rows, then rebuild the subscription
 * registry (removes the KV fan-out; stale KV latest entries age out).
 *
 * The learn now persists these params in `battery_provenance_daily` and nothing reads the points.
 * ⚠️ Run ONLY after `scripts/verify-daily-learn-equivalence.ts` has passed against the same DB —
 * the step rows are the equivalence baseline, so verification strictly precedes deletion. After this
 * has run, a code rollback needs a learn re-run to repopulate the points.
 *
 * DRY-RUN by default; pass --apply to delete. Target DB = whatever .env.local points at.
 *
 * Usage:
 *   npx tsx scripts/delete-battery-param-points.ts            # dry run
 *   npx tsx scripts/delete-battery-param-points.ts --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq, inArray, sql } from "drizzle-orm";
import { planetscaleDb } from "../lib/db/planetscale";
import {
  areaBindings,
  areaDevices,
  areas,
  pointInfo,
  pointReadingsAgg1d,
  pointReadingsAgg5m,
  systems,
} from "../lib/db/planetscale/schema";
import {
  EFFICIENCY_POINT,
  CAPACITY_POINT,
  CHARGE_EFFICIENCY_POINT,
  IDLE_LOSS_POINT,
} from "../lib/battery-provenance/register";
import { listBatteryProvenanceHandles } from "../lib/battery-provenance/recompute";
import { buildSubscriptionRegistry } from "../lib/kv-cache-manager";

const APPLY = process.argv.includes("--apply");
const PARAM_METRICS = [
  EFFICIENCY_POINT.metricType,
  CAPACITY_POINT.metricType,
  CHARGE_EFFICIENCY_POINT.metricType,
  IDLE_LOSS_POINT.metricType,
];
const BATTERY_STEM = "bidi.battery";

async function main() {
  const db = planetscaleDb;
  if (!db) throw new Error("No Postgres connection.");
  const [id]: any =
    (
      await db.execute(
        sql`select current_user as usr, current_database() as dbname`,
      )
    ).rows ?? [];
  console.log(
    `[DB] ${id?.usr}@${id?.dbname}  ${APPLY ? "[APPLY]" : "[DRY-RUN]"}`,
  );

  const handles = await listBatteryProvenanceHandles();
  console.log(
    `battery-bearing Area handles: ${handles.join(", ") || "(none)"}`,
  );

  let bindingsDeleted = 0;
  let pointsDeleted = 0;
  let rowsDeleted = 0;
  let dayRowsDeleted = 0;
  for (const handle of handles) {
    const [area] = await db
      .select({ id: areas.id, name: areas.displayName })
      .from(areas)
      .where(eq(areas.legacySystemId, handle))
      .limit(1);
    if (!area) continue;

    // The Area's helper device (owner of the param points).
    const [helper] = await db
      .select({ id: systems.id })
      .from(systems)
      .innerJoin(areaDevices, eq(areaDevices.systemId, systems.id))
      .where(
        and(eq(areaDevices.areaId, area.id), eq(systems.vendorType, "helper")),
      )
      .limit(1);
    if (!helper) {
      console.log(`handle ${handle} (${area.name}): no helper device — skip`);
      continue;
    }

    const points = await db
      .select({ index: pointInfo.index, metric: pointInfo.metricType })
      .from(pointInfo)
      .where(
        and(
          eq(pointInfo.systemId, helper.id),
          eq(pointInfo.logicalPathStem, BATTERY_STEM),
          inArray(pointInfo.metricType, PARAM_METRICS),
        ),
      );
    const pointIds = points.map((p) => p.index);

    // Count the step rows (for the report) before any deletion.
    let stepRows = 0;
    if (pointIds.length > 0) {
      const [{ n }]: any = (
        await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM point_readings_agg_5m
          WHERE system_id = ${helper.id} AND point_id IN (${sql.join(
            pointIds.map((p) => sql`${p}`),
            sql`, `,
          )})
        `)
      ).rows;
      stepRows = n ?? 0;
    }
    console.log(
      `handle ${handle} (${area.name}): helper=${helper.id} params=[${points
        .map((p) => p.metric)
        .join(", ")}] stepRows=${stepRows}`,
    );
    if (!APPLY || pointIds.length === 0) continue;

    // Atomic per Area: bindings → agg_5m → agg_1d → point_info. The param points are also
    // FK-referenced by point_readings_agg_1d, so those daily rows must go before the point.
    const { delBind, delRows, delDayRows, delPoints } = await db.transaction(
      async (tx) => {
        const delBind = await tx
          .delete(areaBindings)
          .where(
            and(
              eq(areaBindings.areaId, area.id),
              eq(areaBindings.role, "battery"),
              inArray(areaBindings.metricType, PARAM_METRICS),
            ),
          )
          .returning({ id: areaBindings.id });
        const delRows = await tx
          .delete(pointReadingsAgg5m)
          .where(
            and(
              eq(pointReadingsAgg5m.systemId, helper.id),
              inArray(pointReadingsAgg5m.pointId, pointIds),
            ),
          )
          .returning({ t: pointReadingsAgg5m.intervalEnd });
        const delDayRows = await tx
          .delete(pointReadingsAgg1d)
          .where(
            and(
              eq(pointReadingsAgg1d.systemId, helper.id),
              inArray(pointReadingsAgg1d.pointId, pointIds),
            ),
          )
          .returning({ day: pointReadingsAgg1d.day });
        const delPoints = await tx
          .delete(pointInfo)
          .where(
            and(
              eq(pointInfo.systemId, helper.id),
              inArray(pointInfo.index, pointIds),
            ),
          )
          .returning({ index: pointInfo.index });
        return { delBind, delRows, delDayRows, delPoints };
      },
    );
    bindingsDeleted += delBind.length;
    rowsDeleted += delRows.length;
    dayRowsDeleted += delDayRows.length;
    pointsDeleted += delPoints.length;
    console.log(
      `  deleted: bindings=${delBind.length} agg5mRows=${delRows.length} agg1dRows=${delDayRows.length} points=${delPoints.length}`,
    );
  }

  if (APPLY) {
    console.log(
      `TOTAL deleted: bindings=${bindingsDeleted} agg5mRows=${rowsDeleted} agg1dRows=${dayRowsDeleted} points=${pointsDeleted}`,
    );
    try {
      await buildSubscriptionRegistry();
      console.log("subscription registry rebuilt");
    } catch (e) {
      console.warn("subscription registry rebuild failed (rerun manually):", e);
    }
  } else {
    console.log("Dry run — pass --apply to delete.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
