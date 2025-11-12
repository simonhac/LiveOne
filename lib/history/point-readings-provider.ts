import { db } from "@/lib/db";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/schema-monitoring-points";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
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
import { PointManager } from "@/lib/point/point-manager";
import { PointInfo } from "@/lib/point/point-info";

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
 * Generate a series path (pointPath/pointFlavour format) for a point
 * This is used to build the field name for the MeasurementSeries
 *
 * Note: PointManager now handles series filtering and interval logic.
 * This function is only used for constructing field names in the result.
 */
function generateSeriesPath(
  point: PointInfo,
  interval: "5m" | "30m" | "1d",
  column?: string,
): string {
  // Determine aggregation type based on metric type and interval
  // Use provided column if available (from SeriesInfo), otherwise infer from metricType
  let aggregationType: string;

  if (column) {
    aggregationType = column;
  } else if (interval === "1d") {
    // Daily intervals use delta for energy, avg for power/soc
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

  // If type and subtype are set, use series ID with identifier
  const pointIdentifier = point.getIdentifier();
  if (pointIdentifier) {
    return `${pointIdentifier}/${point.metricType}.${aggregationType}`;
  }

  // If shortName is set, use it directly
  if (point.shortName) {
    return point.shortName;
  }

  // Otherwise, use the point's database index as pointPath
  return `${point.index}/${point.metricType}.${aggregationType}`;
}

export class PointReadingsProvider implements HistoryDataProvider {
  // Track SQL queries for debugging/transparency
  private lastQueries: string[] = [];

  getLastQueries(): string[] {
    return this.lastQueries;
  }

  async fetch5MinuteData(
    system: SystemWithPolling,
    startTime: ZonedDateTime,
    endTime: ZonedDateTime,
    seriesPatterns?: string[],
  ): Promise<MeasurementSeries[]> {
    this.lastQueries = []; // Reset query tracking
    const startMs = toUnixTimestamp(startTime) * 1000;
    const endMs = toUnixTimestamp(endTime) * 1000;

    // Use PointManager to get filtered series (handles both pattern filtering and interval filtering)
    const pointManager = PointManager.getInstance();
    const filteredSeries = await pointManager.getFilteredSeriesForSystem(
      system,
      seriesPatterns,
      "5m",
    );

    if (filteredSeries.length === 0) {
      return [];
    }

    // Get unique point IDs from the filtered series
    const pointIds = [...new Set(filteredSeries.map((s) => s.point.index))];

    // Fetch PointInfo for these points
    const allPoints = await pointManager.getPointsForSystem(system.id);
    const allPointsMap = new Map(allPoints.map((p) => [p.index, p]));

    // Build map of point IDs to their PointInfo objects (only for points we need)
    const pointMap = new Map<number, PointInfo>();
    for (const pointId of pointIds) {
      const point = allPointsMap.get(pointId);
      if (point) {
        pointMap.set(pointId, point);
      }
    }

    // Fetch aggregated point readings within the time range
    // Only query for the specific point IDs we need
    const query = db
      .select()
      .from(pointReadingsAgg5m)
      .where(
        and(
          eq(pointReadingsAgg5m.systemId, system.id),
          inArray(pointReadingsAgg5m.pointId, pointIds),
          gte(pointReadingsAgg5m.intervalEnd, startMs),
          lte(pointReadingsAgg5m.intervalEnd, endMs),
        ),
      )
      .orderBy(pointReadingsAgg5m.intervalEnd);

    // Capture SQL before executing
    const sqlObj = query.toSQL();
    this.lastQueries.push(sqlObj.sql);

    const aggregates = await query;

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
      const pointPath = pointMeta.getIdentifier();

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
    this.lastQueries = []; // Reset query tracking
    const startDateStr = startDate.toString(); // YYYY-MM-DD format
    const endDateStr = endDate.toString(); // YYYY-MM-DD format

    // Use PointManager to get filtered series (handles both pattern filtering and interval filtering)
    const pointManager = PointManager.getInstance();
    const filteredSeries = await pointManager.getFilteredSeriesForSystem(
      system,
      seriesPatterns,
      "1d",
    );

    if (filteredSeries.length === 0) {
      return [];
    }

    // Get unique point IDs from the filtered series
    const pointIds = [...new Set(filteredSeries.map((s) => s.point.index))];

    // Build a map of which specific (pointId, column) combinations were requested
    // This ensures we only create series for the requested aggregations
    const requestedColumns = new Map<number, Set<string>>();
    for (const series of filteredSeries) {
      if (!requestedColumns.has(series.point.index)) {
        requestedColumns.set(series.point.index, new Set());
      }
      requestedColumns
        .get(series.point.index)!
        .add(series.flavour.aggregationField);
    }

    // Fetch PointInfo for these points
    const allPoints = await pointManager.getPointsForSystem(system.id);
    const allPointsMap = new Map(allPoints.map((p) => [p.index, p]));

    // Build map of point IDs to their PointInfo objects (only for points we need)
    const pointMap = new Map<number, PointInfo>();
    for (const pointId of pointIds) {
      const point = allPointsMap.get(pointId);
      if (point) {
        pointMap.set(pointId, point);
      }
    }

    // Fetch daily aggregated point readings within the date range
    // Only query for the specific point IDs we need
    const query = db
      .select()
      .from(pointReadingsAgg1d)
      .where(
        and(
          eq(pointReadingsAgg1d.systemId, system.id),
          inArray(pointReadingsAgg1d.pointId, pointIds),
          gte(pointReadingsAgg1d.day, startDateStr),
          lte(pointReadingsAgg1d.day, endDateStr),
        ),
      )
      .orderBy(pointReadingsAgg1d.day);

    // Capture SQL before executing
    const sqlObj = query.toSQL();
    this.lastQueries.push(sqlObj.sql);

    const aggregates = await query;

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
      const pointPath = pointMeta.getIdentifier();

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
          : `${pointMeta.index}/${pointFlavourSuffix}`;
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

      // For SOC metrics in daily intervals, create separate series for each requested aggregation
      if (pointMeta.metricType === "soc") {
        const columns = requestedColumns.get(pointId);
        if (columns?.has("avg")) {
          createSeries("soc.avg", "(avg)", (agg) => agg.avg);
        }
        if (columns?.has("min")) {
          createSeries("soc.min", "(min)", (agg) => agg.min);
        }
        if (columns?.has("max")) {
          createSeries("soc.max", "(max)", (agg) => agg.max);
        }
        if (columns?.has("last")) {
          createSeries("soc.last", "(last)", (agg) => agg.last);
        }
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
