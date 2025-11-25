/**
 * Series Info - Complete information about a queryable data series
 *
 * This combines:
 * - Which system (SystemIdentifier)
 * - Which point (PointInfo)
 * - Which aggregation (e.g., "avg", "min", "max", "last", "delta")
 * - Which intervals are supported ("5m", "1d")
 */

import { PointInfo } from "./point-info";
import { SeriesPath, SystemIdentifier } from "@/lib/identifiers";
import { getSupportedIntervals } from "./point-series";

/**
 * Complete information about a data series
 */
export interface SeriesInfo {
  /** System identifier */
  systemIdentifier: SystemIdentifier;

  /** The point this series belongs to */
  point: PointInfo;

  /** The aggregation field (e.g., "avg", "min", "max", "last", "delta") */
  aggregationField: string;

  /** Which intervals support this series */
  intervals: ("5m" | "1d")[];
}

/**
 * Create multiple SeriesInfo objects from a point and array of aggregation fields
 *
 * @example
 * const series = createSeriesInfos(systemId, point, ["avg", "min", "max", "last"]);
 */
export function createSeriesInfos(
  systemIdentifier: SystemIdentifier,
  point: PointInfo,
  aggregationFields: string[],
): SeriesInfo[] {
  return aggregationFields.map((aggregationField) => {
    const intervals = getSupportedIntervals(point.metricType, aggregationField);

    return {
      systemIdentifier,
      point,
      aggregationField,
      intervals,
    };
  });
}

/**
 * Get the SeriesPath for a SeriesInfo
 */
export function getSeriesPath(series: SeriesInfo): SeriesPath {
  const pointPath = series.point.getPath();

  return SeriesPath.fromComponents(
    series.systemIdentifier,
    pointPath,
    series.aggregationField,
  );
}

/**
 * Get all SeriesInfo for a point (one per available aggregation)
 */
export function getAllSeriesForPoint(
  systemIdentifier: SystemIdentifier,
  point: PointInfo,
): SeriesInfo[] {
  let aggregationFields: string[];

  if (point.metricType === "energy") {
    aggregationFields = ["delta"];
  } else if (point.metricType === "soc") {
    aggregationFields = ["last", "avg", "min", "max"];
  } else {
    // Power and other metrics
    aggregationFields = ["avg", "min", "max", "last"];
  }

  return createSeriesInfos(systemIdentifier, point, aggregationFields);
}
