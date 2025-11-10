import { db, rawClient } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, gte, lte, asc, inArray, sql } from "drizzle-orm";
import { getYesterdayInTimezone, getTodayInTimezone } from "@/lib/date-utils";
import { dayToUnixRangeForAggregation } from "@/lib/db/aggregate-daily";
import { CalendarDate } from "@internationalized/date";

// Earliest date for point data aggregation (when point data collection began)
const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

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

    // Calculate aggregates for each point
    const dailyAggregates = [];
    const now = Date.now();

    for (const [pointId, records] of pointDataMap.entries()) {
      // Extract non-null values for aggregation
      const avgValues = records
        .map((r) => r.avg)
        .filter((v) => v !== null) as number[];
      const minValues = records
        .map((r) => r.min)
        .filter((v) => v !== null) as number[];
      const maxValues = records
        .map((r) => r.max)
        .filter((v) => v !== null) as number[];
      const deltaValues = records
        .map((r) => r.delta)
        .filter((v) => v !== null) as number[];

      // Calculate aggregates
      const avg =
        avgValues.length > 0
          ? avgValues.reduce((sum, val) => sum + val, 0) / avgValues.length
          : null;

      const min = minValues.length > 0 ? Math.min(...minValues) : null;

      const max = maxValues.length > 0 ? Math.max(...maxValues) : null;

      const delta =
        deltaValues.length > 0
          ? deltaValues.reduce((sum, val) => sum + val, 0)
          : null;

      // Get last value from 00:00 interval
      const last = lastValuesMap.get(pointId) ?? null;

      // Sum sample counts and error counts
      const sampleCount = records.reduce(
        (sum, r) => sum + (r.sampleCount || 0),
        0,
      );
      const errorCount = records.reduce(
        (sum, r) => sum + (r.errorCount || 0),
        0,
      );

      dailyAggregates.push({
        systemId: system.id,
        pointId,
        day: dayStr,
        avg,
        min,
        max,
        last,
        delta,
        sampleCount,
        errorCount,
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
          updatedAt: sql`excluded.updated_at`,
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

  for (const system of systemDetails) {
    try {
      let aggregatedCount = 0;
      let rowsCreatedForSystem = 0;

      for (const day of allDays) {
        try {
          const result = await aggregateDailyPointData(system, day);
          queryCount += result.queryCount;
          if (result.data) {
            aggregatedCount += result.data.length;
            rowsCreatedForSystem += result.data.length;
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
