import { db } from "@/lib/db";
import {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import {
  CalendarDate,
  ZonedDateTime,
  fromDate,
  parseDate,
} from "@internationalized/date";
import { toUnixTimestamp, fromUnixTimestamp } from "@/lib/date-utils";
import { SystemWithPolling } from "@/lib/systems-manager";
import {
  HistoryDataProvider,
  MeasurementSeries,
  MeasurementPointMetadata,
  MeasurementValue,
  TimeSeriesPoint,
} from "./types";
import { PointManager } from "@/lib/point-manager";
import { PointInfo } from "@/lib/point-info";

/**
 * Apply transform to a numeric value based on the transform type
 * - null or 'n': no transform (return original value)
 * - 'i': invert (multiply by -1)
 */
function applyTransform(
  value: number | null,
  transform: string | null,
): number | null {
  if (value === null) return null;
  if (!transform || transform === "n") return value;
  if (transform === "i") return -value;
  return value;
}

/**
 * Generate a point ID in the format:
 * - If type is set: use series ID {path}.{metricType}.{aggregation}
 *   where path = type.subtype.extension (omitting null parts)
 * - Otherwise if shortName is set: use shortName
 * - Otherwise: {originId}.{originSubId}.{metricType}.{aggregation} (omitting originSubId if null)
 *
 * The aggregation type is determined by metricType:
 * - power, energy: use .avg (average over the interval)
 * - soc: use .last (state at end of interval)
 * - default: use .avg
 *
 * Note: The vendor prefix (liveone.{vendorType}.{vendorSiteId}) is added by OpenNEMConverter
 */
function generatePointId(point: PointInfo): string {
  // Determine aggregation type based on metric type
  const aggregationType = point.metricType === "soc" ? "last" : "avg";

  // If type and subtype are set, use series ID with path
  const path = point.getPath();
  if (path) {
    return `${path}.${point.metricType}.${aggregationType}`;
  }

  // If shortName is set, use it directly
  if (point.shortName) {
    return point.shortName;
  }

  // Otherwise, build from components
  const parts = [point.originId];
  if (point.originSubId) {
    parts.push(point.originSubId);
  }
  parts.push(point.metricType);
  parts.push(aggregationType);
  return parts.join(".");
}

export class PointReadingsProvider implements HistoryDataProvider {
  /**
   * Helper method to filter and sort points by series ID
   * Filters to only include active points with type set
   */
  private filterAndSortPoints(points: PointInfo[]): PointInfo[] {
    return points
      .filter((p) => {
        // Must have type and be active
        return p.type && p.active;
      })
      .sort((a, b) => {
        const aSeriesId = generatePointId(a);
        const bSeriesId = generatePointId(b);
        return aSeriesId.localeCompare(bSeriesId);
      });
  }

  async fetch5MinuteData(
    system: SystemWithPolling,
    startTime: ZonedDateTime,
    endTime: ZonedDateTime,
  ): Promise<MeasurementSeries[]> {
    const startMs = toUnixTimestamp(startTime) * 1000;
    const endMs = toUnixTimestamp(endTime) * 1000;

    // Get all active points for this system using PointManager
    const pointManager = PointManager.getInstance();
    const allPoints = await pointManager.getPointsForSystem(system.id);

    // Only include active points with type set, sorted by series ID
    const filteredPoints = this.filterAndSortPoints(allPoints);

    if (filteredPoints.length === 0) {
      return [];
    }

    // Map point IDs to their PointInfo objects
    const pointMap = new Map(filteredPoints.map((p) => [p.id, p]));

    // Fetch aggregated point readings within the time range
    const aggregates = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(
        and(
          eq(pointReadingsAgg5m.systemId, system.id),
          gte(pointReadingsAgg5m.intervalEnd, startMs),
          lte(pointReadingsAgg5m.intervalEnd, endMs),
        ),
      )
      .orderBy(pointReadingsAgg5m.intervalEnd);

    // Group aggregates by point
    const pointSeriesMap = new Map<number, typeof aggregates>();

    for (const agg of aggregates) {
      if (!pointSeriesMap.has(agg.pointId)) {
        pointSeriesMap.set(agg.pointId, []);
      }
      pointSeriesMap.get(agg.pointId)!.push(agg);
    }

    // Convert to MeasurementSeries format - one series per point
    // Include all points, even those with no data
    const result: MeasurementSeries[] = [];

    for (const [pointId, pointMeta] of pointMap) {
      const data: TimeSeriesPoint[] = [];

      // Get aggregates for this point if they exist
      const pointAggregates = pointSeriesMap.get(pointId) || [];

      for (const agg of pointAggregates) {
        // Only include if we have valid aggregate data (check all aggregate fields)
        if (
          agg.avg !== null ||
          agg.min !== null ||
          agg.max !== null ||
          agg.last !== null
        ) {
          data.push({
            timestamp: fromUnixTimestamp(agg.intervalEnd / 1000, 600), // Use AEST timezone
            value: {
              avg: applyTransform(agg.avg, pointMeta.transform),
              min: applyTransform(agg.min, pointMeta.transform),
              max: applyTransform(agg.max, pointMeta.transform),
              last: applyTransform(agg.last, pointMeta.transform),
              count: agg.sampleCount,
            },
          });
        }
      }

      // Always include series with metadata, even if no data
      const fieldId = generatePointId(pointMeta);

      // Get path using PointInfo method
      const path = pointMeta.getPath();

      result.push({
        field: fieldId,
        metadata: {
          id: fieldId,
          label: pointMeta.name,
          type: pointMeta.metricType,
          unit: pointMeta.metricUnit,
          path: path ?? undefined, // Convert null to undefined for optional field
        },
        data,
      });
    }

    return result;
  }

  async fetchDailyData(
    system: SystemWithPolling,
    startDate: CalendarDate,
    endDate: CalendarDate,
  ): Promise<MeasurementSeries[]> {
    const startDateStr = startDate.toString(); // YYYY-MM-DD format
    const endDateStr = endDate.toString(); // YYYY-MM-DD format

    // Get all active points for this system using PointManager
    const pointManager = PointManager.getInstance();
    const allPoints = await pointManager.getPointsForSystem(system.id);

    // Only include active points with type set, sorted by series ID
    const filteredPoints = this.filterAndSortPoints(allPoints);

    if (filteredPoints.length === 0) {
      return [];
    }

    // Map point IDs to their PointInfo objects
    const pointMap = new Map(filteredPoints.map((p) => [p.id, p]));

    // Fetch daily aggregated point readings within the date range
    const aggregates = await db
      .select()
      .from(pointReadingsAgg1d)
      .where(
        and(
          eq(pointReadingsAgg1d.systemId, system.id),
          gte(pointReadingsAgg1d.day, startDateStr),
          lte(pointReadingsAgg1d.day, endDateStr),
        ),
      )
      .orderBy(pointReadingsAgg1d.day);

    // Group aggregates by point
    const pointSeriesMap = new Map<number, typeof aggregates>();

    for (const agg of aggregates) {
      if (!pointSeriesMap.has(agg.pointId)) {
        pointSeriesMap.set(agg.pointId, []);
      }
      pointSeriesMap.get(agg.pointId)!.push(agg);
    }

    // Convert to MeasurementSeries format - one series per point
    // Include all points, even those with no data
    const result: MeasurementSeries[] = [];

    for (const [pointId, pointMeta] of pointMap) {
      const data: TimeSeriesPoint[] = [];

      // Get aggregates for this point if they exist
      const pointAggregates = pointSeriesMap.get(pointId) || [];

      for (const agg of pointAggregates) {
        // Only include if we have valid aggregate data
        if (
          agg.avg !== null ||
          agg.min !== null ||
          agg.max !== null ||
          agg.delta !== null
        ) {
          data.push({
            timestamp: parseDate(agg.day), // Convert YYYY-MM-DD string to CalendarDate
            value: {
              avg: applyTransform(agg.avg, pointMeta.transform),
              min: applyTransform(agg.min, pointMeta.transform),
              max: applyTransform(agg.max, pointMeta.transform),
              last: applyTransform(agg.last, pointMeta.transform),
              delta: applyTransform(agg.delta, pointMeta.transform),
              count: agg.sampleCount,
            },
          });
        }
      }

      // Always include series with metadata, even if no data
      const fieldId = generatePointId(pointMeta);

      // Get path using PointInfo method
      const path = pointMeta.getPath();

      result.push({
        field: fieldId,
        metadata: {
          id: fieldId,
          label: pointMeta.name,
          type: pointMeta.metricType,
          unit: pointMeta.metricUnit,
          path: path ?? undefined, // Convert null to undefined for optional field
        },
        data,
      });
    }

    return result;
  }
}
