import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, gte, lte, asc, inArray, sql } from "drizzle-orm";
import { getYesterdayInTimezone, getTodayInTimezone } from "@/lib/date-utils";
import { dayToUnixRangeForAggregation } from "@/lib/db/aggregate-daily";
import { CalendarDate } from "@internationalized/date";

// Type for system object
type System = typeof systems.$inferSelect;

/**
 * Aggregate point readings for a specific day and system
 * @param system - The system object (with timezoneOffsetMin)
 * @param day - The day as CalendarDate
 */
export async function aggregateDailyPointData(
  system: System,
  day: CalendarDate,
) {
  const startTime = performance.now();
  const dayStr = day.toString();

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

    if (allData.length === 0) {
      console.log(`No point data found for system ${system.id} on ${dayStr}`);
      return null;
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
      return null;
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
      return null;
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

    const processingTime = performance.now() - startTime;
    console.log(
      `Aggregated ${dailyAggregates.length} points for system ${system.id} on ${dayStr} in ${processingTime.toFixed(2)}ms`,
    );

    return dailyAggregates;
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
  const recentPoints = await db
    .select()
    .from(pointReadingsAgg5m)
    .where(gte(pointReadingsAgg5m.intervalEnd, sinceMs));

  const uniqueSystemIds = [...new Set(recentPoints.map((r) => r.systemId))];

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

  // Validate date range
  const minDate = new CalendarDate(2025, 1, 1);
  if (startDate.compare(minDate) < 0) {
    throw new Error(
      `Start date ${startDate.toString()} is earlier than minimum allowed date 2025-01-01`,
    );
  }

  if (startDate.compare(endDate) > 0) {
    throw new Error(
      `Start date ${startDate.toString()} must be before or equal to end date ${endDate.toString()}`,
    );
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

  console.log(
    `[Daily Points] Deleted ${rowsToDelete} aggregation rows from ${startStr} to ${endStr}`,
  );

  return {
    startDate: startStr,
    endDate: endStr,
    rowsDeleted: rowsToDelete,
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

  // Validate date range
  const minDate = new CalendarDate(2025, 1, 1);
  if (startDate.compare(minDate) < 0) {
    throw new Error(
      `Start date ${startDate.toString()} is earlier than minimum allowed date 2025-01-01`,
    );
  }

  if (startDate.compare(endDate) > 0) {
    throw new Error(
      `Start date ${startDate.toString()} must be before or equal to end date ${endDate.toString()}`,
    );
  }

  const startStr = startDate.toString();
  const endStr = endDate.toString();

  console.log(
    `[Daily Points] Aggregating date range from ${startStr} to ${endStr}`,
  );

  // Get all systems with data in the range
  const rangeStartMs = new Date(startStr).getTime();
  const systemDetails = await getSystemsWithRecentPointData(rangeStartMs);

  if (systemDetails.length === 0) {
    console.log("[Daily Points] No systems with data in the specified range");
    return {
      startDate: startStr,
      endDate: endStr,
      systemsProcessed: 0,
      daysAggregated: 0,
      pointsAggregated: 0,
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
          if (result) {
            aggregatedCount += result.length;
            rowsCreatedForSystem += result.length;
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
    results,
  };
}

/**
 * Regenerate aggregations for a specific date (all systems)
 * Deletes existing aggregations for that date, then regenerates them
 * @param day - The date to regenerate as CalendarDate
 */
export async function regenerateDate(day: CalendarDate) {
  const dayStr = day.toString();

  console.log(`[Daily Points] Regenerating date: ${dayStr}`);

  // Delete existing aggregations for this date
  await db
    .delete(pointReadingsAgg1d)
    .where(eq(pointReadingsAgg1d.day, dayStr))
    .execute();

  console.log(`[Daily Points] Deleted existing aggregations for ${dayStr}`);

  // Get systems with recent data (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const systemDetails = await getSystemsWithRecentPointData(sevenDaysAgo);

  if (systemDetails.length === 0) {
    console.log("[Daily Points] No systems with recent point data found");
    return {
      day: dayStr,
      systemsProcessed: 0,
      pointsAggregated: 0,
      results: [],
    };
  }

  console.log(
    `[Daily Points] Found ${systemDetails.length} systems with recent point data`,
  );

  const results = [];
  let totalPoints = 0;

  for (const system of systemDetails) {
    try {
      const aggregates = await aggregateDailyPointData(system, day);
      if (aggregates) {
        results.push({
          systemId: system.id,
          pointsAggregated: aggregates.length,
        });
        totalPoints += aggregates.length;
      }
    } catch (error) {
      console.error(
        `Failed to aggregate points for system ${system.id} on ${dayStr}:`,
        error,
      );
    }
  }

  console.log(
    `[Daily Points] Aggregated ${totalPoints} points across ${results.length} systems for ${dayStr}`,
  );

  return {
    day: dayStr,
    systemsProcessed: results.length,
    pointsAggregated: totalPoints,
    results,
  };
}

/**
 * Aggregate yesterday's point data for all active systems
 * This should be run daily via cron job
 */
export async function aggregateDaily() {
  console.log("[Daily Points] Starting daily aggregation (yesterday)");

  // Get systems with recent data (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const systemDetails = await getSystemsWithRecentPointData(sevenDaysAgo);

  if (systemDetails.length === 0) {
    console.log("[Daily Points] No systems with recent point data found");
    return [];
  }

  console.log(
    `[Daily Points] Aggregating yesterday's point data for ${systemDetails.length} systems`,
  );

  const results = [];
  for (const system of systemDetails) {
    try {
      // Calculate yesterday for this specific system's timezone
      const yesterday = getYesterdayInTimezone(system.timezoneOffsetMin);
      const dayStr = yesterday.toString();

      console.log(
        `[Daily Points] Aggregating ${dayStr} for system ${system.id}`,
      );

      const aggregates = await aggregateDailyPointData(system, yesterday);
      if (aggregates) {
        results.push({
          systemId: system.id,
          day: dayStr,
          pointsAggregated: aggregates.length,
        });
      }
    } catch (error) {
      console.error(
        `Failed to aggregate yesterday's point data for system ${system.id}:`,
        error,
      );
    }
  }

  console.log(
    `[Daily Points] Successfully aggregated yesterday's point data for ${results.length} systems`,
  );
  return results;
}

/**
 * Aggregate ALL missing daily point data for ALL systems
 * This can be used for initial population or full regeneration
 */
export async function aggregateAllMissingDaysForAllPoints() {
  try {
    // Get all unique system IDs that have any 5-minute point data
    const allPoints = await db.select().from(pointReadingsAgg5m);

    const uniqueSystemIds = [...new Set(allPoints.map((r) => r.systemId))];
    console.log(
      `[Daily Points] Found ${uniqueSystemIds.length} systems to process for all missing days`,
    );

    // Get all systems
    const allSystems = await db
      .select()
      .from(systems)
      .where(inArray(systems.id, uniqueSystemIds));

    let totalAggregated = 0;
    const systemResults = [];

    for (const system of allSystems) {
      try {
        console.log(
          `[Daily Points] Processing all missing days for system ${system.id}...`,
        );

        // Find earliest 5-min data for this system
        const earliest = await db
          .select()
          .from(pointReadingsAgg5m)
          .where(eq(pointReadingsAgg5m.systemId, system.id))
          .orderBy(asc(pointReadingsAgg5m.intervalEnd))
          .limit(1);

        if (earliest.length === 0) {
          console.log(`No point data found for system ${system.id}`);
          continue;
        }

        // Get yesterday in system's timezone as end date
        const latestDate = getYesterdayInTimezone(system.timezoneOffsetMin);
        const earliestDate = new Date(earliest[0].intervalEnd);
        const earliestCalendarDate = new CalendarDate(
          earliestDate.getFullYear(),
          earliestDate.getMonth() + 1,
          earliestDate.getDate(),
        );

        // Get existing aggregated days
        const existingDays = await db
          .select()
          .from(pointReadingsAgg1d)
          .where(
            and(
              eq(pointReadingsAgg1d.systemId, system.id),
              gte(pointReadingsAgg1d.day, earliestCalendarDate.toString()),
              lte(pointReadingsAgg1d.day, latestDate.toString()),
            ),
          );

        const existingDaySet = new Set(existingDays.map((d) => d.day));

        // Generate list of all days in range
        const allDays: CalendarDate[] = [];
        let currentDate = earliestCalendarDate;

        while (currentDate.compare(latestDate) <= 0) {
          const dayStr = currentDate.toString();
          if (!existingDaySet.has(dayStr)) {
            allDays.push(currentDate);
          }
          currentDate = currentDate.add({ days: 1 });
        }

        console.log(
          `[Daily Points] Found ${allDays.length} missing days to aggregate for system ${system.id}`,
        );

        // Aggregate each missing day
        let aggregatedCount = 0;
        for (const day of allDays) {
          try {
            const result = await aggregateDailyPointData(system, day);
            if (result) {
              aggregatedCount += result.length;
            }
          } catch (error) {
            console.error(
              `Failed to aggregate ${day.toString()} for system ${system.id}:`,
              error,
            );
          }
        }

        totalAggregated += aggregatedCount;
        systemResults.push({
          systemId: system.id,
          daysAggregated: allDays.length,
          pointsAggregated: aggregatedCount,
        });

        console.log(
          `[Daily Points] ✓ Aggregated ${aggregatedCount} points across ${allDays.length} days for system ${system.id}`,
        );
      } catch (error) {
        console.error(
          `Failed to aggregate all days for system ${system.id}:`,
          error,
        );
      }
    }

    console.log(
      `[Daily Points] Successfully aggregated ${totalAggregated} total points across ${allSystems.length} systems`,
    );
    return systemResults;
  } catch (error) {
    console.error(
      "[Daily Points] Error aggregating all missing days for all systems:",
      error,
    );
    throw error;
  }
}

/**
 * Regenerate aggregations for the last N days (all systems)
 * Deletes existing aggregations for that date range, then regenerates them
 * @param days - Number of days to regenerate (e.g., 7 for last 7 days)
 */
export async function regenerateLastNDays(days: number) {
  console.log(`[Daily Points] Regenerating last ${days} days`);

  // Calculate date range (using first system's timezone for the range calculation)
  // Each system will then interpret these dates in their own timezone
  const systemDetails = await getSystemsWithRecentPointData(
    Date.now() - days * 24 * 60 * 60 * 1000,
  );

  if (systemDetails.length === 0) {
    console.log("[Daily Points] No systems with recent point data found");
    return [];
  }

  // Use first system's timezone to calculate date range
  const today = getTodayInTimezone(systemDetails[0].timezoneOffsetMin);
  const startDate = today.subtract({ days: days - 1 });
  const startDateStr = startDate.toString();
  const endDateStr = today.toString();

  // Delete existing aggregations for this date range (all systems)
  await db
    .delete(pointReadingsAgg1d)
    .where(
      and(
        gte(pointReadingsAgg1d.day, startDateStr),
        lte(pointReadingsAgg1d.day, endDateStr),
      ),
    )
    .execute();

  console.log(
    `[Daily Points] Deleted aggregations from ${startDateStr} to ${endDateStr}`,
  );

  console.log(
    `[Daily Points] Regenerating last ${days} days for ${systemDetails.length} systems`,
  );

  const results = [];
  for (const system of systemDetails) {
    try {
      // Calculate the date range for this system's timezone
      const systemToday = getTodayInTimezone(system.timezoneOffsetMin);

      // Generate list of days (from today back N days)
      const daysToAggregate: CalendarDate[] = [];
      for (let i = 0; i < days; i++) {
        daysToAggregate.push(systemToday.subtract({ days: i }));
      }

      let aggregatedCount = 0;
      for (const day of daysToAggregate) {
        try {
          const result = await aggregateDailyPointData(system, day);
          if (result) {
            aggregatedCount += result.length;
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
        daysAggregated: daysToAggregate.length,
        pointsAggregated: aggregatedCount,
      });

      console.log(
        `[Daily Points] Regenerated ${daysToAggregate.length} days for system ${system.id}`,
      );
    } catch (error) {
      console.error(
        `Failed to regenerate last ${days} days for system ${system.id}:`,
        error,
      );
    }
  }

  console.log(
    `[Daily Points] Successfully regenerated last ${days} days for ${results.length} systems`,
  );
  return results;
}
