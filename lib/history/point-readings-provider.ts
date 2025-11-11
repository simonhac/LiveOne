import { db } from "@/lib/db";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, gte, lte } from "drizzle-orm";
import {
  CalendarDate,
  ZonedDateTime,
  parseDate,
} from "@internationalized/date";
import { toUnixTimestamp, fromUnixTimestamp } from "@/lib/date-utils";
import { SystemWithPolling } from "@/lib/systems-manager";
import {
  HistoryDataProvider,
  MeasurementSeries,
  TimeSeriesPoint,
} from "./types";
import { PointManager } from "@/lib/point-manager";
import { PointInfo } from "@/lib/point-info";
import micromatch from "micromatch";

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
 * Generate a series path (pointPath/pointFlavour format) for a point:
 * - If type is set: use {pointPath}/{pointFlavour}
 *   where pointPath = type.subtype.extension
 *   and pointFlavour = metricType.aggregation
 * - Otherwise if shortName is set: use shortName
 * - Otherwise: use point's database ID as pointPath
 *
 * Examples:
 *   - source.solar/power.avg
 *   - bidi.battery/energy.delta
 *   - load.hvac/power.avg
 *   - 123/power.avg (fallback using point ID)
 *
 * The aggregation type depends on metricType and interval:
 * - For daily (1d) intervals:
 *   - energy: use delta (daily total)
 *   - soc: use avg/min/max (daily statistics)
 *   - power: use avg (average power)
 * - For 5m/30m intervals:
 *   - power, energy: use avg (average over the interval)
 *   - soc: NOT INCLUDED (removed from 5m/30m)
 *   - default: use avg
 *
 * Note: The system prefix (systemIdentifier/) is added by OpenNEMConverter
 * to create the full series ID: {systemIdentifier}/{pointPath}/{pointFlavour}
 */
function generateSeriesPath(
  point: PointInfo,
  interval?: "5m" | "30m" | "1d",
): string {
  // Determine aggregation type based on metric type and interval
  let aggregationType: string;

  if (interval === "1d") {
    // Daily intervals use delta for energy, avg for power/other
    aggregationType = point.metricType === "energy" ? "delta" : "avg";
  } else {
    // 5m/30m intervals use delta for energy, last for SOC, avg for power/other
    if (point.metricType === "energy") {
      aggregationType = "delta";
    } else if (point.metricType === "soc") {
      aggregationType = "last";
    } else {
      aggregationType = "avg";
    }
  }

  // If type and subtype are set, use series ID with path
  const pointPath = point.getPath();
  if (pointPath) {
    // Format: {pointPath}/{pointFlavour}
    // where pointFlavour = metricType.aggregation
    return `${pointPath}/${point.metricType}.${aggregationType}`;
  }

  // If shortName is set, use it directly
  if (point.shortName) {
    return point.shortName;
  }

  // Otherwise, use the point's database ID as pointPath
  return `${point.id}/${point.metricType}.${aggregationType}`;
}

export class PointReadingsProvider implements HistoryDataProvider {
  /**
   * Helper method to filter and sort points by series ID
   * Filters to only include active points with type set
   */
  private filterAndSortPoints(
    points: PointInfo[],
    interval: "5m" | "30m" | "1d",
  ): PointInfo[] {
    return points
      .filter((p) => {
        // Must have type and be active
        if (!p.type || !p.active) return false;

        return true;
      })
      .sort((a, b) => {
        const aSeriesPath = generateSeriesPath(a, interval);
        const bSeriesPath = generateSeriesPath(b, interval);
        return aSeriesPath.localeCompare(bSeriesPath);
      });
  }

  async fetch5MinuteData(
    system: SystemWithPolling,
    startTime: ZonedDateTime,
    endTime: ZonedDateTime,
    seriesPatterns?: string[],
  ): Promise<MeasurementSeries[]> {
    const startMs = toUnixTimestamp(startTime) * 1000;
    const endMs = toUnixTimestamp(endTime) * 1000;

    // Get all active points for this system using PointManager
    const pointManager = PointManager.getInstance();
    const allPoints = await pointManager.getPointsForSystem(system.id);

    // Only include active points with type set, sorted by series ID
    // Excludes SOC for 5m intervals
    let filteredPoints = this.filterAndSortPoints(allPoints, "5m");

    // Apply series pattern filtering if provided (OR logic - match any pattern)
    if (seriesPatterns && seriesPatterns.length > 0) {
      filteredPoints = filteredPoints.filter((p) => {
        const seriesPath = generateSeriesPath(p, "5m");
        return micromatch.isMatch(seriesPath, seriesPatterns);
      });
    }

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
        // Only include if we have valid aggregate data (check all aggregate fields including delta)
        if (
          agg.avg !== null ||
          agg.min !== null ||
          agg.max !== null ||
          agg.last !== null ||
          agg.delta !== null
        ) {
          data.push({
            timestamp: fromUnixTimestamp(agg.intervalEnd / 1000, 600), // Use AEST timezone
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
      const seriesPath = generateSeriesPath(pointMeta, "5m");

      // Get pointPath using PointInfo method
      const pointPath = pointMeta.getPath();

      result.push({
        field: seriesPath,
        metadata: {
          id: seriesPath,
          label: pointMeta.name,
          type: pointMeta.metricType,
          unit: pointMeta.metricUnit,
          path: pointPath ?? undefined, // Convert null to undefined for optional field
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
    seriesPatterns?: string[],
  ): Promise<MeasurementSeries[]> {
    const startDateStr = startDate.toString(); // YYYY-MM-DD format
    const endDateStr = endDate.toString(); // YYYY-MM-DD format

    // Get all active points for this system using PointManager
    const pointManager = PointManager.getInstance();
    const allPoints = await pointManager.getPointsForSystem(system.id);

    // Only include active points with type set, sorted by series ID
    // Includes SOC for daily intervals
    let filteredPoints = this.filterAndSortPoints(allPoints, "1d");

    // Apply series pattern filtering if provided (OR logic - match any pattern)
    if (seriesPatterns && seriesPatterns.length > 0) {
      filteredPoints = filteredPoints.filter((p) => {
        const seriesPath = generateSeriesPath(p, "1d");
        return micromatch.isMatch(seriesPath, seriesPatterns);
      });
    }

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
      // Get aggregates for this point if they exist
      const pointAggregates = pointSeriesMap.get(pointId) || [];
      const pointPath = pointMeta.getPath();

      // Helper to create a series
      const createSeries = (
        pointFlavourSuffix: string,
        labelSuffix: string,
        extractValue: (agg: (typeof pointAggregates)[0]) => number | null,
      ): void => {
        const data: TimeSeriesPoint[] = [];
        for (const agg of pointAggregates) {
          const value = extractValue(agg);
          if (value !== null) {
            data.push({
              timestamp: parseDate(agg.day),
              value: { avg: applyTransform(value, pointMeta.transform) },
            });
          }
        }

        const seriesPath = pointPath
          ? `${pointPath}/${pointFlavourSuffix}`
          : `${pointMeta.id}/${pointFlavourSuffix}`;
        result.push({
          field: seriesPath,
          metadata: {
            id: seriesPath,
            label: labelSuffix
              ? `${pointMeta.name} ${labelSuffix}`
              : pointMeta.name,
            type: pointMeta.metricType,
            unit: pointMeta.metricUnit,
            path: pointPath ?? undefined,
          },
          data,
        });
      };

      // For SOC metrics in daily intervals, create 3 separate series (avg, min, max)
      if (pointMeta.metricType === "soc") {
        createSeries("soc.avg", "(avg)", (agg) => agg.avg);
        createSeries("soc.min", "(min)", (agg) => agg.min);
        createSeries("soc.max", "(max)", (agg) => agg.max);
      } else {
        // For non-SOC metrics, create a single series with all aggregate fields
        const data: TimeSeriesPoint[] = [];
        for (const agg of pointAggregates) {
          // Only include if we have valid aggregate data
          if (
            agg.avg !== null ||
            agg.min !== null ||
            agg.max !== null ||
            agg.delta !== null
          ) {
            data.push({
              timestamp: parseDate(agg.day),
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

        const seriesPath = generateSeriesPath(pointMeta, "1d");
        result.push({
          field: seriesPath,
          metadata: {
            id: seriesPath,
            label: pointMeta.name,
            type: pointMeta.metricType,
            unit: pointMeta.metricUnit,
            path: pointPath ?? undefined,
          },
          data,
        });
      }
    }

    return result;
  }

  getDataSource(interval: "5m" | "30m" | "1d"): string {
    return interval === "1d"
      ? "point_readings_agg_1d"
      : "point_readings_agg_5m";
  }
}
