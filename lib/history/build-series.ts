/**
 * Shared transform: aggregate rows → OpenNEM series.
 *
 * Extracted verbatim from `app/api/history/route.ts` (`getSystemHistoryInOpenNEMFormat`, the block
 * that ran after the DB fetch). It is the source-agnostic half of the read path: given a uniform
 * `AggRow[]` it produces the served `OpenNEMDataSeries[]`, independent of where those rows came
 * from.
 *
 * Behavior must stay byte-identical to the pre-extraction route: dense-timeline handling, 30m
 * bucketing (numeric avg / quality last-in-bucket), transform inversion, `toPrecision(4)`.
 */
import { SystemWithPolling, SystemsManager } from "@/lib/systems-manager";
import { OpenNEMDataSeries } from "@/types/opennem";
import { SeriesInfo, getSeriesPath } from "@/lib/point/series-info";
import { HistoryDebugInfo, registerSeries } from "@/lib/history/history-debug";
import { formatTime_fromJSDate } from "@/lib/date-utils";

/**
 * The uniform intermediate row shape the fetches produce. `interval_end`
 * (epoch-ms) is present for 5m/30m; `day` (YYYY-MM-DD) is present for 1d.
 */
export interface AggRow {
  system_id: number;
  point_id: number;
  interval_end?: number;
  day?: string;
  avg?: number | null;
  min?: number | null;
  max?: number | null;
  last?: number | null;
  delta?: number | null;
  data_quality?: string | null;
}

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
 * Convert the uniform `AggRow[]` into OpenNEM series. `firstEpoch`/`lastEpoch` are the request
 * window bounds (epoch-ms). `debug`, when supplied, is mutated in place (query/series tracking);
 * pass `undefined` for the shadow PG path so it never touches the served request's debug object.
 */
export async function buildSeriesFromAggRows(
  allRows: AggRow[],
  seriesInfos: SeriesInfo[],
  interval: "5m" | "30m" | "1d",
  system: SystemWithPolling,
  firstEpoch: number,
  lastEpoch: number,
  debug?: HistoryDebugInfo,
): Promise<OpenNEMDataSeries[]> {
  const aggTable =
    interval === "1d" ? "point_readings_agg_1d" : "point_readings_agg_5m";

  // Group rows by (system_id, point_id, aggregation_field)
  const rowsByPointAndField = new Map<
    string,
    Array<{ interval_end: number; value: number | string | null }>
  >();

  for (const row of allRows) {
    // Convert day to interval_end if needed
    const intervalEnd =
      row.interval_end ?? new Date(row.day! + "T00:00:00Z").getTime();

    // Process each aggregation field (including NULLs from dense timeline)
    // With CTE-generated dense timeline, we always have rows even if data is NULL
    for (const field of [
      "avg",
      "min",
      "max",
      "last",
      "delta",
      "quality",
    ] as const) {
      // Map field name to database column (quality -> data_quality)
      const dbField = field === "quality" ? "data_quality" : field;

      // Always add an entry for this field (value may be null)
      const key = `${row.system_id}.${row.point_id}.${field}`;
      if (!rowsByPointAndField.has(key)) {
        rowsByPointAndField.set(key, []);
      }
      rowsByPointAndField.get(key)!.push({
        interval_end: intervalEnd,
        value: row[dbField] ?? null,
      });
    }
  }

  // Build series for each SeriesInfo
  const systemsManager = SystemsManager.getInstance();
  const allSeries: OpenNEMDataSeries[] = [];

  const intervalMs =
    interval === "5m"
      ? 5 * 60 * 1000
      : interval === "30m"
        ? 30 * 60 * 1000
        : 24 * 60 * 60 * 1000;

  for (const series of seriesInfos) {
    const key = `${series.point.systemId}.${series.point.index}.${series.aggregationField}`;
    let rows = rowsByPointAndField.get(key) || [];

    // Apply transform (skip for quality which is a string)
    if (series.aggregationField !== "quality") {
      rows = rows.map((row) => ({
        interval_end: row.interval_end,
        value: applyTransform(
          row.value as number | null,
          series.point.transform,
        ),
      }));
    }

    // Handle 30m aggregation if needed
    if (interval === "30m" && aggTable === "point_readings_agg_5m") {
      if (series.aggregationField === "quality") {
        // For quality (string values), take the last value in each 30m bucket
        const aggregated: Array<{
          interval_end: number;
          value: string | null;
        }> = [];
        const buckets = new Map<
          number,
          Array<{ interval_end: number; value: string }>
        >();

        for (const row of rows) {
          // Align bucketing to request boundaries
          // Use ceil to round readings UP to the next bucket boundary
          const bucketIndex = Math.ceil(
            (row.interval_end - firstEpoch) / intervalMs,
          );
          const bucketEnd = firstEpoch + bucketIndex * intervalMs;

          if (!buckets.has(bucketEnd)) {
            buckets.set(bucketEnd, []);
          }

          if (row.value !== null) {
            buckets.get(bucketEnd)!.push({
              interval_end: row.interval_end,
              value: row.value as string,
            });
          }
        }

        // Take the last (most recent) quality value in each bucket
        for (const [bucketEnd, values] of buckets.entries()) {
          if (values.length > 0) {
            // Sort by interval_end and take the last one
            values.sort((a, b) => a.interval_end - b.interval_end);
            aggregated.push({
              interval_end: bucketEnd,
              value: values[values.length - 1].value,
            });
          }
        }

        aggregated.sort((a, b) => a.interval_end - b.interval_end);
        rows = aggregated;
      } else {
        // For numeric values, average them
        const aggregated: Array<{
          interval_end: number;
          value: number | null;
        }> = [];
        const buckets = new Map<number, number[]>();

        for (const row of rows) {
          // Align bucketing to request boundaries
          // Use ceil to round readings UP to the next bucket boundary
          const bucketIndex = Math.ceil(
            (row.interval_end - firstEpoch) / intervalMs,
          );
          const bucketEnd = firstEpoch + bucketIndex * intervalMs;

          if (!buckets.has(bucketEnd)) {
            buckets.set(bucketEnd, []);
          }

          if (row.value !== null) {
            buckets.get(bucketEnd)!.push(row.value as number);
          }
        }

        for (const [bucketEnd, values] of buckets.entries()) {
          const avg =
            values.length > 0
              ? values.reduce((sum, v) => sum + v, 0) / values.length
              : null;
          aggregated.push({ interval_end: bucketEnd, value: avg });
        }

        aggregated.sort((a, b) => a.interval_end - b.interval_end);
        rows = aggregated;
      }
    }

    // 1d rows are grouped but not guaranteed day-ordered: Postgres can return a recomputed/
    // upserted day out of heap position (an unordered scan), which would shift the served series
    // by one since this transform maps rows in arrival order. Sort by interval_end so the
    // 1d series is day-ascending regardless of the source's row order. No-op for the 5m/30m paths
    // (already dense / bucket-sorted ascending).
    if (interval === "1d") {
      rows = [...rows].sort((a, b) => a.interval_end - b.interval_end);
    }

    // Get source system for series ID
    const sourceSystem = await systemsManager.getSystem(series.point.systemId);
    if (!sourceSystem) continue;

    // Build series ID using SeriesPath
    const seriesPath = getSeriesPath(series);
    const seriesId = seriesPath.toString();

    // Build field data - database CTE provides dense timeline with NULLs for gaps
    const fieldData: (number | string | null)[] = rows.map((row) => {
      const value = row.value;
      // For quality (string), push as-is; for numbers, apply precision
      if (typeof value === "string") {
        return value;
      } else {
        return value === null ? null : parseFloat(value.toPrecision(4));
      }
    });

    // Build path for the series (e.g., "bidi.battery/power.avg")
    const pointPath =
      series.point.getLogicalPath() ||
      `${series.point.index}/${series.point.metricType}`;
    const fullPath = `${pointPath}.${series.aggregationField}`;

    // Format timestamps
    const timezoneOffsetMin = system.timezoneOffsetMin ?? 600;
    const startFormatted = formatTime_fromJSDate(
      new Date(firstEpoch),
      timezoneOffsetMin,
    );
    const endFormatted = formatTime_fromJSDate(
      new Date(lastEpoch),
      timezoneOffsetMin,
    );

    allSeries.push({
      id: seriesId,
      type: "power",
      units: series.point.metricUnit,
      path: fullPath,
      label: series.point.name,
      history: {
        firstInterval: startFormatted,
        lastInterval: endFormatted,
        interval: interval,
        numIntervals: fieldData.length,
        data: fieldData,
      },
    });

    // Register series for debug tracking
    if (debug) {
      registerSeries(debug, series);
    }
  }

  return allSeries;
}
