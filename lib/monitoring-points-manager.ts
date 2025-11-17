import { db } from "@/lib/db";
import {
  pointInfo,
  pointReadings,
  pointReadingsAgg5m,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, sql } from "drizzle-orm";
import {
  updatePointAggregates5m,
  getPointsLastValues5m,
} from "./point-aggregation-helper";
import { updateLatestPointValue } from "./kv-cache-manager";
import { PointManager } from "./point/point-manager";

export interface PointInfoMap {
  [key: string]: typeof pointInfo.$inferSelect;
}

export interface PointMetadata {
  originId: string;
  originSubId?: string;
  defaultName: string;
  subsystem?: string | null;
  type?: string | null;
  subtype?: string | null;
  extension?: string | null;
  metricType: string;
  metricUnit: string;
  transform: string | null;
}

/**
 * Load all point_info entries for a system and create a lookup map
 */
export async function loadPointInfoMap(
  systemId: number,
): Promise<PointInfoMap> {
  const points = await db
    .select()
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));

  const pointMap: PointInfoMap = {};
  for (const point of points) {
    // Create composite key: originId[:originSubId]
    const key = point.originSubId
      ? `${point.originId}:${point.originSubId}`
      : point.originId;
    pointMap[key] = point;
  }

  return pointMap;
}

/**
 * Get or create a point_info entry
 */
export async function ensurePointInfo(
  systemId: number,
  pointMap: PointInfoMap,
  metadata: PointMetadata,
): Promise<typeof pointInfo.$inferSelect> {
  // Create composite key including metricType for uniqueness
  const key = [metadata.originId, metadata.originSubId, metadata.metricType]
    .filter(Boolean)
    .join(":");

  // Return existing if found
  if (pointMap[key]) {
    return pointMap[key];
  }

  console.log(
    `[PointsManager] Creating point_info for ${metadata.defaultName}${metadata.originSubId ? "." + metadata.originSubId : ""} (${metadata.metricType})`,
  );

  // Get the next available index for this system
  const existingPoints = await db
    .select()
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));
  const maxIndex =
    existingPoints.length > 0
      ? Math.max(...existingPoints.map((p) => p.index))
      : 0;
  const nextIndex = maxIndex + 1;

  // Create new point_info entry
  const [newPoint] = await db
    .insert(pointInfo)
    .values({
      systemId,
      index: nextIndex,
      originId: metadata.originId,
      originSubId: metadata.originSubId || null,
      defaultName: metadata.defaultName,
      displayName: metadata.defaultName, // Initially same as defaultName
      subsystem: metadata.subsystem || null,
      type: metadata.type || null,
      subtype: metadata.subtype || null,
      extension: metadata.extension || null,
      metricType: metadata.metricType,
      metricUnit: metadata.metricUnit,
      transform: metadata.transform,
      created: Date.now(),
    })
    .onConflictDoUpdate({
      target: [pointInfo.systemId, pointInfo.originId, pointInfo.originSubId],
      set: {
        // Update default name from source if it changed
        defaultName: metadata.defaultName,
        // Update transform if it changed
        transform: metadata.transform,
      },
    })
    .returning();

  // Add to cache
  pointMap[key] = newPoint;
  return newPoint;
}

/**
 * Insert a reading for a monitoring point
 */
export async function insertPointReading(
  systemId: number,
  pointInfoId: number,
  value: number | null,
  measurementTime: number,
  receivedTime: number,
  dataQuality: "good" | "error" | "estimated" | "interpolated" = "good",
  sessionId?: number | null,
  error?: string | null,
  valueStr?: string | null,
): Promise<void> {
  await db
    .insert(pointReadings)
    .values({
      systemId,
      pointId: pointInfoId,
      sessionId: sessionId || null,
      measurementTime,
      receivedTime,
      value: value !== null ? value : null,
      valueStr: valueStr || null,
      error: error || null,
      dataQuality,
    })
    .onConflictDoUpdate({
      target: [
        pointReadings.systemId,
        pointReadings.pointId,
        pointReadings.measurementTime,
      ],
      set: {
        value: value !== null ? value : null,
        valueStr: valueStr || null,
        receivedTime,
        error: error || null,
        dataQuality,
      },
    });
}

/**
 * Convert raw value to appropriate storage format based on metadata
 */
function convertValueByMetadata(
  rawValue: any,
  metadata: PointMetadata,
): { value: number | null; valueStr: string | null } {
  if (rawValue == null) {
    return { value: null, valueStr: null };
  }

  // Handle text fields
  if (metadata.metricUnit === "text") {
    return { value: null, valueStr: String(rawValue) };
  }

  // Handle timestamp fields (epochMs)
  if (metadata.metricUnit === "epochMs") {
    // If it's already a number (Unix timestamp in seconds), convert to ms
    if (typeof rawValue === "number") {
      return { value: rawValue * 1000, valueStr: null };
    }
    // If it's a string (ISO format), parse and convert to ms
    if (typeof rawValue === "string") {
      return { value: new Date(rawValue).getTime(), valueStr: null };
    }
    // If it's a Date object
    if (rawValue instanceof Date) {
      return { value: rawValue.getTime(), valueStr: null };
    }
  }

  // All other fields are numeric
  return { value: Number(rawValue), valueStr: null };
}

/**
 * Batch insert readings for multiple monitoring points
 * Automatically ensures point_info entries exist and converts values based on metadata
 */
export async function insertPointReadingsBatch(
  systemId: number,
  readings: Array<{
    pointMetadata: PointMetadata;
    rawValue: any; // Raw value from vendor (will be converted based on metadata)
    measurementTime: number;
    receivedTime: number;
    dataQuality?: "good" | "error" | "estimated" | "interpolated";
    sessionId?: number | null;
    error?: string | null;
  }>,
): Promise<void> {
  if (readings.length === 0) return;

  // Load existing points for this system
  const pointMap = await loadPointInfoMap(systemId);

  // Process each reading
  const valuesToInsert = [];
  for (const reading of readings) {
    // Ensure the point exists
    const point = await ensurePointInfo(
      systemId,
      pointMap,
      reading.pointMetadata,
    );

    // Convert raw value based on metadata
    const { value, valueStr } = convertValueByMetadata(
      reading.rawValue,
      reading.pointMetadata,
    );

    valuesToInsert.push({
      systemId,
      pointId: point.index,
      sessionId: reading.sessionId || null,
      measurementTime: reading.measurementTime,
      receivedTime: reading.receivedTime,
      value,
      valueStr,
      error: reading.error || null,
      dataQuality: reading.dataQuality || ("good" as const),
    });
  }

  // SQLite doesn't support ON CONFLICT for batch inserts well,
  // so we'll do them one by one for now
  for (const val of valuesToInsert) {
    await db
      .insert(pointReadings)
      .values(val)
      .onConflictDoUpdate({
        target: [
          pointReadings.systemId,
          pointReadings.pointId,
          pointReadings.measurementTime,
        ],
        set: {
          value: val.value,
          receivedTime: val.receivedTime,
          error: val.error,
          dataQuality: val.dataQuality,
        },
      });
  }

  // Update KV cache with latest values
  // Skip if KV is not configured (will log warning from kv.ts)
  try {
    const pointManager = PointManager.getInstance();
    const points = await pointManager.getPointsForSystem(systemId);

    const cacheUpdates = valuesToInsert.map((val) => {
      const point = points.find((p) => p.index === val.pointId);
      if (point && val.value !== null) {
        const pointPath = point.getPath().toString();
        return updateLatestPointValue(
          systemId,
          val.pointId, // Pass point index for subscription lookup
          pointPath,
          val.value,
          val.measurementTime,
          point.metricUnit,
          point.name, // displayName if set, otherwise defaultName
        );
      }
      return Promise.resolve();
    });
    await Promise.all(cacheUpdates);
  } catch (error) {
    console.error("Failed to update KV cache:", error);
    // Don't throw - cache update failures shouldn't break reading insertion
  }

  // Aggregate the readings we just inserted
  const uniquePointIds = [...new Set(valuesToInsert.map((v) => v.pointId))];

  // Build array of point objects with index, transform, and metricType for aggregation
  const pointsForAggregation = uniquePointIds.map((pointId) => {
    const point = Object.values(pointMap).find((p) => p.index === pointId);
    return {
      id: pointId,
      transform: point?.transform || null,
      metricType: point?.metricType || null,
    };
  });

  // Calculate interval boundaries to get previous interval's last values
  const measurementTime = readings[0].measurementTime;
  const intervalMs = 5 * 60 * 1000;
  const currentIntervalEnd =
    Math.ceil(measurementTime / intervalMs) * intervalMs;
  const previousIntervalEnd = currentIntervalEnd - intervalMs;

  // Get previous interval's last values for points with transform='d'
  const differentiatePointIds = pointsForAggregation
    .filter((p) => p.transform === "d")
    .map((p) => p.id);
  const previousLastValues = await getPointsLastValues5m(
    systemId,
    differentiatePointIds,
    previousIntervalEnd,
  );

  await updatePointAggregates5m(
    systemId,
    pointsForAggregation,
    measurementTime,
    previousLastValues,
  );
}

/**
 * Batch insert pre-aggregated 5-minute readings directly to point_readings_agg_5m
 * Use this when the vendor already provides 5-minute aggregated data (e.g., Enphase, Fronius)
 * Bypasses the point_readings table to avoid redundant storage
 *
 * Value placement by metric type:
 * 1a. Energy with transform='d' (cumulative counter, e.g., total kWh since install):
 *     - last = value (counter value at interval end)
 *     - avg/min/max/delta = null
 *     - Delta will be calculated later from difference between intervals
 *
 * 1b. Energy without transform='d' (interval energy, e.g., kWh produced in 5 minutes):
 *     - delta = value (total energy in this interval)
 *     - avg/min/max/last = null
 *     - This is summed directly into daily aggregates
 *
 * 2. Everything else (power, SOC, etc.):
 *    - avg = min = max = last = value (single measurement per interval)
 *    - delta = null
 */
export async function insertPointReadingsDirectTo5m(
  systemId: number,
  sessionId: number,
  readings: Array<{
    pointMetadata: PointMetadata;
    rawValue: any; // Raw value from vendor (will be converted based on metadata)
    intervalEndMs: number; // 5-minute interval end time in milliseconds
    error?: string | null;
    dataQuality?: string | null; // 'good', 'forecast', 'actual', 'billable', etc.
  }>,
): Promise<void> {
  if (readings.length === 0) return;

  // Load existing points for this system
  const pointMap = await loadPointInfoMap(systemId);

  // Process each reading
  const aggregatesToInsert = [];
  for (const reading of readings) {
    // Ensure the point exists
    const point = await ensurePointInfo(
      systemId,
      pointMap,
      reading.pointMetadata,
    );

    // Convert raw value based on metadata
    const { value, valueStr } = convertValueByMetadata(
      reading.rawValue,
      reading.pointMetadata,
    );

    // For pre-aggregated data with a single value per interval:
    // - Energy metrics with transform='d': value goes into last (cumulative counter), avg/min/max/delta = null
    // - Energy metrics with transform!='d': value goes into delta (total energy), avg/min/max/last = null
    // - Text metrics: valueStr is stored, all numeric fields are null
    // - Other metrics: avg = min = max = last = value, delta = null
    // If both value and valueStr are null, this is an error reading
    const isError = value === null && valueStr === null;
    const isEnergyCounter =
      point.metricType === "energy" && point.transform === "d";
    const isEnergyDelta =
      point.metricType === "energy" && point.transform !== "d";

    aggregatesToInsert.push({
      systemId,
      pointId: point.index,
      sessionId,
      intervalEnd: reading.intervalEndMs,
      avg: isError || isEnergyCounter || isEnergyDelta ? null : value,
      min: isError || isEnergyCounter || isEnergyDelta ? null : value,
      max: isError || isEnergyCounter || isEnergyDelta ? null : value,
      last:
        !isError && isEnergyCounter
          ? value
          : isError || isEnergyDelta
            ? null
            : value,
      delta: !isError && isEnergyDelta ? value : null,
      valueStr: valueStr,
      sampleCount: isError ? 0 : 1,
      errorCount: isError ? 1 : 0,
      dataQuality: reading.dataQuality ?? null,
    });
  }

  // Batch upsert all aggregates
  if (aggregatesToInsert.length > 0) {
    await db
      .insert(pointReadingsAgg5m)
      .values(aggregatesToInsert)
      .onConflictDoUpdate({
        target: [
          pointReadingsAgg5m.systemId,
          pointReadingsAgg5m.pointId,
          pointReadingsAgg5m.intervalEnd,
        ],
        set: {
          sessionId: sql`excluded.session_id`,
          avg: sql`excluded.avg`,
          min: sql`excluded.min`,
          max: sql`excluded.max`,
          last: sql`excluded.last`,
          delta: sql`excluded.delta`,
          valueStr: sql`excluded.value_str`,
          sampleCount: sql`excluded.sample_count`,
          errorCount: sql`excluded.error_count`,
          dataQuality: sql`excluded.data_quality`,
          updatedAt: sql`(unixepoch() * 1000)`,
        },
      });

    console.log(
      `[PointsManager] Inserted ${aggregatesToInsert.length} pre-aggregated 5m readings directly to point_readings_agg_5m`,
    );
  }

  // Update KV cache with latest values
  // Skip if KV is not configured (will log warning from kv.ts)
  try {
    const pointManager = PointManager.getInstance();
    const points = await pointManager.getPointsForSystem(systemId);

    const cacheUpdates = aggregatesToInsert.map((agg) => {
      const point = points.find((p) => p.index === agg.pointId);
      if (point) {
        // Determine which value to cache (prioritize last, then avg, then delta)
        const valueToCache = agg.last ?? agg.avg ?? agg.delta;

        if (valueToCache !== null && valueToCache !== undefined) {
          const pointPath = point.getPath().toString();
          return updateLatestPointValue(
            systemId,
            agg.pointId, // Pass point index for subscription lookup
            pointPath,
            valueToCache,
            agg.intervalEnd,
            point.metricUnit,
            point.name, // displayName if set, otherwise defaultName
          );
        }
      }
      return null;
    });

    await Promise.all(cacheUpdates.filter((p) => p !== null));
    console.log(
      `[PointsManager] Updated KV cache for ${cacheUpdates.filter((p) => p !== null).length} points`,
    );
  } catch (error) {
    console.error("Failed to update KV cache:", error);
    // Don't throw - cache update failures shouldn't break reading insertion
  }
}
