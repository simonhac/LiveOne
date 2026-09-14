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
    // SOC: `last` is the answer at every interval — a charge level is a level, so the value AT the
    // interval is what the question means, and it is what every chart and the KV latest map read.
    //
    // `avg`/`min`/`max` are stored at 5m too (the 1d figures are aggregated from those very
    // columns, and the battery-provenance fold reads `agg_5m.avg` directly via `readAgg5m`) but
    // they were withheld from 5m serving until 2026-09-15. They are now reachable and marked ON
    // DEMAND at 5m in `getAllSeriesForDevice` — so nothing new appears in an unasked listing, and
    // a caller that needs the exact column the fold reads can ask for it by name. The case that
    // forced it: copying one instrument's 5-minute SoC onto another's gap through `liveone import`
    // is only faithful if the `avg` column is readable, and no supported path could return it.
    if (aggregationField === AggregationField.LAST) {
      return ["5m", "1d"];
    } else if (
      [
        AggregationField.AVG,
        AggregationField.MIN,
        AggregationField.MAX,
      ].includes(aggregationField as AggregationField)
    ) {
      return ["5m", "1d"];
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
