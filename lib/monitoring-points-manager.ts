import { db } from "@/lib/db";
import { pointInfo, pointReadings } from "@/lib/db/schema-monitoring-points";
import { eq, and } from "drizzle-orm";
import { updatePointAggregates5m } from "./point-aggregation-helper";

export interface PointInfoMap {
  [key: string]: typeof pointInfo.$inferSelect;
}

export interface PointMetadata {
  pointId: string;
  pointSubId?: string;
  defaultName: string;
  subsystem?: string | null;
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
    // Create composite key: pointId[:pointSubId]
    const key = point.pointSubId
      ? `${point.pointId}:${point.pointSubId}`
      : point.pointId;
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
  const key = metadata.pointSubId
    ? `${metadata.pointId}:${metadata.pointSubId}`
    : metadata.pointId;

  // Return existing if found
  if (pointMap[key]) {
    return pointMap[key];
  }

  console.log(
    `[PointsManager] Creating point_info for ${metadata.defaultName}${metadata.pointSubId ? "." + metadata.pointSubId : ""}`,
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
      pointId: metadata.pointId,
      pointSubId: metadata.pointSubId || null,
      defaultName: metadata.defaultName,
      displayName: metadata.defaultName, // Initially same as default
      subsystem: metadata.subsystem || null,
      metricType: metadata.metricType,
      metricUnit: metadata.metricUnit,
    })
    .onConflictDoUpdate({
      target: [pointInfo.systemId, pointInfo.pointId, pointInfo.pointSubId],
      set: {
        defaultName: metadata.defaultName, // Update default name if changed from source
        // Don't update 'displayName' as it's user-modifiable
        // Don't update subsystem as it's user-modifiable
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
  value: number,
  measurementTime: number,
  receivedTime: number,
  dataQuality: "good" | "error" | "estimated" | "interpolated" = "good",
  sessionId?: number | null,
  error?: string | null,
): Promise<void> {
  await db
    .insert(pointReadings)
    .values({
      systemId,
      pointId: pointInfoId,
      sessionId: sessionId || null,
      measurementTime,
      receivedTime,
      value,
      error: error || null,
      dataQuality,
    })
    .onConflictDoUpdate({
      target: [pointReadings.pointId, pointReadings.measurementTime],
      set: {
        value,
        receivedTime,
        error: error || null,
        dataQuality,
      },
    });
}

/**
 * Batch insert readings for multiple monitoring points
 * Automatically ensures point_info entries exist
 */
export async function insertPointReadingsBatch(
  systemId: number,
  readings: Array<{
    pointMetadata: PointMetadata;
    value: number;
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

    valuesToInsert.push({
      systemId,
      pointId: point.id,
      sessionId: reading.sessionId || null,
      measurementTime: reading.measurementTime,
      receivedTime: reading.receivedTime,
      value: reading.value,
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
        target: [pointReadings.pointId, pointReadings.measurementTime],
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
