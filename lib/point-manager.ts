/**
 * Point Manager - Backend-only manager for monitoring points
 * DO NOT import this on the frontend - use PointInfo directly instead
 */

import { db } from "@/lib/db";
import { pointInfo as pointInfoTable } from "@/lib/db/schema-monitoring-points";
import { eq } from "drizzle-orm";
import { PointInfo } from "@/lib/point-info";
import { SeriesInfo } from "@/lib/types/series";
import { buildSiteIdFromSystem } from "@/lib/series-path-utils";
import { SystemsManager } from "@/lib/systems-manager";
import micromatch from "micromatch";

/**
 * Manages monitoring points for systems (backend only)
 */
export class PointManager {
  private static instance: PointManager;
  private seriesCache = new Map<number, SeriesInfo[]>();

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): PointManager {
    if (!PointManager.instance) {
      PointManager.instance = new PointManager();
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
   * Get all supported series for a system
   * Returns database column information for each series
   * Results are cached per system
   */
  async getSupportedSeriesForSystem(systemId: number): Promise<SeriesInfo[]> {
    // Check cache first
    const cached = this.seriesCache.get(systemId);
    if (cached) {
      return cached;
    }

    // Get system to build systemIdentifier
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);
    if (!system) {
      return [];
    }

    const systemIdentifier = buildSiteIdFromSystem(system);

    // Get all points for this system
    const allPoints = await this.getPointsForSystem(systemId);

    // Use a map to merge series with the same ID
    const seriesMap = new Map<string, SeriesInfo>();

    for (const point of allPoints) {
      // Skip inactive points or points without type
      if (!point.active || !point.type) continue;

      const pointPath = point.getPath();
      if (!pointPath) continue;

      // Determine which aggregations to expose based on metric type
      // Energy only has delta, SOC only in 1d, others have multiple aggregations

      if (point.metricType === "energy") {
        // Energy: only delta, available in both 5m and 1d
        const id = `${systemIdentifier}/${pointPath}/energy.delta`;
        seriesMap.set(id, {
          id,
          intervals: ["5m", "1d"],
          label: point.name,
          metricUnit: point.metricUnit,
          systemId,
          pointIndex: point.id,
          column: "delta",
        });
      } else if (point.metricType === "soc") {
        // SOC: avg, min, max - only available in 1d
        for (const column of ["avg", "min", "max"] as const) {
          const id = `${systemIdentifier}/${pointPath}/soc.${column}`;
          seriesMap.set(id, {
            id,
            intervals: ["1d"],
            label: `${point.name} (${column})`,
            metricUnit: point.metricUnit,
            systemId,
            pointIndex: point.id,
            column,
          });
        }
      } else {
        // Power and other metrics: avg, min, max, last - available in both 5m and 1d
        for (const column of ["avg", "min", "max", "last"] as const) {
          const id = `${systemIdentifier}/${pointPath}/${point.metricType}.${column}`;
          seriesMap.set(id, {
            id,
            intervals: ["5m", "1d"],
            label: `${point.name} (${column})`,
            metricUnit: point.metricUnit,
            systemId,
            pointIndex: point.id,
            column,
          });
        }
      }
    }

    // Convert map to array and sort by ID
    const result = Array.from(seriesMap.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    // Cache the result
    this.seriesCache.set(systemId, result);

    return result;
  }

  /**
   * Get filtered series for a system
   * Filters by patterns (glob) and/or interval
   * If filter or interval are not provided, returns all series (optionally filtered by the other parameter)
   *
   * @param systemId - The system ID
   * @param filter - Optional array of glob patterns to match against series paths (without system prefix)
   * @param interval - Optional interval to filter by ("5m" or "1d")
   * @returns Filtered series matching the criteria
   */
  async getFilteredSeriesForSystem(
    systemId: number,
    filter?: string[],
    interval?: "5m" | "1d",
  ): Promise<SeriesInfo[]> {
    // Get all series for this system (uses cache)
    let series = await this.getSupportedSeriesForSystem(systemId);

    // Filter by interval if provided
    if (interval) {
      series = series.filter((s) => s.intervals.includes(interval));
    }

    // Filter by patterns if provided
    if (filter && filter.length > 0) {
      series = series.filter((s) => {
        // Extract path without system identifier (everything after first /)
        const pathWithoutSystem = s.id.substring(s.id.indexOf("/") + 1);
        return micromatch.isMatch(pathWithoutSystem, filter);
      });
    }

    return series;
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
      originSubId: pointData.originSubId,
      defaultName: pointData.defaultName,
      displayName: pointData.displayName,
      subsystem: pointData.subsystem,
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

  /**
   * Delete a point
   * Automatically invalidates the series cache for the affected system
   */
  async deletePoint(
    systemId: number,
    pointIndex: number, // Database field is 'id', but we call it 'index' in TS code
  ): Promise<void> {
    await db.delete(pointInfoTable).where(eq(pointInfoTable.id, pointIndex));

    // Invalidate cache for this system
    this.invalidateSeriesCache(systemId);
  }
}
