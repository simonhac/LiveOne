import { db } from './db';
import { pointReadingsAgg5m, pointReadings } from './db/schema-monitoring-points';
import { and, gt, lte, eq, sql } from 'drizzle-orm';
import { formatTimeAEST, fromUnixTimestamp } from './date-utils';

/**
 * Updates the 5-minute aggregated data for multiple points in a single interval
 * Called after batch inserting point readings
 *
 * This efficiently handles multiple points at once:
 * - 1 query to fetch all readings for all points
 * - 1 batch upsert for all aggregates
 */
export async function updatePointAggregates5m(
  systemId: number,
  pointIds: number[],
  measurementTime: number  // Unix timestamp in milliseconds
): Promise<void> {
  if (pointIds.length === 0) return;

  try {
    // Calculate the 5-minute interval boundaries (in milliseconds)
    const intervalMs = 5 * 60 * 1000;
    const intervalEndMs = Math.ceil(measurementTime / intervalMs) * intervalMs;
    const intervalStartMs = intervalEndMs - intervalMs;

    // QUERY 1: Fetch all readings for all points in this interval (single query!)
    // Use > intervalStart AND <= intervalEnd (exclusive start, inclusive end)
    const allReadings = await db
      .select()
      .from(pointReadings)
      .where(
        and(
          eq(pointReadings.systemId, systemId),
          gt(pointReadings.measurementTime, intervalStartMs),
          lte(pointReadings.measurementTime, intervalEndMs)
        )
      )
      .orderBy(pointReadings.pointId, pointReadings.measurementTime);

    if (allReadings.length === 0) {
      return; // No readings to aggregate
    }

    // Group readings by pointId, separating valid values from errors
    const pointGroups = new Map<number, {
      validReadings: Array<{ measurementTime: number; value: number }>;
      errorCount: number;
    }>();

    for (const reading of allReadings) {
      if (!pointGroups.has(reading.pointId)) {
        pointGroups.set(reading.pointId, { validReadings: [], errorCount: 0 });
      }

      const group = pointGroups.get(reading.pointId)!;

      // Count as error if value is null or data quality indicates an error
      if (reading.value === null) {
        group.errorCount++;
      } else {
        group.validReadings.push({
          measurementTime: reading.measurementTime,
          value: reading.value
        });
      }
    }

    // Calculate aggregates for each point
    const aggregates = Array.from(pointGroups.entries()).map(([pointId, group]) => {
      const { validReadings, errorCount } = group;
      const sampleCount = validReadings.length;

      // If all readings were errors, aggregates will be null
      if (sampleCount === 0) {
        return {
          systemId,
          pointId,
          intervalEnd: intervalEndMs,
          avg: null,
          min: null,
          max: null,
          last: null,
          sampleCount: 0,
          errorCount,
        };
      }

      const values = validReadings.map(r => r.value);

      return {
        systemId,
        pointId,
        intervalEnd: intervalEndMs,
        avg: values.reduce((sum, v) => sum + v, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        last: validReadings[validReadings.length - 1].value, // Last chronologically
        sampleCount,
        errorCount,
      };
    });

    if (aggregates.length === 0) return;

    // QUERY 2: Batch upsert all aggregates (single query!)
    await db.insert(pointReadingsAgg5m)
      .values(aggregates)
      .onConflictDoUpdate({
        target: [pointReadingsAgg5m.pointId, pointReadingsAgg5m.intervalEnd],
        set: {
          avg: sql`excluded.avg`,
          min: sql`excluded.min`,
          max: sql`excluded.max`,
          last: sql`excluded.last`,
          sampleCount: sql`excluded.sample_count`,
          errorCount: sql`excluded.error_count`,
          updatedAt: sql`(unixepoch() * 1000)`,
        }
      });

    // Use AEST timezone (600 min offset) for logging
    const intervalEndSec = Math.floor(intervalEndMs / 1000);
    console.log(`[PointAggregation] Updated ${aggregates.length} point aggregates for interval ending ${formatTimeAEST(fromUnixTimestamp(intervalEndSec, 600))}`);
  } catch (error) {
    console.error('[PointAggregation] Error updating aggregated data:', error);
    // Don't throw - we don't want aggregation failures to break the main polling
  }
}
