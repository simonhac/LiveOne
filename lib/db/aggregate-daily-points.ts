import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, gte, lte, asc, inArray, sql } from "drizzle-orm";
import {
  getYesterdayInTimezone,
  getTodayInTimezone,
  formatDateYYYYMMDD,
} from "@/lib/date-utils";
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
  const dayYYYYMMDD = formatDateYYYYMMDD(day);

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
      console.log(
        `No point data found for system ${system.id} on ${dayYYYYMMDD}`,
      );
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
      console.log(
        `No 5-min data found for system ${system.id} on ${dayYYYYMMDD}`,
      );
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
        day: dayYYYYMMDD,
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
        `No aggregates calculated for system ${system.id} on ${dayYYYYMMDD}`,
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
      `Aggregated ${dailyAggregates.length} points for system ${system.id} on ${dayYYYYMMDD} in ${processingTime.toFixed(2)}ms`,
    );

    return dailyAggregates;
  } catch (error) {
    console.error(
      `Error aggregating daily point data for system ${system.id} on ${dayYYYYMMDD}:`,
      error,
    );
    throw error;
  }
}

/**
 * Aggregate all points for a specific calendar date (all systems)
 * Each system interprets the date in its own timezone
 * @param day - The day as CalendarDate
 */
export async function aggregateAllPointsForADay(day: CalendarDate) {
  try {
    const dayYYYYMMDD = formatDateYYYYMMDD(day);
    console.log(`[Daily Points] Aggregating all systems for ${dayYYYYMMDD}`);

    // Get all systems with recent point data (last 7 days)
    const sevenDaysAgo =
      Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000) * 1000; // ms

    const recentPoints = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(gte(pointReadingsAgg5m.intervalEnd, sevenDaysAgo));

    const uniqueSystemIds = [...new Set(recentPoints.map((r) => r.systemId))];

    if (uniqueSystemIds.length === 0) {
      console.log("[Daily Points] No systems with recent point data found");
      return {
        day: dayYYYYMMDD,
        systemsProcessed: 0,
        pointsAggregated: 0,
        results: [],
      };
    }

    // Get system details
    const systemDetails = await db
      .select()
      .from(systems)
      .where(inArray(systems.id, uniqueSystemIds));

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
          `Failed to aggregate points for system ${system.id} on ${dayYYYYMMDD}:`,
          error,
        );
      }
    }

    console.log(
      `[Daily Points] Aggregated ${totalPoints} points across ${results.length} systems for ${dayYYYYMMDD}`,
    );

    return {
      day: dayYYYYMMDD,
      systemsProcessed: results.length,
      pointsAggregated: totalPoints,
      results,
    };
  } catch (error) {
    console.error(
      `Error aggregating all points for day ${formatDateYYYYMMDD(day)}:`,
      error,
    );
    throw error;
  }
}

/**
 * Aggregate yesterday's point data for all active systems
 * This should be run daily via cron job
 */
export async function aggregateYesterdayPointsForAllSystems() {
  try {
    // Get all systems with recent point data (last 7 days)
    const sevenDaysAgo =
      Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000) * 1000; // ms
    console.log(
      `[Daily Points] Looking for systems with point data after ${new Date(sevenDaysAgo).toISOString()}`,
    );

    const recentPoints = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(gte(pointReadingsAgg5m.intervalEnd, sevenDaysAgo));

    const uniqueSystemIds = [...new Set(recentPoints.map((r) => r.systemId))];
    console.log(
      `[Daily Points] Unique system IDs found: ${uniqueSystemIds.join(", ") || "none"}`,
    );

    if (uniqueSystemIds.length === 0) {
      console.log("[Daily Points] No systems with recent point data found");
      return [];
    }

    // Get system details with timezone info
    const systemDetails = await db
      .select()
      .from(systems)
      .where(inArray(systems.id, uniqueSystemIds));

    console.log(
      `[Daily Points] Aggregating yesterday's point data for ${systemDetails.length} systems`,
    );

    const results = [];
    for (const system of systemDetails) {
      try {
        // Calculate yesterday for this specific system's timezone
        const yesterday = getYesterdayInTimezone(system.timezoneOffsetMin);
        const yesterdayYYYYMMDD = formatDateYYYYMMDD(yesterday);

        console.log(
          `[Daily Points] Aggregating ${yesterdayYYYYMMDD} for system ${system.id} (timezone offset: ${system.timezoneOffsetMin} minutes)`,
        );

        const aggregates = await aggregateDailyPointData(system, yesterday);
        if (aggregates) {
          results.push({
            systemId: system.id,
            day: yesterdayYYYYMMDD,
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
  } catch (error) {
    console.error(
      "[Daily Points] Error aggregating yesterday data for all systems:",
      error,
    );
    throw error;
  }
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
              gte(
                pointReadingsAgg1d.day,
                formatDateYYYYMMDD(earliestCalendarDate),
              ),
              lte(pointReadingsAgg1d.day, formatDateYYYYMMDD(latestDate)),
            ),
          );

        const existingDaySet = new Set(existingDays.map((d) => d.day));

        // Generate list of all days in range
        const allDays: CalendarDate[] = [];
        let currentDate = earliestCalendarDate;

        while (currentDate.compare(latestDate) <= 0) {
          const dayYYYYMMDD = formatDateYYYYMMDD(currentDate);
          if (!existingDaySet.has(dayYYYYMMDD)) {
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
              `Failed to aggregate ${formatDateYYYYMMDD(day)} for system ${system.id}:`,
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
 * Aggregate the last N days for all active systems
 * Used for updating recent data without regenerating everything
 * @param days - Number of days to look back (default 7)
 */
export async function aggregateLastNDaysForAllPoints(days: number = 7) {
  try {
    // Get all systems with recent point data
    const daysAgoMs = Date.now() - days * 24 * 60 * 60 * 1000;
    console.log(
      `[Daily Points] Looking for systems with point data after ${new Date(daysAgoMs).toISOString()}`,
    );

    const recentPoints = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(gte(pointReadingsAgg5m.intervalEnd, daysAgoMs));

    const uniqueSystemIds = [...new Set(recentPoints.map((r) => r.systemId))];
    console.log(
      `[Daily Points] Unique system IDs found: ${uniqueSystemIds.join(", ") || "none"}`,
    );

    if (uniqueSystemIds.length === 0) {
      console.log("[Daily Points] No systems with recent point data found");
      return [];
    }

    // Get system details with timezone info
    const systemDetails = await db
      .select()
      .from(systems)
      .where(inArray(systems.id, uniqueSystemIds));

    console.log(
      `[Daily Points] Updating last ${days} days for ${systemDetails.length} systems`,
    );

    const results = [];
    for (const system of systemDetails) {
      try {
        // Calculate the date range for this system's timezone
        const today = getTodayInTimezone(system.timezoneOffsetMin);

        // Generate list of days
        const daysToAggregate: CalendarDate[] = [];
        for (let i = 0; i < days; i++) {
          daysToAggregate.push(today.subtract({ days: i }));
        }

        console.log(
          `[Daily Points] Updating system ${system.id} for days: ${daysToAggregate.map((d) => formatDateYYYYMMDD(d)).join(", ")}`,
        );

        let aggregatedCount = 0;
        for (const day of daysToAggregate) {
          try {
            const result = await aggregateDailyPointData(system, day);
            if (result) {
              aggregatedCount += result.length;
            }
          } catch (error) {
            console.error(
              `Failed to aggregate ${formatDateYYYYMMDD(day)} for system ${system.id}:`,
              error,
            );
          }
        }

        results.push({
          systemId: system.id,
          daysUpdated: daysToAggregate.length,
          pointsAggregated: aggregatedCount,
        });

        console.log(
          `[Daily Points] Updated ${daysToAggregate.length} days for system ${system.id}`,
        );
      } catch (error) {
        console.error(
          `Failed to update last ${days} days for system ${system.id}:`,
          error,
        );
      }
    }

    console.log(
      `[Daily Points] Successfully updated last ${days} days for ${results.length} systems`,
    );
    return results;
  } catch (error) {
    console.error(
      `[Daily Points] Error updating last ${days} days for all systems:`,
      error,
    );
    throw error;
  }
}
