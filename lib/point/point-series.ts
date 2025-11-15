/**
 * Point Series - A point with its available aggregation fields
 *
 * This replaces the old "FlavouredPoint" concept.
 * Instead of creating a separate object for each metric+aggregation combination,
 * we now associate a point with a list of available aggregations.
 */

import { PointInfo } from "./point-info";
import { AggregationField, MetricType } from "@/lib/identifiers";

/**
 * A point with its available aggregation fields
 */
export interface PointSeries {
  point: PointInfo;
  aggregations: string[]; // e.g., ["avg", "min", "max", "last"]
  intervals: ("5m" | "1d")[]; // Which intervals support this series
}

/**
 * Get available aggregations for a metric type
 */
export function getAggregationsForMetricType(metricType: string): {
  aggregations: string[];
  intervals: ("5m" | "1d")[];
} {
  if (metricType === MetricType.ENERGY) {
    // Energy: only delta, available in both 5m and 1d
    return {
      aggregations: [AggregationField.DELTA],
      intervals: ["5m", "1d"],
    };
  } else if (metricType === MetricType.SOC) {
    // SOC: last in 5m+1d, avg/min/max only in 1d
    // Return all aggregations, interval determination happens per aggregation
    return {
      aggregations: [
        AggregationField.LAST,
        AggregationField.AVG,
        AggregationField.MIN,
        AggregationField.MAX,
      ],
      intervals: ["5m", "1d"],
    };
  } else {
    // Power and other metrics: avg/last in both, min/max only in 1d
    return {
      aggregations: [
        AggregationField.AVG,
        AggregationField.MIN,
        AggregationField.MAX,
        AggregationField.LAST,
      ],
      intervals: ["5m", "1d"],
    };
  }
}

/**
 * Get supported intervals for a specific metric type and aggregation field
 */
export function getSupportedIntervals(
  metricType: string,
  aggregationField: string,
): ("5m" | "1d")[] {
  if (metricType === MetricType.ENERGY) {
    // Energy delta available in both 5m and 1d
    return aggregationField === AggregationField.DELTA ? ["5m", "1d"] : [];
  } else if (metricType === MetricType.SOC) {
    // SOC: last in both, avg/min/max only in 1d
    if (aggregationField === AggregationField.LAST) {
      return ["5m", "1d"];
    } else if (
      [
        AggregationField.AVG,
        AggregationField.MIN,
        AggregationField.MAX,
      ].includes(aggregationField as AggregationField)
    ) {
      return ["1d"];
    }
    return [];
  } else {
    // Power and other: all aggregations available in both 5m and 1d
    if (
      [
        AggregationField.AVG,
        AggregationField.MIN,
        AggregationField.MAX,
        AggregationField.LAST,
      ].includes(aggregationField as AggregationField)
    ) {
      return ["5m", "1d"];
    }
    return [];
  }
}

/**
 * Create a PointSeries from a PointInfo
 */
export function createPointSeries(point: PointInfo): PointSeries {
  const { aggregations, intervals } = getAggregationsForMetricType(
    point.metricType,
  );

  return {
    point,
    aggregations,
    intervals,
  };
}
