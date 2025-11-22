/**
 * Point Manager - Backend-only manager for monitoring points
 * DO NOT import this on the frontend - use PointInfo directly instead
 */

import { db } from "@/lib/db";
import { pointInfo as pointInfoTable } from "@/lib/db/schema-monitoring-points";
import { eq, sql } from "drizzle-orm";
import { PointInfo } from "@/lib/point/point-info";
import {
  SeriesInfo,
  createSeriesInfos,
  getSeriesPath,
} from "@/lib/point/series-info";
import { SystemIdentifier, PointReference } from "@/lib/identifiers";
import { SystemWithPolling } from "@/lib/systems-manager";
import micromatch from "micromatch";

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
   * Get all points for a system
   */
  async getPointsForSystem(systemId: number): Promise<PointInfo[]> {
    const rows = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, systemId));

    return rows.map((row) => PointInfo.from(row));
  }

  /**
   * Get a specific point by system ID and point ID
   */
  async getPoint(systemId: number, pointId: number): Promise<PointInfo | null> {
    const rows = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, systemId));

    const point = rows.find((row) => row.index === pointId);
    return point ? PointInfo.from(point) : null;
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
    const allPoints = await this.getPointsForSystemInternal(system);
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
   * Get points for a system - handles both composite and non-composite systems
   * For composite: resolves point references from metadata.mappings
   * For non-composite: gets points directly for the system
   */
  private async getPointsForSystemInternal(
    system: SystemWithPolling,
  ): Promise<PointInfo[]> {
    if (system.vendorType === "composite") {
      return this.getPointsForCompositeSystem(system);
    } else {
      return this.getPointsForSystem(system.id);
    }
  }

  /**
   * Get points for a composite system by resolving metadata.mappings
   */
  private async getPointsForCompositeSystem(
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
   * Get all active points for a system
   * This is a convenience method for APIs that need point information without series details
   *
   * @param systemId - The system ID
   * @param typedOnly - If true, only includes points with type hierarchy. Default: false
   * @returns Array of unique PointInfo objects
   */
  async getActivePointsForSystem(
    systemId: number,
    typedOnly: boolean = false,
  ): Promise<PointInfo[]> {
    // We need the system object to use getAllSeriesForSystem
    // For now, we'll use the old getPointsForSystem method directly
    const allPoints = await this.getPointsForSystem(systemId);

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
}
