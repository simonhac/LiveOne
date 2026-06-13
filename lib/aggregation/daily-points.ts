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
import { recomputeFlowMatrixForDayBestEffort } from "@/lib/db/planetscale/flow-matrix-pg";
import { FLOW_MATRIX_COMPUTE_IN_PG } from "@/lib/db/routing";
import { listCompleteLogicalSystems } from "@/lib/aggregation/logical-system";
import { recomputeRange as recomputeRunPeriodsRange } from "@/lib/run-tracking/recompute";

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

  // Materialise the energy-flow matrix per LOGICAL system (composites + qualifying
  // single systems), each read from its own (possibly cross-system) 5m. Best-effort
  // and idempotent per day, so re-running just heals each day.
  if (FLOW_MATRIX_COMPUTE_IN_PG) {
    try {
      const logicalSystems = await listCompleteLogicalSystems();
      console.log(
        `[Daily Points] Recomputing energy-flow matrix for ${logicalSystems.length} logical systems × ${allDays.length} days`,
      );
      for (const ls of logicalSystems) {
        for (const day of allDays) {
          await recomputeFlowMatrixForDayBestEffort(ls, day);
        }
      }
    } catch (error) {
      console.error("[Daily Points] Energy-flow matrix pass failed:", error);
    }
  }

  // Daily heal of device run periods over the aggregated range (best-effort).
  // The minutely cron keeps the trailing window fresh; this catches late data across the range.
  try {
    const nowMs = Date.now();
    await recomputeRunPeriodsRange(rangeStartMs, nowMs, nowMs);
  } catch (error) {
    console.error("[Daily Points] Run-period heal pass failed:", error);
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
