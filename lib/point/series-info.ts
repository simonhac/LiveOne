/**
 * Series Info - Complete information about a queryable data series
 *
 * This combines:
 * - Which device (SystemIdentifier)
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
  /** Device identifier */
  systemIdentifier: SystemIdentifier;

  /** The point this series belongs to */
  point: PointInfo;

  /** The aggregation field (e.g., "avg", "min", "max", "last", "delta") */
  aggregationField: string;

  /** Which intervals support this series */
  intervals: ("5m" | "1d")[];

  /**
   * True for a series that exists but is NOT offered unless it is asked for by name.
   *
   * 🛑 The case this was added for is an energy COUNTER's `.last`. `agg_5m.last` genuinely holds the
   * meter reading, and there is no other way to learn it — but it is the wrong answer to almost
   * every question: the meaningful quantity for an energy point is `.delta`, and a lifetime counter
   * plotted on a chart is a straight line climbing to 200 MWh. So it is reachable by `--series`,
   * and absent from a bare request that says "give me this device's series".
   */
  onDemand?: boolean;
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
  onDemandFields?: ReadonlySet<string>,
): SeriesInfo[] {
  return aggregationFields.map((aggregationField) => {
    const intervals = getSupportedIntervals(point.metricType, aggregationField);

    return {
      systemIdentifier,
      point,
      aggregationField,
      intervals,
      ...(onDemandFields?.has(aggregationField) ? { onDemand: true } : {}),
    };
  });
}

/**
 * Get the SeriesPath for a SeriesInfo
 */
export function getSeriesPath(series: SeriesInfo): SeriesPath {
  // Use getLogicalPath() method, with fallback for points without logicalPathStem
  const pointPath =
    series.point.getLogicalPath() ||
    `${series.point.index}/${series.point.metricType}`;

  return SeriesPath.fromComponents(
    series.systemIdentifier,
    pointPath,
    series.aggregationField,
  );
}
