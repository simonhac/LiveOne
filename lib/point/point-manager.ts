/**
 * Point Manager - Backend-only manager for monitoring points
 * DO NOT import this on the frontend - use PointInfo directly instead
 */

import { db } from "@/lib/db";
import { pointInfo as pointInfoTable } from "@/lib/db/schema-monitoring-points";
import { eq, sql } from "drizzle-orm";
import { PointInfo } from "@/lib/point/point-info";
import {
  FlavouredPoint,
  createFlavouredPoint,
  getSeriesPath,
} from "@/lib/point/flavoured-point";
import { SystemsManager, SystemWithPolling } from "@/lib/systems-manager";
import micromatch from "micromatch";

/**
 * Manages monitoring points for systems (backend only)
 */
export class PointManager {
  private static instance: PointManager;
  private static lastLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 60 * 1000; // 1 minute TTL
  private seriesCache = new Map<number, FlavouredPoint[]>();

  private constructor() {}

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

    const point = rows.find((row) => row.id === pointId);
    return point ? PointInfo.from(point) : null;
  }

  /**
   * Get all supported flavoured points for a non-composite system
   * Results are cached per system
   */
  private async getSupportedFlavouredPointsForSystem(
    systemId: number,
  ): Promise<FlavouredPoint[]> {
    // Check cache first
    const cached = this.seriesCache.get(systemId);
    if (cached) {
      return cached;
    }

    // Get all points for this system
    const allPoints = await this.getPointsForSystem(systemId);

    const flavouredPoints: FlavouredPoint[] = [];

    for (const point of allPoints) {
      // Skip inactive points or points without type
      if (!point.active || !point.type) continue;

      const pointIdentifier = point.getIdentifier();
      if (!pointIdentifier) continue;

      // Build FlavouredPoint for each supported aggregation based on metric type
      if (point.metricType === "energy") {
        // Energy: only delta
        flavouredPoints.push(createFlavouredPoint(point, "energy", "delta"));
      } else if (point.metricType === "soc") {
        // SOC: last for 5m, avg/min/max/last for 1d
        flavouredPoints.push(createFlavouredPoint(point, "soc", "last"));
        flavouredPoints.push(createFlavouredPoint(point, "soc", "avg"));
        flavouredPoints.push(createFlavouredPoint(point, "soc", "min"));
        flavouredPoints.push(createFlavouredPoint(point, "soc", "max"));
      } else {
        // Power and other: avg/min/max/last
        flavouredPoints.push(
          createFlavouredPoint(point, point.metricType, "avg"),
        );
        flavouredPoints.push(
          createFlavouredPoint(point, point.metricType, "min"),
        );
        flavouredPoints.push(
          createFlavouredPoint(point, point.metricType, "max"),
        );
        flavouredPoints.push(
          createFlavouredPoint(point, point.metricType, "last"),
        );
      }
    }

    // Cache the result
    this.seriesCache.set(systemId, flavouredPoints);

    return flavouredPoints;
  }

  /**
   * Get filtered flavoured points for a non-composite system or composite system
   *
   * For non-composite systems: Uses cache and filters by pattern/interval
   * For composite systems: Resolves point refs from metadata.mappings
   *
   * @param system - The system (composite or non-composite)
   * @param filter - Optional array of glob patterns to match against series paths (without system prefix)
   * @param interval - Interval to filter by ("5m" or "1d")
   * @returns Filtered flavoured points matching the criteria
   */
  async getFilteredSeriesForSystem(
    system: SystemWithPolling,
    filter?: string[],
    interval?: "5m" | "1d",
  ): Promise<FlavouredPoint[]> {
    let flavouredPoints: FlavouredPoint[];

    if (system.vendorType === "composite") {
      // Composite system: extract point refs from metadata.mappings
      flavouredPoints = await this.getFlavouredPointsForCompositeSystem(
        system,
        interval,
      );
    } else {
      // Non-composite system: use cached series
      flavouredPoints = await this.getSupportedFlavouredPointsForSystem(
        system.id,
      );

      // Filter by interval if provided
      if (interval) {
        flavouredPoints = flavouredPoints.filter((fp) =>
          this.supportsInterval(fp, interval),
        );
      }
    }

    // Filter by patterns if provided
    if (filter && filter.length > 0) {
      flavouredPoints = flavouredPoints.filter((fp) => {
        const seriesPath = getSeriesPath(fp);
        if (!seriesPath) return false;

        // getSeriesPath() returns "pointPath/flavourIdentifier" (e.g., "source.solar/power.avg")
        // which is already the series path without system identifier, so match directly
        return micromatch.isMatch(seriesPath, filter);
      });
    }

    return flavouredPoints;
  }

  /**
   * Get flavoured points for a composite system by resolving metadata.mappings
   */
  private async getFlavouredPointsForCompositeSystem(
    system: SystemWithPolling,
    interval?: "5m" | "1d",
  ): Promise<FlavouredPoint[]> {
    const metadata = system.metadata as any;

    // Validate metadata structure
    if (!metadata || metadata.version !== 2 || !metadata.mappings) {
      return [];
    }

    // Check if mappings is empty
    const hasAnyMappings = Object.values(metadata.mappings).some(
      (pointRefs) => Array.isArray(pointRefs) && pointRefs.length > 0,
    );
    if (!hasAnyMappings) {
      return [];
    }

    // Collect all point references (systemId.pointId format)
    const pointRefs: string[] = [];
    for (const [, refs] of Object.entries(metadata.mappings)) {
      if (Array.isArray(refs)) {
        pointRefs.push(...(refs as string[]));
      }
    }

    // Parse and validate point references
    const validPointRefs: Array<{ systemId: number; pointId: number }> = [];
    for (const ref of pointRefs) {
      const [systemIdStr, pointIdStr] = ref.split(".");
      const sourceSystemId = parseInt(systemIdStr);
      const pointId = parseInt(pointIdStr);

      if (!isNaN(sourceSystemId) && !isNaN(pointId)) {
        validPointRefs.push({ systemId: sourceSystemId, pointId });
      }
    }

    if (validPointRefs.length === 0) {
      return [];
    }

    // Fetch all points in one query
    const conditions = validPointRefs.map(
      (p) => sql`(system_id = ${p.systemId} AND id = ${p.pointId})`,
    );
    const pointsData = await db
      .select()
      .from(pointInfoTable)
      .where(sql`${sql.join(conditions, sql` OR `)}`);

    // Build FlavouredPoint for each point
    const flavouredPoints: FlavouredPoint[] = [];
    const systemsManager = SystemsManager.getInstance();

    for (const pointData of pointsData) {
      const point = PointInfo.from(pointData);

      // Skip inactive points or points without type
      if (!point.active || !point.type) continue;

      const pointIdentifier = point.getIdentifier();
      if (!pointIdentifier) continue;

      // Determine aggregation field based on metric type and interval
      let aggregationFields: string[];
      if (point.metricType === "energy") {
        aggregationFields = ["delta"];
      } else if (point.metricType === "soc") {
        if (!interval || interval === "5m") {
          aggregationFields = ["last"];
        } else {
          aggregationFields = ["avg", "min", "max", "last"];
        }
      } else {
        // Power and other
        if (!interval) {
          aggregationFields = ["avg", "min", "max", "last"];
        } else if (interval === "5m") {
          aggregationFields = ["avg"];
        } else {
          aggregationFields = ["avg", "min", "max"];
        }
      }

      for (const aggField of aggregationFields) {
        flavouredPoints.push(
          createFlavouredPoint(point, point.metricType, aggField),
        );
      }
    }

    return flavouredPoints;
  }

  /**
   * Check if a flavoured point supports a given interval
   */
  private supportsInterval(fp: FlavouredPoint, interval: "5m" | "1d"): boolean {
    const { metricType } = fp.point;
    const { aggregationField } = fp.flavour;

    if (metricType === "energy") {
      // Energy delta available in both 5m and 1d
      return aggregationField === "delta";
    } else if (metricType === "soc") {
      // SOC: last in 5m, avg/min/max/last in 1d
      if (interval === "5m") {
        return aggregationField === "last";
      } else {
        return ["avg", "min", "max", "last"].includes(aggregationField);
      }
    } else {
      // Power and other: avg in 5m, avg/min/max in 1d
      if (interval === "5m") {
        return aggregationField === "avg";
      } else {
        return ["avg", "min", "max"].includes(aggregationField);
      }
    }
  }

  /**
   * Invalidate the series cache for a specific system
   * Call this after any write operations to point_info
   */
  invalidateSeriesCache(systemId: number): void {
    this.seriesCache.delete(systemId);
  }

  /**
   * Invalidate the entire series cache
   * Call this if you're unsure which systems were affected
   */
  invalidateAllSeriesCache(): void {
    this.seriesCache.clear();
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
      shortName: string | null;
      transform: string | null;
    }>,
  ): Promise<void> {
    await db
      .update(pointInfoTable)
      .set(updates)
      .where(eq(pointInfoTable.id, pointIndex));

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
    shortName: string | null;
    active: boolean;
    transform: string | null;
  }): Promise<void> {
    await db.insert(pointInfoTable).values({
      systemId: pointData.systemId,
      id: pointData.index,
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
      shortName: pointData.shortName,
      active: pointData.active,
      transform: pointData.transform,
    });

    // Invalidate cache for this system
    this.invalidateSeriesCache(pointData.systemId);
  }
}
