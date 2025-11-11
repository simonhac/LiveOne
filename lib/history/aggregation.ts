import { MeasurementSeries, MeasurementValue, TimeSeriesPoint } from "./types";
import { ZonedDateTime } from "@internationalized/date";
import { toUnixTimestamp, fromUnixTimestamp } from "@/lib/date-utils";

/**
 * Aggregate MeasurementSeries data to a larger time interval
 * For example: aggregate 5-minute data to 30-minute or 60-minute intervals
 *
 * @param series - Array of MeasurementSeries with ZonedDateTime timestamps
 * @param intervalMs - Target interval size in milliseconds (e.g., 30 * 60 * 1000 for 30 minutes)
 * @param startTime - Start time for the aggregation range
 * @param endTime - End time for the aggregation range
 * @returns Aggregated MeasurementSeries array
 */
export function aggregateToInterval(
  series: MeasurementSeries[],
  intervalMs: number,
  startTime?: ZonedDateTime,
  endTime?: ZonedDateTime,
): MeasurementSeries[] {
  if (series.length === 0) return [];

  const aggregatedSeries: MeasurementSeries[] = [];

  // Process each series independently
  for (const originalSeries of series) {
    const aggregatedPoints = new Map<number, TimeSeriesPoint[]>();

    // Determine the time range
    let rangeStartMs: number;
    let rangeEndMs: number;

    if (startTime && endTime) {
      // Use provided range
      rangeStartMs = toUnixTimestamp(startTime) * 1000;
      rangeEndMs = toUnixTimestamp(endTime) * 1000;
    } else if (originalSeries.data.length > 0) {
      // Use data range
      const firstPoint = originalSeries.data[0].timestamp as ZonedDateTime;
      const lastPoint = originalSeries.data[originalSeries.data.length - 1]
        .timestamp as ZonedDateTime;
      rangeStartMs = toUnixTimestamp(firstPoint) * 1000;
      rangeEndMs = toUnixTimestamp(lastPoint) * 1000;
    } else {
      continue; // No data and no range specified
    }

    // Calculate all intervals in the range
    const firstIntervalEnd =
      Math.floor(rangeStartMs / intervalMs) * intervalMs + intervalMs;
    // Don't add extra interval if end time is exactly on boundary
    const lastIntervalEnd =
      rangeEndMs % intervalMs === 0
        ? rangeEndMs
        : Math.floor(rangeEndMs / intervalMs) * intervalMs + intervalMs;

    // Initialize all intervals with empty arrays
    for (
      let intervalEnd = firstIntervalEnd;
      intervalEnd <= lastIntervalEnd;
      intervalEnd += intervalMs
    ) {
      aggregatedPoints.set(intervalEnd, []);
    }

    // Group existing data points by target interval
    for (const point of originalSeries.data) {
      // This function only works with ZonedDateTime data (minute-level intervals)
      if (!("timeZone" in point.timestamp)) {
        throw new Error(
          "aggregateToInterval requires ZonedDateTime intervals (minute-level data)",
        );
      }

      const timestamp = toUnixTimestamp(point.timestamp) * 1000;
      const intervalEnd =
        Math.floor(timestamp / intervalMs) * intervalMs + intervalMs;

      if (aggregatedPoints.has(intervalEnd)) {
        aggregatedPoints.get(intervalEnd)!.push(point);
      }
    }

    // Process all intervals in sorted order
    const sortedIntervals = Array.from(aggregatedPoints.keys()).sort(
      (a, b) => a - b,
    );
    const newData: TimeSeriesPoint[] = [];

    for (const intervalEnd of sortedIntervals) {
      const points = aggregatedPoints.get(intervalEnd)!;

      if (points.length === 0) {
        // No data for this interval - add null
        newData.push({
          timestamp: fromUnixTimestamp(intervalEnd / 1000, 600), // Use AEST timezone
          value: {
            avg: null,
          },
        });
      } else {
        // Extract all non-null values for aggregation
        const values = points
          .map((p) => p.value)
          .filter((v) => v !== undefined);

        if (values.length > 0) {
          const avgs = values.filter((v) => v.avg !== null).map((v) => v.avg!);
          const mins = values
            .filter((v) => v.min !== null && v.min !== undefined)
            .map((v) => v.min!);
          const maxs = values
            .filter((v) => v.max !== null && v.max !== undefined)
            .map((v) => v.max!);
          const counts = values
            .filter((v) => v.count !== undefined)
            .map((v) => v.count!);
          const lasts = values
            .filter((v) => v.last !== null && v.last !== undefined)
            .map((v) => v.last!);

          newData.push({
            timestamp: fromUnixTimestamp(intervalEnd / 1000, 600), // Use AEST timezone
            value: {
              avg:
                avgs.length > 0
                  ? avgs.reduce((sum, v) => sum + v, 0) / avgs.length
                  : null,
              min: mins.length > 0 ? Math.min(...mins) : undefined,
              max: maxs.length > 0 ? Math.max(...maxs) : undefined,
              count:
                counts.length > 0
                  ? counts.reduce((sum, v) => sum + v, 0)
                  : undefined,
              last: lasts.length > 0 ? lasts[lasts.length - 1] : undefined, // Use the last value in the interval
            },
          });
        } else {
          // Points exist but all values are null
          newData.push({
            timestamp: fromUnixTimestamp(intervalEnd / 1000, 600),
            value: {
              avg: null,
            },
          });
        }
      }
    }

    // Create new series with aggregated data
    if (newData.length > 0) {
      aggregatedSeries.push({
        field: originalSeries.field,
        metadata: originalSeries.metadata,
        data: newData,
      });
    }
  }

  return aggregatedSeries;
}
