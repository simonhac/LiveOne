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
   * The intervals in which this series exists but is NOT offered unless it is asked for by name.
   * Absent means "offered everywhere it exists".
   *
   * 🛑 The case this was added for is an energy COUNTER's `.last`. `agg_5m.last` genuinely holds the
   * meter reading, and there is no other way to learn it — but it is the wrong answer to almost
   * every question: the meaningful quantity for an energy point is `.delta`, and a lifetime counter
   * plotted on a chart is a straight line climbing to 200 MWh. So it is reachable by `--series`,
   * and absent from a bare request that says "give me this device's series". It is on demand in
   * BOTH intervals.
   *
   * 🛑 **Per-INTERVAL, not per-series, and that is the whole point of the shape.** A SoC point's
   * `avg`/`min`/`max` are ordinary listed series at 1d — a daily mean charge level is a real answer
   * — and on demand at 5m, where `last` is what anything sensible wants and three extra series per
   * soc point would be noise in every listing in the fleet. A boolean could not say that: marking
   * them on demand outright would have silently removed them from the 1d listings they have always
   * been part of.
   */
  onDemandIntervals?: ReadonlySet<"5m" | "1d">;
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
  /** Aggregation field → the intervals in which it is reachable only by name. */
  onDemandFields?: ReadonlyMap<string, ReadonlySet<"5m" | "1d">>,
): SeriesInfo[] {
  return aggregationFields.map((aggregationField) => {
    const intervals = getSupportedIntervals(point.metricType, aggregationField);
    const onDemandIntervals = onDemandFields?.get(aggregationField);

    return {
      systemIdentifier,
      point,
      aggregationField,
      intervals,
      ...(onDemandIntervals ? { onDemandIntervals } : {}),
    };
  });
}

/**
 * Is this series withheld from an unasked request — one that says "what does this subject have?"
 * rather than naming a series?
 *
 * With an `interval`, the question is exactly "is it on demand THERE". Without one (the
 * `?list=series` metadata mode, which deliberately takes no interval so an interval filter cannot
 * hide the 1d-only stats), a series is withheld only when it is on demand in EVERY interval it
 * supports — so an energy counter's `.last` stays out of the listing as it always has, while a SoC
 * `avg`, listed at 1d and on demand at 5m, stays in.
 */
export function isWithheldFromListing(
  series: SeriesInfo,
  interval?: "5m" | "1d",
): boolean {
  const onDemand = series.onDemandIntervals;
  if (!onDemand) return false;
  if (interval) return onDemand.has(interval);
  return series.intervals.every((i) => onDemand.has(i));
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
