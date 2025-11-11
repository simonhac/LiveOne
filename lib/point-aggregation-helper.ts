import { db } from "./db";
import {
  pointReadingsAgg5m,
  pointReadings,
  pointInfo,
} from "./db/schema-monitoring-points";
import { and, gt, lte, eq, sql, inArray } from "drizzle-orm";
import { formatTimeAEST, fromUnixTimestamp } from "./date-utils";

/**
 * Get the last values from a specific 5-minute interval for specified points
 * Used for calculating deltas for points with transform='d'
 *
 * @param systemId - The system ID
 * @param pointIds - Array of point IDs to fetch last values for (only points with transform='d')
 * @param intervalEnd - The interval end time in milliseconds
 * @returns Map of pointId -> last value from the interval
 */
export async function getPointsLastValues5m(
  systemId: number,
  pointIds: number[],
  intervalEnd: number,
): Promise<Map<number, number>> {
  if (pointIds.length === 0) return new Map();

  // Fetch aggregates for the specified interval
  const aggs = await db
    .select()
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, systemId),
        inArray(pointReadingsAgg5m.pointId, pointIds),
        eq(pointReadingsAgg5m.intervalEnd, intervalEnd),
      ),
    );

  // Build map of pointId -> last value
  const lastValues = new Map<number, number>();
  for (const agg of aggs) {
    if (agg.last !== null) {
      lastValues.set(agg.pointId, agg.last);
    }
  }

  return lastValues;
}

/**
 * Updates the 5-minute aggregated data for multiple points in a single interval
 * Called after batch inserting point readings
 *
 * This efficiently handles multiple points at once:
 * - 1 query to fetch all readings for all points
 * - 1 batch upsert for all aggregates
 * - For points with transform='d': calculates delta from previous interval
 * - For points with metricType='energy' and transform != 'd': sums values into delta
 *
 * @param systemId - The system ID
 * @param points - Array of pointInfo objects (with id, transform, and metricType fields)
 * @param measurementTime - Unix timestamp in milliseconds of the readings
 * @param previousLastValues - Map of pointId -> last value from previous interval (for transform='d' delta calculation)
 */
export async function updatePointAggregates5m(
  systemId: number,
  points: Array<{
    id: number;
    transform: string | null;
    metricType: string | null;
  }>,
  measurementTime: number, // Unix timestamp in milliseconds
  previousLastValues: Map<number, number> = new Map(),
): Promise<void> {
  if (points.length === 0) return;

  try {
    // Calculate the 5-minute interval boundaries (in milliseconds)
    const intervalMs = 5 * 60 * 1000;
    const intervalEndMs = Math.ceil(measurementTime / intervalMs) * intervalMs;
    const intervalStartMs = intervalEndMs - intervalMs;

    // Build maps for quick lookup
    const pointTransforms = new Map(points.map((p) => [p.id, p.transform]));
    const pointMetricTypes = new Map(points.map((p) => [p.id, p.metricType]));

    // QUERY 1: Fetch all readings for all points in this interval (single query!)
    // Use > intervalStart AND <= intervalEnd (exclusive start, inclusive end)
    const allReadings = await db
      .select()
      .from(pointReadings)
      .where(
        and(
          eq(pointReadings.systemId, systemId),
          gt(pointReadings.measurementTime, intervalStartMs),
          lte(pointReadings.measurementTime, intervalEndMs),
        ),
      )
      .orderBy(pointReadings.pointId, pointReadings.measurementTime);

    if (allReadings.length === 0) {
      return; // No readings to aggregate
    }

    // Group readings by pointId, separating valid values from errors
    const pointGroups = new Map<
      number,
      {
        validReadings: Array<{ measurementTime: number; value: number }>;
        errorCount: number;
      }
    >();

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
          value: reading.value,
        });
      }
    }

    // Calculate aggregates for each point
    const aggregates = Array.from(pointGroups.entries()).map(
      ([pointId, group]) => {
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
            delta: null,
            sampleCount: 0,
            errorCount,
          };
        }

        const values = validReadings.map((r) => r.value);
        const last = validReadings[validReadings.length - 1].value;

        // Calculate delta based on point type
        const transform = pointTransforms.get(pointId);
        const metricType = pointMetricTypes.get(pointId);
        let delta: number | null = null;
        let avg: number | null;
        let min: number | null;
        let max: number | null;

        if (transform === "d") {
          // Differentiate: delta = last - previous interval's last
          const previousLast = previousLastValues.get(pointId);
          if (previousLast !== undefined) {
            delta = last - previousLast;
          }
          // If no previous value, delta remains null (can't calculate delta for first interval)

          // For differentiated points, don't calculate avg/min/max (they're not meaningful)
          avg = null;
          min = null;
          max = null;
        } else {
          // For non-differentiated points, calculate avg/min/max as normal
          avg = values.reduce((sum, v) => sum + v, 0) / values.length;
          min = Math.min(...values);
          max = Math.max(...values);

          // For energy metrics, also sum values into delta
          if (metricType === "energy") {
            delta = values.reduce((sum, v) => sum + v, 0);
          }
        }

        return {
          systemId,
          pointId,
          intervalEnd: intervalEndMs,
          avg,
          min,
          max,
          last,
          delta,
          sampleCount,
          errorCount,
        };
      },
    );

    if (aggregates.length === 0) return;

    // QUERY 2: Batch upsert all aggregates (single query!)
    await db
      .insert(pointReadingsAgg5m)
      .values(aggregates)
      .onConflictDoUpdate({
        target: [
          pointReadingsAgg5m.systemId,
          pointReadingsAgg5m.pointId,
          pointReadingsAgg5m.intervalEnd,
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

    // Use AEST timezone (600 min offset) for logging
    const intervalEndSec = Math.floor(intervalEndMs / 1000);
    console.log(
      `[PointAggregation] Updated ${aggregates.length} point aggregates for interval ending ${formatTimeAEST(fromUnixTimestamp(intervalEndSec, 600))}`,
    );
  } catch (error) {
    console.error("[PointAggregation] Error updating aggregated data:", error);
    // Don't throw - we don't want aggregation failures to break the main polling
  }
}
