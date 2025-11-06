import { db } from "@/lib/db";
import {
  pointInfo,
  pointReadings,
  pointReadingsAgg5m,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, sql } from "drizzle-orm";
import { updatePointAggregates5m } from "./point-aggregation-helper";

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
  // Create composite key
  const key = metadata.originSubId
    ? `${metadata.originId}:${metadata.originSubId}`
    : metadata.originId;

  // Return existing if found
  if (pointMap[key]) {
    return pointMap[key];
  }

  console.log(
    `[PointsManager] Creating point_info for ${metadata.defaultName}${metadata.originSubId ? "." + metadata.originSubId : ""}`,
  );

  // Get the next available id for this system
  const existingPoints = await db
    .select()
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));
  const maxId =
    existingPoints.length > 0
      ? Math.max(...existingPoints.map((p) => p.id))
      : 0;
  const nextId = maxId + 1;

  // Create new point_info entry
  const [newPoint] = await db
    .insert(pointInfo)
    .values({
      systemId,
      id: nextId,
      originId: metadata.originId,
      originSubId: metadata.originSubId || null,
      defaultName: metadata.defaultName,
      displayName: metadata.defaultName, // Initially same as default
      subsystem: metadata.subsystem || null,
      type: metadata.type || null,
      subtype: metadata.subtype || null,
      extension: metadata.extension || null,
      metricType: metadata.metricType,
      metricUnit: metadata.metricUnit,
    })
    .onConflictDoUpdate({
      target: [pointInfo.systemId, pointInfo.originId, pointInfo.originSubId],
      set: {
        defaultName: metadata.defaultName, // Update default name if changed from source
        // Don't update 'displayName', 'subsystem', 'type', 'subtype', 'extension' as they're user-modifiable
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
      pointId: point.id,
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

  // Aggregate the readings we just inserted
  const uniquePointIds = [...new Set(valuesToInsert.map((v) => v.pointId))];
  await updatePointAggregates5m(
    systemId,
    uniquePointIds,
    readings[0].measurementTime,
  );
}

/**
 * Batch insert pre-aggregated 5-minute readings directly to point_readings_agg_5m
 * Use this when the vendor already provides 5-minute aggregated data (e.g., Enphase)
 * Bypasses the point_readings table to avoid redundant storage
 */
export async function insertPointReadingsDirectTo5m(
  systemId: number,
  sessionId: number,
  readings: Array<{
    pointMetadata: PointMetadata;
    rawValue: any; // Raw value from vendor (will be converted based on metadata)
    intervalEndMs: number; // 5-minute interval end time in milliseconds
    error?: string | null;
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
    // avg = min = max = last = the value
    // If value is null, this is an error reading
    const isError = value === null;

    aggregatesToInsert.push({
      systemId,
      pointId: point.id,
      sessionId,
      intervalEnd: reading.intervalEndMs,
      avg: isError ? null : value,
      min: isError ? null : value,
      max: isError ? null : value,
      last: isError ? null : value,
      sampleCount: isError ? 0 : 1,
      errorCount: isError ? 1 : 0,
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
          sampleCount: sql`excluded.sample_count`,
          errorCount: sql`excluded.error_count`,
          updatedAt: sql`(unixepoch() * 1000)`,
        },
      });

    console.log(
      `[PointsManager] Inserted ${aggregatesToInsert.length} pre-aggregated 5m readings directly to point_readings_agg_5m`,
    );
  }
}
