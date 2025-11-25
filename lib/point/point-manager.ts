/**
 * Point Manager - Backend-only manager for monitoring points
 * DO NOT import this on the frontend - use PointInfo directly instead
 *
 * This is the single source of truth for all point operations:
 * - Reading point definitions (getActivePointsForSystem, getSeriesForSystem)
 * - Writing point definitions (createPoint, updatePoint, ensurePointInfo)
 * - Inserting point readings (insertPointReading, insertPointReadingsBatch, insertPointReadingsDirectTo5m)
 */

import { db } from "@/lib/db";
import {
  pointInfo as pointInfoTable,
  pointReadings,
  pointReadingsAgg5m,
} from "@/lib/db/schema-monitoring-points";
import { eq, sql } from "drizzle-orm";
import { PointInfo } from "@/lib/point/point-info";
import {
  SeriesInfo,
  createSeriesInfos,
  getSeriesPath,
} from "@/lib/point/series-info";
import { SystemIdentifier, PointReference } from "@/lib/identifiers";
import { SystemWithPolling, SystemsManager } from "@/lib/systems-manager";
import micromatch from "micromatch";
import {
  updatePointAggregates5m,
  getPointsLastValues5m,
} from "../point-aggregation-helper";
import { updateLatestPointValue } from "../kv-cache-manager";

// ============================================================================
// Types
// ============================================================================

export interface PointInfoMap {
  [key: string]: typeof pointInfoTable.$inferSelect;
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
 * Manages monitoring points for systems (backend only)
 */
export class PointManager {
  private static instance: PointManager;
  private static lastLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 60 * 1000; // 1 minute TTL
  private seriesCache = new Map<number, SeriesInfo[]>();

  private constructor() {}

  /**
   * Get cache status information
   */
  static getCacheStatus(): {
    isLoaded: boolean;
    lastLoadedAt: number;
  } {
    return {
      isLoaded:
        PointManager.instance !== null && PointManager.instance !== undefined,
      lastLoadedAt: PointManager.lastLoadedAt,
    };
  }

  /**
   * Get the singleton instance
   * Automatically refreshes cache if TTL has expired
   */
  static getInstance(): PointManager {
    const now = Date.now();
    const cacheAge = now - PointManager.lastLoadedAt;

    // Clear and reload if cache is stale (older than TTL)
    if (PointManager.instance && cacheAge > PointManager.CACHE_TTL_MS) {
      console.log(
        `[PointManager] Cache expired (age: ${Math.round(cacheAge / 1000)}s), clearing...`,
      );
      PointManager.instance = new PointManager();
      PointManager.lastLoadedAt = now;
    }

    if (!PointManager.instance) {
      PointManager.instance = new PointManager();
      PointManager.lastLoadedAt = now;
    }
    return PointManager.instance;
  }

  /**
   * Load points directly from database for non-composite systems
   * PRIVATE: External callers should use getActivePointsForSystem instead
   */
  private async _loadPointsForNonCompositeSystem(
    systemId: number,
  ): Promise<PointInfo[]> {
    const rows = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, systemId));

    return rows.map((row) => PointInfo.from(row));
  }

  /**
   * Get all series for a system (includes all active points, even without type hierarchy)
   * Results are cached per system
   * Works for both composite and non-composite systems
   *
   * @param system - The system (composite or non-composite)
   */
  private async getAllSeriesForSystem(
    system: SystemWithPolling,
  ): Promise<SeriesInfo[]> {
    // Check cache first
    const cached = this.seriesCache.get(system.id);
    if (cached) {
      return cached;
    }

    // Get all points for this system (handles both composite and non-composite)
    const allPoints = await this._loadPointsWithCompositeSupport(system);
    const systemIdentifier = SystemIdentifier.fromId(system.id);

    const seriesInfos: SeriesInfo[] = [];

    for (const point of allPoints) {
      // Only skip inactive points
      if (!point.active) continue;

      // Determine aggregation fields based on metric type
      let aggregationFields: string[];
      if (point.metricType === "energy") {
        // Energy: only delta (+ quality for data source tracking)
        aggregationFields = ["delta", "quality"];
      } else if (point.metricType === "soc") {
        // SOC: last for 5m, avg/min/max/last for 1d (+ quality)
        aggregationFields = ["last", "avg", "min", "max", "quality"];
      } else {
        // Power and other: avg/min/max/last (+ quality)
        aggregationFields = ["avg", "min", "max", "last", "quality"];
      }

      // Create SeriesInfo for each aggregation
      seriesInfos.push(
        ...createSeriesInfos(systemIdentifier, point, aggregationFields),
      );
    }

    // Cache the result
    this.seriesCache.set(system.id, seriesInfos);

    return seriesInfos;
  }

  /**
   * Load points for a system - handles both composite and non-composite systems
   * For composite: resolves point references from metadata.mappings
   * For non-composite: loads points directly from database
   * PRIVATE: External callers should use getActivePointsForSystem instead
   */
  private async _loadPointsWithCompositeSupport(
    system: SystemWithPolling,
  ): Promise<PointInfo[]> {
    if (system.vendorType === "composite") {
      return this._resolveCompositeSystemPoints(system);
    } else {
      return this._loadPointsForNonCompositeSystem(system.id);
    }
  }

  /**
   * Resolve points for a composite system by looking up references in metadata.mappings
   * PRIVATE: External callers should use getActivePointsForSystem instead
   */
  private async _resolveCompositeSystemPoints(
    system: SystemWithPolling,
  ): Promise<PointInfo[]> {
    const metadata = system.metadata as any;

    // Validate metadata structure
    if (!metadata || metadata.version !== 2 || !metadata.mappings) {
      return [];
    }

    // Collect all point references (systemId.pointId format)
    const pointRefStrs: string[] = [];
    for (const [, refs] of Object.entries(metadata.mappings)) {
      if (Array.isArray(refs)) {
        pointRefStrs.push(...(refs as string[]));
      }
    }

    if (pointRefStrs.length === 0) {
      return [];
    }

    // Parse and validate point references using PointReference
    const validPointRefs: PointReference[] = [];
    for (const refStr of pointRefStrs) {
      const pointRef = PointReference.parse(refStr);
      if (pointRef) {
        validPointRefs.push(pointRef);
      }
    }

    if (validPointRefs.length === 0) {
      return [];
    }

    // Fetch all points in one query
    const conditions = validPointRefs.map(
      (ref) => sql`(system_id = ${ref.systemId} AND id = ${ref.pointId})`,
    );
    const pointsData = await db
      .select()
      .from(pointInfoTable)
      .where(sql`${sql.join(conditions, sql` OR `)}`);

    return pointsData.map((row) => PointInfo.from(row));
  }

  /**
   * Get series for a system (works for both composite and non-composite systems)
   *
   * Uses cache and applies filtering by pattern/interval/typedOnly
   *
   * @param system - The system (composite or non-composite)
   * @param filter - Optional array of glob patterns to match against series paths (without system prefix)
   * @param interval - Optional interval to filter by ("5m" or "1d")
   * @param typedOnly - If true, only includes points with type hierarchy (excludes fallback paths). Default: false
   * @returns Series matching the criteria
   */
  async getSeriesForSystem(
    system: SystemWithPolling,
    filter?: string[],
    interval?: "5m" | "1d",
    typedOnly: boolean = false,
  ): Promise<SeriesInfo[]> {
    // Get all series for this system (uses cache)
    let seriesInfos = await this.getAllSeriesForSystem(system);

    // Filter by interval if provided
    if (interval) {
      seriesInfos = seriesInfos.filter((series) =>
        series.intervals.includes(interval),
      );
    }

    // Filter by typedOnly if requested
    if (typedOnly) {
      seriesInfos = seriesInfos.filter((series) => series.point.type !== null);
    }

    // Filter by patterns if provided
    if (filter && filter.length > 0) {
      seriesInfos = seriesInfos.filter((series) => {
        const seriesPath = getSeriesPath(series);

        // getSeriesPath() returns SeriesPath object, convert to string
        // Format: "systemId/pointPath.aggregationField" (e.g., "1/source.solar/power.avg")
        const pathStr = seriesPath.toString();

        // Remove system identifier prefix to match against point path patterns
        // Pattern format: "source.solar/power.avg" (without system prefix)
        const pathWithoutSystem = pathStr.substring(pathStr.indexOf("/") + 1);

        return micromatch.isMatch(pathWithoutSystem, filter);
      });
    }

    return seriesInfos;
  }

  /**
   * Get all active points for a system (handles both composite and non-composite systems)
   * This is the primary public API for getting point information
   *
   * @param systemId - The system ID
   * @param typedOnly - If true, only includes points with type hierarchy. Default: false
   * @returns Array of unique PointInfo objects
   */
  async getActivePointsForSystem(
    systemId: number,
    typedOnly: boolean = false,
  ): Promise<PointInfo[]> {
    // Look up the system object (needed for composite system handling)
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);

    if (!system) {
      throw new Error(`System not found: ${systemId}`);
    }

    // Load points (handles both composite and non-composite)
    const allPoints = await this._loadPointsWithCompositeSupport(system);

    // Filter active and optionally by typedOnly
    return allPoints.filter((point) => {
      if (!point.active) return false;
      if (typedOnly && point.type === null) return false;
      return true;
    });
  }

  /**
   * Invalidate the entire cache (both singleton instance and series cache)
   * This forces a complete reload on next access
   */
  static invalidateCache(): void {
    if (PointManager.instance) {
      PointManager.instance.seriesCache.clear();
    }
    PointManager.instance = undefined as any;
    PointManager.lastLoadedAt = 0;
  }

  /**
   * Invalidate the series cache for a specific system
   * Call this after any write operations to point_info
   */
  invalidateSeriesCache(systemId: number): void {
    this.seriesCache.delete(systemId);
  }

  /**
   * Update a point's information
   * Automatically invalidates the series cache for the affected system
   */
  async updatePoint(
    systemId: number,
    pointIndex: number, // Database field is 'id', but we call it 'index' in TS code
    updates: Partial<{
      displayName: string;
      active: boolean;
      type: string | null;
      subtype: string | null;
      extension: string | null;
      metricType: string;
      metricUnit: string;
      alias: string | null;
      transform: string | null;
    }>,
  ): Promise<void> {
    await db
      .update(pointInfoTable)
      .set({
        ...updates,
        updatedAt: Date.now(), // Unix milliseconds
      })
      .where(eq(pointInfoTable.index, pointIndex));

    // Invalidate cache for this system
    this.invalidateSeriesCache(systemId);
  }

  /**
   * Create a new point
   * Automatically invalidates the series cache for the affected system
   */
  async createPoint(pointData: {
    systemId: number;
    index: number; // Database field is 'id', but we call it 'index' in TS code
    originId: string;
    originSubId?: string | null;
    defaultName: string;
    displayName: string;
    subsystem?: string | null;
    type: string | null;
    subtype: string | null;
    extension: string | null;
    metricType: string;
    metricUnit: string;
    alias: string | null;
    active: boolean;
    transform: string | null;
  }): Promise<void> {
    await db.insert(pointInfoTable).values({
      systemId: pointData.systemId,
      index: pointData.index,
      originId: pointData.originId,
      originSubId: pointData.originSubId ?? null,
      defaultName: pointData.defaultName,
      displayName: pointData.displayName,
      subsystem: pointData.subsystem ?? null,
      type: pointData.type,
      subtype: pointData.subtype,
      extension: pointData.extension,
      metricType: pointData.metricType,
      metricUnit: pointData.metricUnit,
      alias: pointData.alias,
      active: pointData.active,
      transform: pointData.transform,
    });

    // Invalidate cache for this system
    this.invalidateSeriesCache(pointData.systemId);
  }

  // ============================================================================
  // Point Info Map Operations (for batch reading insertions)
  // ============================================================================

  /**
   * Load all point_info entries for a system and create a lookup map
   */
  async loadPointInfoMap(systemId: number): Promise<PointInfoMap> {
    const points = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, systemId));

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
   * Automatically invalidates cache when a new point is created
   */
  async ensurePointInfo(
    systemId: number,
    pointMap: PointInfoMap,
    metadata: PointMetadata,
  ): Promise<typeof pointInfoTable.$inferSelect> {
    // Create composite key: originId[:originSubId] - must match loadPointInfoMap
    const key = metadata.originSubId
      ? `${metadata.originId}:${metadata.originSubId}`
      : metadata.originId;

    // Return existing if found
    if (pointMap[key]) {
      return pointMap[key];
    }

    console.log(
      `[PointManager] Creating point_info for ${metadata.defaultName}${metadata.originSubId ? "." + metadata.originSubId : ""} (${metadata.metricType})`,
    );

    // Get the next available index for this system
    const existingPoints = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, systemId));
    const maxIndex =
      existingPoints.length > 0
        ? Math.max(...existingPoints.map((p) => p.index))
        : 0;
    const nextIndex = maxIndex + 1;

    // Create new point_info entry
    const [newPoint] = await db
      .insert(pointInfoTable)
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
        target: [
          pointInfoTable.systemId,
          pointInfoTable.originId,
          pointInfoTable.originSubId,
        ],
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

    // Invalidate series cache since we created a new point
    this.invalidateSeriesCache(systemId);

    return newPoint;
  }

  // ============================================================================
  // Reading Write Operations
  // ============================================================================

  /**
   * Insert a reading for a monitoring point
   */
  async insertPointReading(
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
   * Batch insert readings for multiple monitoring points
   * Automatically ensures point_info entries exist and converts values based on metadata
   */
  async insertPointReadingsBatch(
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
    const pointMap = await this.loadPointInfoMap(systemId);

    // Process each reading
    const valuesToInsert = [];
    for (const reading of readings) {
      // Ensure the point exists
      const point = await this.ensurePointInfo(
        systemId,
        pointMap,
        reading.pointMetadata,
      );

      // Convert raw value based on metadata
      const { value, valueStr } = this.convertValueByMetadata(
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
    await this.updateLatestReadingsCache(systemId, valuesToInsert);

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
  async insertPointReadingsDirectTo5m(
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
    const pointMap = await this.loadPointInfoMap(systemId);

    // Process each reading
    const aggregatesToInsert = [];
    for (const reading of readings) {
      // Ensure the point exists
      const point = await this.ensurePointInfo(
        systemId,
        pointMap,
        reading.pointMetadata,
      );

      // Convert raw value based on metadata
      const { value, valueStr } = this.convertValueByMetadata(
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
        `[PointManager] Inserted ${aggregatesToInsert.length} pre-aggregated 5m readings directly to point_readings_agg_5m`,
      );
    }

    // Note: We intentionally do NOT update the KV cache here.
    // Cache updates should only happen from real-time data in point_readings table
    // via insertPointReadingsBatch(). Pre-aggregated data is typically historical/backfill
    // and should not overwrite the actual latest values in the cache.
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Convert raw value to appropriate storage format based on metadata
   */
  private convertValueByMetadata(
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
   * Update KV cache with latest point values
   * This is called after inserting new readings to keep the cache fresh
   */
  private async updateLatestReadingsCache(
    systemId: number,
    valuesToInsert: Array<{
      pointId: number;
      value: number | null;
      measurementTime: number;
    }>,
  ): Promise<void> {
    try {
      const points = await this.getActivePointsForSystem(systemId, false);

      const cacheUpdates = valuesToInsert.map((val) => {
        const point = points.find((p: PointInfo) => p.index === val.pointId);
        if (point && val.value !== null) {
          const pointPath = point.getPath();
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
  }
}
