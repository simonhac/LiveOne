/**
 * Point Manager - Backend-only manager for monitoring points
 * DO NOT import this on the frontend - use PointInfo directly instead
 *
 * This is the single source of truth for all point operations:
 * - Reading point definitions (getActivePointsForSystem, getSeriesForSystem)
 * - Writing point definitions (createPoint, updatePoint, ensurePointInfo)
 * - Inserting point readings (insertPointReading, insertPointReadingsRaw, insertPointReadingsAgg5m)
 */

import { and, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo as pgPointInfoTable } from "@/lib/db/planetscale/schema";
import { isFiveMinuteNativeVendor } from "@/lib/vendors/native-intervals";
import { PointInfo } from "@/lib/point/point-info";
import {
  SeriesInfo,
  createSeriesInfos,
  getSeriesPath,
} from "@/lib/point/series-info";
import { SystemIdentifier, PointReference } from "@/lib/identifiers";
import { derivePointUid } from "@/lib/identifiers/point-uid";
import { SystemWithPolling, SystemsManager } from "@/lib/systems-manager";
import { uuidv7 } from "uuidv7";
import micromatch from "micromatch";
import { updateLatestPointValue } from "../kv-cache-manager";
import { getAreaBindingRefs } from "@/lib/areas/bindings";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { getAreaDeviceSystemIds } from "@/lib/areas/devices";
import {
  updateSystemSummary,
  updateSubscriberSummaries,
} from "../system-summary-store";
import { publishObservationBatch } from "../observations/publisher";

// ============================================================================
// Types
// ============================================================================

/**
 * The served point_info row shape. Postgres stores native `createdAt`/`updatedAt`
 * timestamps; this served shape exposes the epoch-ms `createdAtMs`/`updatedAtMs`
 * fields that `PointInfo.from()` and the rest of the codebase consume (unchanged
 * from the long-standing legacy row shape).
 */
export interface PointInfoRow {
  systemId: number;
  index: number;
  physicalPathTail: string;
  logicalPathStem: string | null;
  metricType: string;
  metricUnit: string;
  defaultName: string;
  displayName: string;
  subsystem: string | null;
  transform: string | null;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number | null;
}

export interface PointInfoMap {
  [key: string]: PointInfoRow;
}

export interface PointMetadata {
  physicalPathTail: string; // "/" separated suffix, e.g., "solar_w", "B1/kwh"
  logicalPathStem: string | null; // "." separated, e.g., "source.solar"
  metricType: string;
  metricUnit: string;
  defaultName: string;
  subsystem?: string | null;
  transform: string | null;
}

/**
 * Session info for tracking when data was received
 */
export interface SessionInfo {
  id: string; // UUIDv7 (text); historical = stringified int
  started: Date;
  label?: string | null;
}

// ============================================================================
// point_info PG row → served shape
// ============================================================================

/**
 * Map a single PG point_info row to the served row shape.
 *
 * PG has native `createdAt`/`updatedAt` (Date); the served shape exposes epoch-ms
 * integer columns `createdAtMs`/`updatedAtMs` (number). Every other field passes
 * through. A missing `createdAt` collapses to 0, a missing `updatedAt` to null.
 */
function pgPointInfoToServed(
  pgRow: typeof pgPointInfoTable.$inferSelect,
): PointInfoRow {
  return {
    systemId: pgRow.systemId,
    index: pgRow.index,
    physicalPathTail: pgRow.physicalPathTail,
    logicalPathStem: pgRow.logicalPathStem,
    metricType: pgRow.metricType,
    metricUnit: pgRow.metricUnit,
    defaultName: pgRow.defaultName,
    displayName: pgRow.displayName,
    subsystem: pgRow.subsystem,
    transform: pgRow.transform,
    active: pgRow.active,
    createdAtMs: pgRow.createdAt ? pgRow.createdAt.getTime() : 0,
    updatedAtMs: pgRow.updatedAt ? pgRow.updatedAt.getTime() : null,
  };
}

/** Map an array of PG point_info rows to the served shape. */
function pgPointInfoRowsToServed(
  pgRows: (typeof pgPointInfoTable.$inferSelect)[],
): PointInfoRow[] {
  return pgRows.map(pgPointInfoToServed);
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
   * Load a device's own points directly from its `point_info`.
   * PRIVATE: External callers should use getActivePointsForSystem instead.
   */
  private async _loadOwnPoints(systemId: number): Promise<PointInfo[]> {
    const pgRows = await requirePlanetscaleDb()
      .select()
      .from(pgPointInfoTable)
      .where(eq(pgPointInfoTable.systemId, systemId));
    const rows = pgPointInfoRowsToServed(pgRows);

    return rows.map((row) => PointInfo.from(row));
  }

  /**
   * Get all series for a system (includes all active points, even without type hierarchy)
   * Results are cached per system
   * Works for any viewable handle (a real device or a multi-device area)
   *
   * @param system - The viewable system (a real device or a multi-device area)
   */
  private async getAllSeriesForSystem(
    system: SystemWithPolling,
  ): Promise<SeriesInfo[]> {
    // Check cache first
    const cached = this.seriesCache.get(system.id);
    if (cached) {
      return cached;
    }

    // Get all points for this system (areas-backed → bound refs; real device → own point_info)
    const allPoints = await this._resolvePointsForViewable(system);
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
   * Resolve the viewable points for a system handle — the single "resolve viewable" path.
   *
   * An Area is a grouping of 1..N member devices. A **real device** (an area-of-one's source, addressed
   * by its own `systems.id`) loads its own `point_info`. A **multi-device area** (an areas-backed handle
   * with no real `systems` row) resolves under the membership + override model: its typed `area_bindings`
   * SELECT the points (the override), and a curated multi-device area HAS bindings, so its bound child
   * refs ARE the set (unchanged). An area with NO bindings DEFAULTS to the union of its member devices'
   * own points (a plain "several devices in one area"). Dispatched on the structural area-handle signal
   * (no real `systems` row), not a vendorType string.
   *
   * Parity: an area-of-one's union-of-one is byte-identical to loading the device's own points, and
   * every existing multi-device area has bindings, so the union-default branch is dormant for current
   * data (verified by the per-area parity gate).
   *
   * PRIVATE: external callers should use getActivePointsForSystem instead.
   */
  private async _resolvePointsForViewable(
    system: SystemWithPolling,
  ): Promise<PointInfo[]> {
    // A real device loads its own point_info. A multi-device area (an area handle with no real
    // `systems` row) resolves area-natively: its typed `area_bindings` SELECT the points (the
    // override); an area with no bindings DEFAULTS to the union of its member devices' own points.
    if (!(await SystemsManager.getInstance().isAreaHandle(system.id))) {
      return this._loadOwnPoints(system.id);
    }

    const validPointRefs: PointReference[] = (
      await getAreaBindingRefs(system.id)
    ).map((r) => PointReference.fromIds(r.pointSystemId, r.pointId));

    if (validPointRefs.length > 0) {
      // Bindings present (override) → the bound child refs ARE the set. Fetch all in one query:
      // OR-of-(system_id,id) against Postgres point_info.
      const pgConditions = validPointRefs.map(
        (ref) => sql`(system_id = ${ref.systemId} AND id = ${ref.pointId})`,
      );
      const pgRows = await requirePlanetscaleDb()
        .select()
        .from(pgPointInfoTable)
        .where(sql`${sql.join(pgConditions, sql` OR `)}`);
      return pgPointInfoRowsToServed(pgRows).map((row) => PointInfo.from(row));
    }

    // No bindings → default to the union of the area's member devices' own points.
    const area = await getAreaForSystem(system.id);
    if (!area) return [];
    const memberSystemIds = await getAreaDeviceSystemIds(area.id);
    const unioned: PointInfo[] = [];
    for (const sid of memberSystemIds) {
      unioned.push(...(await this._loadOwnPoints(sid)));
    }
    return unioned;
  }

  /**
   * Get series for a system (works for any viewable handle — a real device or a multi-device area)
   *
   * Uses cache and applies filtering by pattern/interval/typedOnly
   *
   * @param system - The viewable system (a real device or a multi-device area)
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

    // Filter by typedOnly if requested (points with logicalPathStem)
    if (typedOnly) {
      seriesInfos = seriesInfos.filter(
        (series) => series.point.logicalPathStem !== null,
      );
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
   * Get all active points for a system (handles any viewable handle — a real device or a multi-device area)
   * This is the primary public API for getting point information
   *
   * @param systemId - The system ID
   * @param typedOnly - If true, only includes points with type hierarchy. Default: false
   * @returns Array of unique PointInfo objects
   */
  async getActivePointsForSystem(
    systemId: number,
    typedOnly: boolean = false,
    includeInactive: boolean = false,
  ): Promise<PointInfo[]> {
    // Resolve a real system OR an area view (multi-device Area handle) for the read data path.
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getViewableSystem(systemId);

    if (!system) {
      throw new Error(`System not found: ${systemId}`);
    }

    // Load points (areas-backed → bound refs; real device → own point_info)
    const allPoints = await this._resolvePointsForViewable(system);

    // Filter by active status (unless includeInactive) and optionally by typedOnly
    return allPoints.filter((point) => {
      if (!includeInactive && !point.active) return false;
      if (typedOnly && point.logicalPathStem === null) return false;
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
      logicalPathStem: string | null;
      transform: string | null;
    }>,
  ): Promise<void> {
    await requirePlanetscaleDb()
      .update(pgPointInfoTable)
      .set({
        ...updates,
        updatedAt: new Date(), // PG native timestamp
      })
      .where(
        and(
          eq(pgPointInfoTable.systemId, systemId),
          eq(pgPointInfoTable.index, pointIndex),
        ),
      );

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
    physicalPathTail: string;
    logicalPathStem: string | null;
    metricType: string;
    metricUnit: string;
    defaultName: string;
    displayName: string;
    subsystem?: string | null;
    active: boolean;
    transform: string | null;
  }): Promise<void> {
    await requirePlanetscaleDb()
      .insert(pgPointInfoTable)
      .values({
        systemId: pointData.systemId,
        index: pointData.index,
        physicalPathTail: pointData.physicalPathTail,
        logicalPathStem: pointData.logicalPathStem,
        metricType: pointData.metricType,
        metricUnit: pointData.metricUnit,
        defaultName: pointData.defaultName,
        displayName: pointData.displayName,
        subsystem: pointData.subsystem ?? null,
        active: pointData.active,
        transform: pointData.transform,
        createdAt: new Date(), // PG native timestamp
      });

    // Invalidate cache for this system
    this.invalidateSeriesCache(pointData.systemId);
  }

  // ============================================================================
  // Point Info Map Operations (for batch reading insertions)
  // ============================================================================

  /**
   * Load all point_info entries for a system and create a lookup map
   * Uses physicalPathTail as the key
   */
  async loadPointInfoMap(systemId: number): Promise<PointInfoMap> {
    const pgRows = await requirePlanetscaleDb()
      .select()
      .from(pgPointInfoTable)
      .where(eq(pgPointInfoTable.systemId, systemId));
    const points = pgPointInfoRowsToServed(pgRows);

    const pointMap: PointInfoMap = {};
    for (const point of points) {
      // Use physicalPathTail as the key
      pointMap[point.physicalPathTail] = point;
    }

    return pointMap;
  }

  /**
   * Get a single point by its physicalPathTail
   * Returns null if the point doesn't exist
   */
  async getPointByPhysicalPathTail(
    systemId: number,
    physicalPathTail: string,
  ): Promise<PointInfoRow | null> {
    const [pgRow] = await requirePlanetscaleDb()
      .select()
      .from(pgPointInfoTable)
      .where(
        and(
          eq(pgPointInfoTable.systemId, systemId),
          eq(pgPointInfoTable.physicalPathTail, physicalPathTail),
        ),
      )
      .limit(1);

    return pgRow ? pgPointInfoToServed(pgRow) : null;
  }

  /**
   * Get or create a point_info entry
   * Automatically invalidates cache when a new point is created
   */
  /** A unique violation specifically on pi_point_uid_unique (the deterministic-uid duplicate-site case). */
  private isPointUidCollision(e: unknown): boolean {
    if (!e || typeof e !== "object") return false;
    const err = e as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };
    if (err.code !== "23505") return false;
    return (
      err.constraint === "pi_point_uid_unique" ||
      (typeof err.message === "string" &&
        err.message.includes("pi_point_uid_unique"))
    );
  }

  async ensurePointInfo(
    systemId: number,
    pointMap: PointInfoMap,
    metadata: PointMetadata,
  ): Promise<PointInfoRow> {
    // Use physicalPathTail as the key - must match loadPointInfoMap
    const key = metadata.physicalPathTail;

    // Return existing if found
    if (pointMap[key]) {
      return pointMap[key];
    }

    console.log(
      `[PointManager] Creating point_info for ${metadata.defaultName} (${metadata.metricType}) at ${metadata.physicalPathTail}`,
    );

    let newPoint: PointInfoRow;

    {
      // Allocate the next index and create the row in Postgres. The max-index
      // scan reads the same store it writes.
      const pg = requirePlanetscaleDb();

      const existingPoints = await pg
        .select()
        .from(pgPointInfoTable)
        .where(eq(pgPointInfoTable.systemId, systemId));
      const maxIndex =
        existingPoints.length > 0
          ? Math.max(...existingPoints.map((p) => p.index))
          : 0;
      const nextIndex = maxIndex + 1;

      // Mint the stable point IDENTITY (point_uid) from the system's vendor identity. Deterministic so
      // re-onboarding the same physical point reproduces the same uid; on the rare duplicate-site
      // collision (pi_point_uid_unique) retry once with a random uid. A non-point_uid unique error
      // (e.g. stem/metric) is rethrown unchanged.
      const sys = await SystemsManager.getInstance().getSystem(systemId);
      const derivedUid = sys
        ? derivePointUid(
            sys.vendorType,
            sys.vendorSiteId,
            metadata.physicalPathTail,
          )
        : null;

      const insertValues = (pointUid: string | null) => ({
        systemId,
        index: nextIndex,
        physicalPathTail: metadata.physicalPathTail,
        logicalPathStem: metadata.logicalPathStem,
        metricType: metadata.metricType,
        metricUnit: metadata.metricUnit,
        defaultName: metadata.defaultName,
        displayName: metadata.defaultName, // Initially same as defaultName
        subsystem: metadata.subsystem || null,
        transform: metadata.transform,
        pointUid,
        createdAt: new Date(), // PG native timestamp
      });
      const onConflict = {
        target: [pgPointInfoTable.systemId, pgPointInfoTable.physicalPathTail],
        set: {
          // Update default name from source if it changed
          defaultName: metadata.defaultName,
          // Update transform if it changed
          transform: metadata.transform,
          updatedAt: new Date(),
          // point_uid is identity — deliberately NOT overwritten on conflict.
        },
      };
      const doInsert = async (pointUid: string | null) => {
        const [row] = await pg
          .insert(pgPointInfoTable)
          .values(insertValues(pointUid))
          .onConflictDoUpdate(onConflict)
          .returning();
        return row;
      };

      const pgRow = await (async () => {
        try {
          return await doInsert(derivedUid);
        } catch (e) {
          if (derivedUid && this.isPointUidCollision(e)) {
            const randomUid = uuidv7();
            console.warn(
              `[PointManager] point_uid collision for system ${systemId} "${metadata.physicalPathTail}" — using random uid ${randomUid}`,
            );
            return await doInsert(randomUid);
          }
          throw e;
        }
      })();

      // Map the PG-shaped row back to the legacy row shape this method returns
      // (epoch-ms columns) so downstream callers/pointMap are unchanged.
      newPoint = {
        systemId: pgRow.systemId,
        index: pgRow.index,
        physicalPathTail: pgRow.physicalPathTail,
        logicalPathStem: pgRow.logicalPathStem,
        metricType: pgRow.metricType,
        metricUnit: pgRow.metricUnit,
        defaultName: pgRow.defaultName,
        displayName: pgRow.displayName,
        subsystem: pgRow.subsystem,
        transform: pgRow.transform,
        active: pgRow.active,
        createdAtMs: pgRow.createdAt ? pgRow.createdAt.getTime() : 0,
        updatedAtMs: pgRow.updatedAt ? pgRow.updatedAt.getTime() : null,
      };
    }

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
   * Batch insert readings for multiple monitoring points
   * Automatically ensures point_info entries exist and converts values based on metadata
   *
   * @param systemId - The system ID
   * @param session - Session info containing id and started timestamp
   * @param readings - Array of readings to insert (receivedTimeMs comes from session.started)
   */
  async insertPointReadingsRaw(
    systemId: number,
    session: SessionInfo,
    readings: Array<{
      pointMetadata: PointMetadata;
      rawValue: any; // Raw value from vendor (will be converted based on metadata)
      measurementTime: number;
      dataQuality?: string;
      error?: string | null;
    }>,
    collector?: import("@/lib/observations/poll-collector").PollCollector,
  ): Promise<void> {
    if (readings.length === 0) return;

    // Load existing points for this system
    const pointMap = await this.loadPointInfoMap(systemId);

    // Get receivedTimeMs from session start time
    const receivedTimeMs = session.started.getTime();

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
        sessionId: session.id,
        sessionLabel: session.label ?? null,
        measurementTimeMs: reading.measurementTime,
        receivedTimeMs,
        value,
        valueStr,
        error: reading.error || null,
        dataQuality: reading.dataQuality || ("good" as const),
      });
    }

    // Publish observations to queue (before database insert)
    const systemsManager = await SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);
    if (system) {
      const inputs = valuesToInsert.map((v) => ({
        sessionId: session.id,
        point: Object.values(pointMap).find((p) => p.index === v.pointId)!,
        value: v.value,
        measurementTimeMs: v.measurementTimeMs,
        receivedTimeMs: v.receivedTimeMs,
        interval: "raw" as const,
      }));
      if (collector) {
        collector.add(inputs);
      } else {
        await publishObservationBatch(system, inputs);
      }
    }

    // Update KV cache with latest values. The raw point_readings and their 5m/1d
    // aggregates are materialised in Postgres by the queue receiver (from the
    // observations published above) — collection no longer writes the serving
    // store directly.
    await this.updateLatestReadingsCache(systemId, valuesToInsert);
  }

  /**
   * Batch insert pre-aggregated 5-minute readings directly to point_readings_agg_5m
   * Use this when the vendor already provides 5-minute aggregated data (e.g., Enphase)
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
   *
   * @param systemId - The system ID
   * @param session - Session info (null for historical backfills without a session)
   * @param readings - Array of readings to insert
   */
  async insertPointReadingsAgg5m(
    systemId: number,
    session: SessionInfo | null,
    readings: Array<{
      pointMetadata: PointMetadata;
      rawValue: any; // Raw value from vendor (will be converted based on metadata)
      intervalEndMs: number; // 5-minute interval end time in milliseconds
      error?: string | null;
      dataQuality?: string | null; // 'good', 'forecast', 'actual', 'billable', etc.
    }>,
    collector?: import("@/lib/observations/poll-collector").PollCollector,
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
      const { value: numericValue, valueStr: stringValue } =
        this.convertValueByMetadata(reading.rawValue, reading.pointMetadata);

      // For pre-aggregated data with a single value per interval:
      // - Energy metrics with transform='d': value goes into last (cumulative counter), avg/min/max/delta = null
      // - Energy metrics with transform!='d': value goes into delta (total energy), avg/min/max/last = null
      // - Text metrics: valueStr is stored, all numeric fields are null
      // - Other metrics: avg = min = max = last = value, delta = null
      // If both values are null, this is an error reading
      const isError = numericValue === null && stringValue === null;
      const isEnergyCounter =
        point.metricType === "energy" && point.transform === "d";
      const isEnergyDelta =
        point.metricType === "energy" && point.transform !== "d";

      aggregatesToInsert.push({
        systemId,
        pointId: point.index,
        sessionId: session?.id ?? null,
        intervalEnd: reading.intervalEndMs,
        avg: isError || isEnergyCounter || isEnergyDelta ? null : numericValue,
        min: isError || isEnergyCounter || isEnergyDelta ? null : numericValue,
        max: isError || isEnergyCounter || isEnergyDelta ? null : numericValue,
        last:
          !isError && isEnergyCounter
            ? numericValue
            : isError || isEnergyDelta
              ? null
              : numericValue,
        delta: !isError && isEnergyDelta ? numericValue : null,
        valueStr: stringValue,
        sampleCount: isError ? 0 : 1,
        errorCount: isError ? 1 : 0,
        dataQuality: reading.dataQuality ?? null,
      });
    }

    // Publish observations to queue (before database insert)
    // Only publish if we have a session (skip historical backfills)
    const systemsManager = await SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);

    // 5m-native vendors (Amber, Enphase) have NO raw point_readings, so their 5m
    // is authoritative and must be published to the queue (→ Postgres via the
    // receiver). Raw vendors' 5m is recomputed in Postgres from their raw
    // point_readings, so there is nothing to publish (or write) here.
    const isNative =
      system != null && isFiveMinuteNativeVendor(system.vendorType);

    if (system && session && aggregatesToInsert.length > 0 && isNative) {
      const inputs = aggregatesToInsert.map((a) => ({
        sessionId: session.id,
        point: Object.values(pointMap).find((p) => p.index === a.pointId)!,
        // Use the most meaningful value: delta for energy, otherwise avg/last, or string value
        value: a.delta ?? a.avg ?? a.last ?? a.valueStr,
        measurementTimeMs: a.intervalEnd,
        receivedTimeMs: Date.now(),
        interval: "5m" as const,
        // Carry the full aggregate tuple so the Postgres mirror is full-fidelity
        agg: {
          avg: a.avg,
          min: a.min,
          max: a.max,
          last: a.last,
          delta: a.delta,
          valueStr: a.valueStr,
          sampleCount: a.sampleCount,
          errorCount: a.errorCount,
          dataQuality: a.dataQuality,
        },
      }));
      if (collector) {
        collector.add(inputs);
      } else {
        await publishObservationBatch(system, inputs);
      }
    } else if (system && session && aggregatesToInsert.length > 0) {
      console.log(
        `[PointManager] raw-vendor 5m for system ${systemId} (${system!.vendorType}) is recomputed in Postgres from raw; nothing to publish (${aggregatesToInsert.length} intervals)`,
      );
    }

    // Note: We intentionally do NOT update the KV cache here.
    // Cache updates should only happen from real-time data in point_readings table
    // via insertPointReadingsRaw(). Pre-aggregated data is typically historical/backfill
    // and should not overwrite the actual latest values in the cache.
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Convert raw value to appropriate storage format based on metadata
   * Returns numeric value in `value` for most types, string value in `valueStr` for text/json types
   */
  private convertValueByMetadata(
    rawValue: any,
    metadata: PointMetadata,
  ): { value: number | null; valueStr: string | null } {
    if (rawValue == null) {
      return { value: null, valueStr: null };
    }

    // Handle text fields - store as string
    if (metadata.metricUnit === "text") {
      return { value: null, valueStr: String(rawValue) };
    }

    // Handle json fields (e.g., location) - store as JSON string
    if (metadata.metricUnit === "json") {
      const jsonStr =
        typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
      return { value: null, valueStr: jsonStr };
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
      valueStr?: string | null;
      measurementTimeMs: number;
      receivedTimeMs: number;
      sessionId?: string | null;
      sessionLabel?: string | null;
    }>,
  ): Promise<void> {
    try {
      const points = await this.getActivePointsForSystem(systemId, false);

      // Get system name for sourceSystemName in KV cache
      const systemsManager = SystemsManager.getInstance();
      const system = await systemsManager.getSystem(systemId);
      const sourceSystemName = system?.displayName;

      // Build summary values and cache updates together
      const summaryValues: Array<{ logicalPath: string; value: number }> = [];
      let maxMeasurementTimeMs = 0;

      const cacheUpdates = valuesToInsert.map((val) => {
        const point = points.find((p: PointInfo) => p.index === val.pointId);
        const logicalPath = point?.getLogicalPath();
        // Combine numeric and string values for cache (KV accepts both)
        const cacheValue = val.value ?? val.valueStr ?? null;
        // Only cache active points with a proper logicalPath and a value
        if (point && cacheValue !== null && logicalPath && point.active) {
          // Collect for system summary (only numeric values)
          if (typeof cacheValue === "number") {
            summaryValues.push({
              logicalPath,
              value: cacheValue,
            });
          }
          if (val.measurementTimeMs > maxMeasurementTimeMs) {
            maxMeasurementTimeMs = val.measurementTimeMs;
          }

          return updateLatestPointValue(
            systemId,
            val.pointId, // Pass point index for subscription lookup
            logicalPath,
            cacheValue,
            val.measurementTimeMs,
            val.receivedTimeMs,
            point.metricUnit,
            point.name, // displayName if set, otherwise defaultName
            sourceSystemName,
            val.sessionId ?? undefined,
            val.sessionLabel ?? undefined,
          );
        }
        return Promise.resolve();
      });
      await Promise.all(cacheUpdates);

      // Update system summary (fire-and-forget, don't block)
      if (summaryValues.length > 0) {
        updateSystemSummary(systemId, summaryValues, maxMeasurementTimeMs)
          .then(() => {
            // After updating source summary, update subscriber summaries
            return updateSubscriberSummaries(systemId);
          })
          .catch((err) =>
            console.error("Failed to update system summary:", err),
          );
      }
    } catch (error) {
      console.error("Failed to update KV cache:", error);
      // Don't throw - cache update failures shouldn't break reading insertion
    }
  }
}
