/**
 * Daily (1d) point aggregation — Postgres only.
 *
 * Replaces the former legacy SQLite writer (removed in the Phase 5 decommission
 * of the legacy store). The daily cron computes each
 * system/day's 1d aggregates in Postgres from PG `point_readings_agg_5m` via
 * `recomputeAgg1dForDay`, and materialises the energy-flow matrix per logical
 * system. Idempotent: re-running a day just heals it.
 */
import { and, asc, gte, lte } from "drizzle-orm";
import { CalendarDate } from "@internationalized/date";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/planetscale/schema";
import { getYesterdayInTimezone, getTodayInTimezone } from "@/lib/date-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { recomputeAgg1dForDay } from "@/lib/db/planetscale/aggregate-points-pg";
import { recomputeRange as recomputeRunPeriodsRange } from "@/lib/run-tracking/recompute";
import { recomputeRange as recomputeHwsTemperatureRange } from "@/lib/hws/recompute";
import {
  recomputeRange as recomputeBatteryProvenanceRange,
  rehealStaleAttrDays,
  learnForAllHandles,
  REHEAL_TRAILING_MS,
} from "@/lib/battery-provenance/recompute";

// Earliest date for point data aggregation (when point data collection began)
const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

/** Earliest `point_readings_agg_5m` interval (epoch-ms), or null if empty. */
async function earliestAgg5mMs(): Promise<number | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ intervalEnd: pointReadingsAgg5m.intervalEnd })
    .from(pointReadingsAgg5m)
    .orderBy(asc(pointReadingsAgg5m.intervalEnd))
    .limit(1);
  return row ? row.intervalEnd.getTime() : null;
}

/** Distinct system ids with `agg_5m` data at/after `sinceMs`. */
async function systemIdsWithAgg5mSince(sinceMs: number): Promise<number[]> {
  const rows = await requirePlanetscaleDb()
    .selectDistinct({ systemId: pointReadingsAgg5m.systemId })
    .from(pointReadingsAgg5m)
    .where(gte(pointReadingsAgg5m.intervalEnd, new Date(sinceMs)));
  return rows.map((r) => r.systemId);
}

/** Resolve the timezone offset of the first active system (for today/yesterday math). */
async function firstSystemTimezoneOffsetMin(): Promise<number> {
  const systems = await SystemsManager.getInstance().getActiveSystems();
  if (systems.length === 0) throw new Error("No systems found");
  return systems[0].timezoneOffsetMin;
}

/**
 * Delete daily aggregations for a date range (all systems) from Postgres.
 * @param start - Start date (inclusive) or null for earliest available
 * @param end - End date (inclusive) or null for latest available
 */
export async function deleteRange(
  start: CalendarDate | null,
  end: CalendarDate | null,
) {
  let queryCount = 0;
  const db = requirePlanetscaleDb();

  let startDate: CalendarDate;
  let endDate: CalendarDate;

  if (start === null && end === null) {
    const earliestMs = await earliestAgg5mMs();
    queryCount++;
    if (earliestMs === null) {
      throw new Error("No 5-minute point data found");
    }
    const earliestDate = new Date(earliestMs);
    startDate = new CalendarDate(
      earliestDate.getFullYear(),
      earliestDate.getMonth() + 1,
      earliestDate.getDate(),
    );
    endDate = getTodayInTimezone(await firstSystemTimezoneOffsetMin());
  } else if (start === null || end === null) {
    throw new Error(
      "Both start and end must be null, or both must be provided",
    );
  } else {
    startDate = start;
    endDate = end;
  }

  const startStr = startDate.toString();
  const endStr = endDate.toString();

  console.log(
    `[Daily Points] Deleting aggregations from ${startStr} to ${endStr}`,
  );

  const existingRows = await db
    .select({ day: pointReadingsAgg1d.day })
    .from(pointReadingsAgg1d)
    .where(
      and(
        gte(pointReadingsAgg1d.day, startStr),
        lte(pointReadingsAgg1d.day, endStr),
      ),
    );
  queryCount++;
  const rowsToDelete = existingRows.length;

  await db
    .delete(pointReadingsAgg1d)
    .where(
      and(
        gte(pointReadingsAgg1d.day, startStr),
        lte(pointReadingsAgg1d.day, endStr),
      ),
    );
  queryCount++;

  console.log(
    `[Daily Points] Deleted ${rowsToDelete} aggregation rows from ${startStr} to ${endStr}`,
  );

  return {
    startDate: startStr,
    endDate: endStr,
    rowsDeleted: rowsToDelete,
    queryCount,
    message: `Deleted ${rowsToDelete} aggregation rows from ${startStr} to ${endStr}`,
  };
}

/**
 * Aggregate daily point data for a date range (all systems) in Postgres.
 * @param start - Start date (inclusive) or null for earliest available
 * @param end - End date (inclusive) or null for latest available
 */
export async function aggregateRange(
  start: CalendarDate | null,
  end: CalendarDate | null,
) {
  let queryCount = 0;

  let startDate: CalendarDate;
  let endDate: CalendarDate;

  if (start === null && end === null) {
    const earliestMs = await earliestAgg5mMs();
    queryCount++;
    if (earliestMs === null) {
      throw new Error("No 5-minute point data found");
    }
    const earliestDate = new Date(earliestMs);
    startDate = new CalendarDate(
      earliestDate.getFullYear(),
      earliestDate.getMonth() + 1,
      earliestDate.getDate(),
    );
    endDate = getYesterdayInTimezone(await firstSystemTimezoneOffsetMin());
  } else if (start === null || end === null) {
    throw new Error(
      "Both start and end must be null, or both must be provided",
    );
  } else {
    startDate = start;
    endDate = end;
  }

  const startStr = startDate.toString();
  const endStr = endDate.toString();

  console.log(
    `[Daily Points] Aggregating date range from ${startStr} to ${endStr}`,
  );

  const rangeStartMs = new Date(startStr).getTime();
  const systemIds = await systemIdsWithAgg5mSince(rangeStartMs);
  queryCount++;

  if (systemIds.length === 0) {
    console.log("[Daily Points] No systems with data in the specified range");
    return {
      startDate: startStr,
      endDate: endStr,
      systemsProcessed: 0,
      daysAggregated: 0,
      pointsAggregated: 0,
      rowsCreated: 0,
      queryCount,
      results: [],
    };
  }

  console.log(`[Daily Points] Found ${systemIds.length} systems to process`);

  // Generate list of all days in range
  const allDays: CalendarDate[] = [];
  let currentDate = startDate;
  while (currentDate.compare(endDate) <= 0) {
    allDays.push(currentDate);
    currentDate = currentDate.add({ days: 1 });
  }

  console.log(`[Daily Points] Aggregating ${allDays.length} days`);

  const db = requirePlanetscaleDb();
  const systemsManager = SystemsManager.getInstance();
  const results = [];
  let totalPoints = 0;
  let totalRowsCreated = 0;

  for (const systemId of systemIds) {
    const system = await systemsManager.getSystem(systemId);
    if (!system) {
      console.warn(
        `[Daily Points] System ${systemId} not in the registry — skipping its 1d aggregation.`,
      );
      continue;
    }

    let aggregatedCount = 0;
    for (const day of allDays) {
      try {
        const { rowsUpserted } = await recomputeAgg1dForDay(db, system, day);
        queryCount++;
        aggregatedCount += rowsUpserted;
      } catch (error) {
        console.error(
          `Failed to aggregate ${day.toString()} for system ${systemId}:`,
          error,
        );
      }
    }

    results.push({
      systemId,
      daysAggregated: allDays.length,
      pointsAggregated: aggregatedCount,
      rowsCreated: aggregatedCount,
    });
    totalPoints += aggregatedCount;
    totalRowsCreated += aggregatedCount;

    console.log(
      `[Daily Points] Aggregated ${aggregatedCount} points across ${allDays.length} days for system ${systemId}`,
    );
  }

  // NOTE: the per-(area, day) energy-flow matrix (`point_readings_flow_attr_1d`) is materialised by the
  // battery-provenance heal pass below (it iterates every complete logical system — energy-only +
  // grid/solar attribution for battery-less Areas, plus the blend for battery Areas). The legacy
  // `point_readings_flow_1d` writer was retired, so there is no separate flow-matrix pass here.

  // Daily heal of device run periods over the aggregated range (best-effort).
  // The minutely cron keeps the trailing window fresh; this catches late data across the range.
  try {
    const nowMs = Date.now();
    await recomputeRunPeriodsRange(rangeStartMs, nowMs, nowMs);
  } catch (error) {
    console.error("[Daily Points] Run-period heal pass failed:", error);
  }

  // Daily heal of the derived hot-water temperature over the aggregated range (best-effort).
  // Runs AFTER the 5m aggregation above, since it reads point_readings_agg_5m. No-op when no
  // system has a load.hws/temperature point.
  try {
    await recomputeHwsTemperatureRange(rangeStartMs, Date.now());
  } catch (error) {
    console.error("[Daily Points] HWS temperature heal pass failed:", error);
  }

  // Daily heal of the flow matrix + battery-provenance blend over the aggregated range (best-effort).
  // Runs LAST — it reads agg_5m (battery + grid + solar) which the passes above have materialised. It
  // materialises `point_readings_flow_attr_1d` for EVERY complete logical system (energy-only +
  // grid/solar attribution for battery-less Areas; the blend too for battery Areas) — this is the sole
  // flow-matrix pass since flow_1d was retired. First run THE learn (η → C → losses over the incremental
  // battery_provenance_daily cache — ordering enforced inside), so the blend/rollup recompute below
  // READS reproducible values (via inputs.etaSeries / capacitySeries / chargeEfficiencySeries /
  // idleLossKwhPerDaySeries) instead of re-learning them per window.
  // The contiguous recompute always covers the trailing settlement window (~72h + a 1-day buffer) so
  // late-settling inputs flow in and each day gets one recompute AFTER it crosses the cutoff (→ stamped
  // finalized_at); `Math.min` keeps an explicit larger range (e.g. `last=30d` regenerate) intact.
  try {
    const nowMs = Date.now();
    const trailingStartMs = Math.min(rangeStartMs, nowMs - REHEAL_TRAILING_MS);
    await learnForAllHandles(nowMs);
    await recomputeBatteryProvenanceRange(trailingStartMs, nowMs);
  } catch (error) {
    console.error("[Daily Points] battery-provenance heal pass failed:", error);
  }

  // Scattered-backlog reheal (days older than the settlement window that are still unfinalized or carry a
  // stale attribution version). Runs LAST in its OWN best-effort try/catch so a hiccup/timeout here can
  // never roll back the already-committed contiguous pass above. Bounded per run.
  try {
    const r = await rehealStaleAttrDays(Date.now());
    if (r.days > 0)
      console.log(
        `[Daily Points] flow_attr reheal: ${r.days} stale day(s) across ${r.handles} handle(s)`,
      );
  } catch (error) {
    console.error("[Daily Points] flow_attr scattered reheal failed:", error);
  }

  console.log(
    `[Daily Points] Successfully aggregated ${totalPoints} points across ${allDays.length} days for ${results.length} systems`,
  );

  return {
    startDate: startStr,
    endDate: endStr,
    systemsProcessed: results.length,
    daysAggregated: allDays.length,
    pointsAggregated: totalPoints,
    rowsCreated: totalRowsCreated,
    queryCount,
    results,
  };
}
