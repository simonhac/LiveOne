/**
 * Which stored intervals a (metricType, aggregationField) pair is actually served from.
 */

import { AggregationField, MetricType } from "@/lib/identifiers";

/**
 * Get supported intervals for a specific metric type and aggregation field
 */
export function getSupportedIntervals(
  metricType: string,
  aggregationField: string,
): ("5m" | "1d")[] {
  // Quality is available for all metric types in 5m only (not yet in 1d)
  if (aggregationField === AggregationField.QUALITY) {
    return ["5m"];
  }

  if (metricType === MetricType.ENERGY) {
    // Energy delta available in both 5m and 1d
    if (aggregationField === AggregationField.DELTA) return ["5m", "1d"];
    // 🛑 `last` on an energy point is the METER READING — the raw counter, for a `transform: 'd'`
    // point. It is stored (agg_5m.last / agg_1d.last) and there is no other way to read it, which
    // matters when a repair has to chain new counter values onto the ones either side of a gap.
    // It is marked ON DEMAND in `getAllSeriesForDevice`, so it never shows up unasked: for almost
    // every question `.delta` is the answer, and a lifetime counter on a chart is a straight line.
    if (aggregationField === AggregationField.LAST) return ["5m", "1d"];
    return [];
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
