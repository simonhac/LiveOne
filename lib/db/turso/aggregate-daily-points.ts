import { db, rawClient } from "@/lib/db/turso";
import { systems } from "@/lib/db/turso/schema";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
  pointInfo,
} from "@/lib/db/turso/schema-monitoring-points";
import { eq, and, gte, lte, asc, inArray, sql } from "drizzle-orm";
import { getYesterdayInTimezone, getTodayInTimezone } from "@/lib/date-utils";
import { CalendarDate } from "@internationalized/date";
import { SystemsManager, SystemWithPolling } from "@/lib/systems-manager";
import { publishObservationBatch } from "@/lib/observations/publisher";
import {
  aggregate1dForPoint,
  dayToUnixRangeForAggregation,
} from "@/lib/aggregation/point-aggregates";
import { AGG_COMPUTE_IN_PG, FLOW_MATRIX_COMPUTE_IN_PG } from "@/lib/db/routing";
import { recompute1dForDayBestEffort } from "@/lib/db/planetscale/aggregate-points-pg";
import { recomputeFlowMatrixForDayBestEffort } from "@/lib/db/planetscale/flow-matrix-pg";

// Re-exported from the shared, db-free aggregation module (kept here for backwards
// compatibility with existing importers of this path).
export { dayToUnixRangeForAggregation };

// Earliest date for point data aggregation (when point data collection began)
const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

// Only mirror 1d aggregates to Postgres (via the queue) for SMALL aggregation ranges —
// the nightly cron (yesterday) and modest catch-ups. A full `regenerate`/`aggregate` over
// the whole history (~290 days × N systems) must NOT enqueue thousands of QStash messages;
// historical days are mirrored by scripts/backfill-turso-to-postgres.ts (direct, not queued).
const MIRROR_PUBLISH_MAX_DAYS = 7;

// Type for system object
type System = typeof systems.$inferSelect;

/**
 * Aggregate point readings for a specific day and system
 * @param system - The system object (with timezoneOffsetMin)
 * @param day - The day as CalendarDate
 */
async function aggregateDailyPointData(
  system: System,
  day: CalendarDate,
): Promise<{ data: any[] | null; queryCount: number }> {
  const startTime = performance.now();
  const dayStr = day.toString();
  let queryCount = 0;

  // Get the Unix timestamp range for this day (00:05 to 00:00 next day, in seconds)
  const [dayStartUnix, dayEndUnix] = dayToUnixRangeForAggregation(
    day,
    system.timezoneOffsetMin,
  );

  // Convert to milliseconds for point aggregation queries
  const dayStartMs = dayStartUnix * 1000;
  const dayEndMs = dayEndUnix * 1000;

  // 00:00 interval (5 minutes before day start) - used for 'last' values
  const previousDayEndMs = dayStartMs - 5 * 60 * 1000;

  try {
    // Get all 5-minute data including previous day's 00:00 interval (for 'last' values)
    // Query from 00:00 (previous day end) to 00:00 (current day end)
    const allData = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(
        and(
          eq(pointReadingsAgg5m.systemId, system.id),
          gte(pointReadingsAgg5m.intervalEnd, previousDayEndMs),
          lte(pointReadingsAgg5m.intervalEnd, dayEndMs),
        ),
      )
      .orderBy(asc(pointReadingsAgg5m.intervalEnd));
    queryCount++;

    if (allData.length === 0) {
      console.log(`No point data found for system ${system.id} on ${dayStr}`);
      return { data: null, queryCount };
    }

    // Split data into previous day's 00:00 interval and current day's data
    const previousDayData = allData.filter(
      (r) => r.intervalEnd === previousDayEndMs,
    );
    const fiveMinData = allData.filter(
      (r) => r.intervalEnd >= dayStartMs && r.intervalEnd <= dayEndMs,
    );

    if (fiveMinData.length === 0) {
      console.log(`No 5-min data found for system ${system.id} on ${dayStr}`);
      return { data: null, queryCount };
    }

    // Create a map of pointId -> last value from 00:00 interval
    const lastValuesMap = new Map<number, number | null>();
    for (const record of previousDayData) {
      lastValuesMap.set(record.pointId, record.last);
    }

    // Group data by pointId
    const pointDataMap = new Map<number, typeof fiveMinData>();
    for (const record of fiveMinData) {
      if (!pointDataMap.has(record.pointId)) {
        pointDataMap.set(record.pointId, []);
      }
      pointDataMap.get(record.pointId)!.push(record);
    }

    // Calculate aggregates for each point. The roll-up math lives in the shared,
    // db-free helper so the Postgres recompute (AGG_COMPUTE_IN_PG) produces identical
    // values — see lib/aggregation/point-aggregates.ts.
    const dailyAggregates = [];
    const now = Date.now();

    for (const [pointId, records] of pointDataMap.entries()) {
      const result = aggregate1dForPoint({
        rows: records,
        last: lastValuesMap.get(pointId) ?? null,
      });

      dailyAggregates.push({
        systemId: system.id,
        pointId,
        day: dayStr,
        ...result,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (dailyAggregates.length === 0) {
      console.log(
        `No aggregates calculated for system ${system.id} on ${dayStr}`,
      );
      return { data: null, queryCount };
    }

    // Batch upsert all daily aggregates for this system/day
    await db
      .insert(pointReadingsAgg1d)
      .values(dailyAggregates)
      .onConflictDoUpdate({
        target: [
          pointReadingsAgg1d.systemId,
          pointReadingsAgg1d.pointId,
          pointReadingsAgg1d.day,
        ],
        set: {
          avg: sql`excluded.avg`,
          min: sql`excluded.min`,
          max: sql`excluded.max`,
          last: sql`excluded.last`,
          delta: sql`excluded.delta`,
          sampleCount: sql`excluded.sample_count`,
          errorCount: sql`excluded.error_count`,
          updatedAt: sql`(unixepoch() * 1000)`,
        },
      });
    queryCount++;

    const processingTime = performance.now() - startTime;
    console.log(
      `Aggregated ${dailyAggregates.length} points for system ${system.id} on ${dayStr} in ${processingTime.toFixed(2)}ms`,
    );

    return { data: dailyAggregates, queryCount };
  } catch (error) {
    console.error(
      `Error aggregating daily point data for system ${system.id} on ${dayStr}:`,
      error,
    );
    throw error;
  }
}

/**
 * Get all systems with recent point data
 * @param sinceMs - Look for systems with data since this timestamp (in milliseconds)
 */
async function getSystemsWithRecentPointData(sinceMs: number) {
  // Use raw SQL with DISTINCT to efficiently get unique system IDs
  const result = await rawClient.execute({
    sql: "SELECT DISTINCT system_id FROM point_readings_agg_5m WHERE interval_end >= ?",
    args: [sinceMs],
  });

  const uniqueSystemIds = result.rows.map((row) => row.system_id as number);

  if (uniqueSystemIds.length === 0) {
    return [];
  }

  return db.select().from(systems).where(inArray(systems.id, uniqueSystemIds));
}

/**
 * Delete daily aggregations for a date range (all systems)
 * @param start - Start date (inclusive) or null for earliest available
 * @param end - End date (inclusive) or null for latest available
 * @throws Error if validation fails
 */
export async function deleteRange(
  start: CalendarDate | null,
  end: CalendarDate | null,
) {
  let queryCount = 0;

  // Determine actual date range
  let startDate: CalendarDate;
  let endDate: CalendarDate;

  if (start === null && end === null) {
    // Query earliest 5-minute data to determine start
    const earliest = await db
      .select()
      .from(pointReadingsAgg5m)
      .orderBy(asc(pointReadingsAgg5m.intervalEnd))
      .limit(1);
    queryCount++;

    if (earliest.length === 0) {
      throw new Error("No 5-minute point data found");
    }

    const earliestDate = new Date(earliest[0].intervalEnd);
    startDate = new CalendarDate(
      earliestDate.getFullYear(),
      earliestDate.getMonth() + 1,
      earliestDate.getDate(),
    );

    // Get today as end date (using first system's timezone) to delete all data including today
    const systemDetails = await getSystemsWithRecentPointData(0);
    queryCount++; // getSystemsWithRecentPointData does 1 query
    if (systemDetails.length === 0) {
      throw new Error("No systems found");
    }
    endDate = getTodayInTimezone(systemDetails[0].timezoneOffsetMin);
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

  // Count rows before deleting
  const existingRows = await db
    .select()
    .from(pointReadingsAgg1d)
    .where(
      and(
        gte(pointReadingsAgg1d.day, startStr),
        lte(pointReadingsAgg1d.day, endStr),
      ),
    );
  queryCount++;

  const rowsToDelete = existingRows.length;

  // Delete all aggregations in the range
  await db
    .delete(pointReadingsAgg1d)
    .where(
      and(
        gte(pointReadingsAgg1d.day, startStr),
        lte(pointReadingsAgg1d.day, endStr),
      ),
    )
    .execute();
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
 * Mirror a system/day's daily aggregates to the Postgres mirror via the observations
 * queue (interval "1d"), the same path raw/5m use. `measurementTimeMs` is local midnight
 * of the day so the consumer can derive the YYYY-MM-DD key from the formatted timestamp.
 * Best-effort: publishObservationBatch swallows its own errors and never throws, so a
 * queue hiccup can't break Turso aggregation (the source of truth).
 *
 * PR-13: with AGG_COMPUTE_IN_PG on in prod, PG recomputes 1d from its own 5m, so this
 * publisher is no longer called (its only call site is gated `!AGG_COMPUTE_IN_PG`).
 * Retained as a no-op for one release so AGG_COMPUTE_IN_PG=false restores the old mirror
 * behaviour exactly; remove once Turso is decommissioned.
 */
async function publishDailyAggregates(
  pollingSystem: SystemWithPolling,
  pointInfoByIndex: Map<number, typeof pointInfo.$inferSelect>,
  measurementTimeMs: number,
  dailyAggregates: Array<{
    pointId: number;
    avg: number | null;
    min: number | null;
    max: number | null;
    last: number | null;
    delta: number | null;
    sampleCount: number;
    errorCount: number;
  }>,
): Promise<void> {
  const receivedTimeMs = Date.now();
  let missingPointInfo = 0;
  const inputs = dailyAggregates
    .map((a) => {
      const point = pointInfoByIndex.get(a.pointId);
      if (!point) {
        missingPointInfo++;
        return null;
      }
      return {
        sessionId: "0", // daily aggregates have no session (sessionId unused for 1d)
        point,
        value: a.delta ?? a.avg ?? a.last ?? null,
        measurementTimeMs,
        receivedTimeMs,
        interval: "1d" as const,
        // valueStr/dataQuality are unused by point_readings_agg_1d (no such columns).
        agg: {
          avg: a.avg,
          min: a.min,
          max: a.max,
          last: a.last,
          delta: a.delta,
          valueStr: null,
          sampleCount: a.sampleCount,
          errorCount: a.errorCount,
          dataQuality: null,
        },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (missingPointInfo > 0) {
    console.warn(
      `[Daily Points] ${missingPointInfo} point(s) absent from point_info for system ${pollingSystem.id} — not mirrored to Postgres 1d (Turso row is unaffected).`,
    );
  }
  if (inputs.length === 0) return;
  await publishObservationBatch(pollingSystem, inputs);
}

/**
 * Aggregate daily point data for a date range (all systems)
 * @param start - Start date (inclusive) or null for earliest available
 * @param end - End date (inclusive) or null for latest available
 * @throws Error if validation fails
 */
export async function aggregateRange(
  start: CalendarDate | null,
  end: CalendarDate | null,
) {
  let queryCount = 0;

  // Determine actual date range
  let startDate: CalendarDate;
  let endDate: CalendarDate;

  if (start === null && end === null) {
    // Query earliest 5-minute data to determine start
    const earliest = await db
      .select()
      .from(pointReadingsAgg5m)
      .orderBy(asc(pointReadingsAgg5m.intervalEnd))
      .limit(1);
    queryCount++;

    if (earliest.length === 0) {
      throw new Error("No 5-minute point data found");
    }

    const earliestDate = new Date(earliest[0].intervalEnd);
    startDate = new CalendarDate(
      earliestDate.getFullYear(),
      earliestDate.getMonth() + 1,
      earliestDate.getDate(),
    );

    // Get yesterday as end date (using first system's timezone)
    const systemDetails = await getSystemsWithRecentPointData(0);
    queryCount++; // getSystemsWithRecentPointData does 1 query
    if (systemDetails.length === 0) {
      throw new Error("No systems found");
    }
    endDate = getYesterdayInTimezone(systemDetails[0].timezoneOffsetMin);
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

  // Get all systems with data in the range
  const rangeStartMs = new Date(startStr).getTime();
  const systemDetails = await getSystemsWithRecentPointData(rangeStartMs);
  queryCount++; // getSystemsWithRecentPointData does 1 query

  if (systemDetails.length === 0) {
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

  console.log(
    `[Daily Points] Found ${systemDetails.length} systems to process`,
  );

  // Generate list of all days in range
  const allDays: CalendarDate[] = [];
  let currentDate = startDate;
  while (currentDate.compare(endDate) <= 0) {
    allDays.push(currentDate);
    currentDate = currentDate.add({ days: 1 });
  }

  console.log(`[Daily Points] Aggregating ${allDays.length} days`);

  const results = [];
  let totalPoints = 0;
  let totalRowsCreated = 0;

  // Skip queue mirroring on bulk runs (full regenerate/aggregate) to avoid flooding QStash
  // with one message per system×day; those days are covered by the direct backfill script.
  const mirrorToPg = allDays.length <= MIRROR_PUBLISH_MAX_DAYS;
  if (!mirrorToPg) {
    console.log(
      `[Daily Points] Range is ${allDays.length} days (> ${MIRROR_PUBLISH_MAX_DAYS}) — skipping 1d Postgres-mirror publishing; use the backfill script to reconcile.`,
    );
  }

  const systemsManager = SystemsManager.getInstance();

  for (const system of systemDetails) {
    try {
      let aggregatedCount = 0;
      let rowsCreatedForSystem = 0;

      // The Turso 1d reaches Postgres one of two ways, both gated to small ranges:
      //  - AGG_COMPUTE_IN_PG on  → PG recomputes the day's 1d from PG's own 5m (shadow),
      //    so we do NOT also mirror Turso's 1d (that would overwrite the PG-computed values
      //    and make the reconciler a no-op). No publisher metadata needed.
      //  - AGG_COMPUTE_IN_PG off → mirror Turso's 1d over the queue (current behavior),
      //    which needs the polling system + a pointId→point_info map.
      //
      // PR-13: with AGG_COMPUTE_IN_PG on in prod, `publishToPg` is always false, so the
      // queue-publish branch below is a NO-OP — the redundant 1d double-write is already
      // gone. The branch (and `publishDailyAggregates`) is retained for one release so a
      // flag flip to AGG_COMPUTE_IN_PG=false restores the old mirror behaviour exactly;
      // it can be deleted once Turso is decommissioned.
      const computeInPg = mirrorToPg && AGG_COMPUTE_IN_PG;
      const publishToPg = mirrorToPg && !AGG_COMPUTE_IN_PG;

      const pollingSystem = publishToPg
        ? await systemsManager.getSystem(system.id)
        : null;
      const pointInfoByIndex = new Map<number, typeof pointInfo.$inferSelect>();
      if (publishToPg && pollingSystem) {
        const pts = await db
          .select()
          .from(pointInfo)
          .where(eq(pointInfo.systemId, system.id));
        for (const p of pts) pointInfoByIndex.set(p.index, p);
      } else if (publishToPg && !pollingSystem) {
        console.warn(
          `[Daily Points] System ${system.id} not in the polling registry — its 1d aggregates won't be mirrored to Postgres this run.`,
        );
      }

      for (const day of allDays) {
        try {
          const result = await aggregateDailyPointData(system, day);
          queryCount += result.queryCount;
          if (result.data) {
            aggregatedCount += result.data.length;
            rowsCreatedForSystem += result.data.length;

            // Land the day's 1d in Postgres (best-effort; never throws).
            if (computeInPg) {
              // Shadow: PG computes its own 1d from PG 5m (independent of result.data).
              await recompute1dForDayBestEffort(system, day);
              // Materialize the day's energy-flow matrix from the (now settled) PG 5m.
              if (FLOW_MATRIX_COMPUTE_IN_PG) {
                await recomputeFlowMatrixForDayBestEffort(system, day);
              }
            } else if (publishToPg && pollingSystem) {
              // Mirror the Turso-computed 1d over the queue.
              const [dayStartUnix] = dayToUnixRangeForAggregation(
                day,
                system.timezoneOffsetMin,
              );
              const localMidnightMs = (dayStartUnix - 5 * 60) * 1000;
              await publishDailyAggregates(
                pollingSystem,
                pointInfoByIndex,
                localMidnightMs,
                result.data,
              );
            }
          }
        } catch (error) {
          console.error(
            `Failed to aggregate ${day.toString()} for system ${system.id}:`,
            error,
          );
        }
      }

      results.push({
        systemId: system.id,
        daysAggregated: allDays.length,
        pointsAggregated: aggregatedCount,
        rowsCreated: rowsCreatedForSystem,
      });

      totalPoints += aggregatedCount;
      totalRowsCreated += rowsCreatedForSystem;

      console.log(
        `[Daily Points] Aggregated ${aggregatedCount} points (${rowsCreatedForSystem} rows) across ${allDays.length} days for system ${system.id}`,
      );
    } catch (error) {
      console.error(
        `Failed to aggregate range for system ${system.id}:`,
        error,
      );
    }
  }

  console.log(
    `[Daily Points] Successfully aggregated ${totalPoints} points (${totalRowsCreated} rows created) across ${allDays.length} days for ${results.length} systems`,
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
