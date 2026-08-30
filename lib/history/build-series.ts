/**
 * Shared transform: aggregate rows → OpenNEM series.
 *
 * Extracted verbatim from `app/api/history/route.ts` (`getDeviceHistoryInOpenNEMFormat`, the block
 * that ran after the DB fetch). It is the source-agnostic half of the read path: given a uniform
 * `AggRow[]` it produces the served `OpenNEMDataSeries[]`, independent of where those rows came
 * from.
 *
 * Behavior must stay byte-identical to the pre-extraction route — with one deliberate fix: 30m
 * bucketing reduces each field by its own semantics (avg mean / delta sum / min-max extreme /
 * last + quality last-in-bucket). The extracted code averaged every numeric field, which made a
 * 30m energy.delta exactly one sixth of the truth. Dense-timeline handling, transform inversion
 * and `toPrecision(4)` are unchanged.
 */
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
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
  /**
   * The subject's UTC offset in minutes — the ONLY thing this builder ever read off the legacy
   * device-shaped view it used to take (Phase 13 PR 2). An Area has a real offset of its own, so
   * passing the number decouples this from `synthesizeAreaView`.
   */
  timezoneOffsetMin: number,
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
        // For numeric values, reduce each bucket by the field's own semantics: a
        // cumulative delta must be summed, min/max take the extreme, last takes the
        // most recent non-null value, and only avg is a mean of the 5m values.
        const aggregated: Array<{
          interval_end: number;
          value: number | null;
        }> = [];
        const buckets = new Map<
          number,
          Array<{ interval_end: number; value: number }>
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
              value: row.value as number,
            });
          }
        }

        for (const [bucketEnd, entries] of buckets.entries()) {
          let value: number | null = null;
          if (entries.length > 0) {
            const values = entries.map((e) => e.value);
            switch (series.aggregationField) {
              case "delta":
                value = values.reduce((sum, v) => sum + v, 0);
                break;
              case "min":
                value = Math.min(...values);
                break;
              case "max":
                value = Math.max(...values);
                break;
              case "last":
                entries.sort((a, b) => a.interval_end - b.interval_end);
                value = entries[entries.length - 1].value;
                break;
              default:
                value = values.reduce((sum, v) => sum + v, 0) / values.length;
            }
          }
          aggregated.push({ interval_end: bucketEnd, value });
        }

        aggregated.sort((a, b) => a.interval_end - b.interval_end);
        rows = aggregated;
      }
    }

    // 1d: densify to a dense day grid over [firstEpoch, lastEpoch] (step 24h), null where a day has
    // no row. agg_1d is sparse — a point only has a row for days it actually reported — but every
    // client aligns series POSITIONALLY: it assumes data[i] is the day `firstInterval + i`. So a
    // sparse series (e.g. an intermittently-reporting SoC point) gets mis-placed at the window start
    // instead of its true dates (the "band stops early" bug). Filling every day makes index ==
    // day-offset for every series, so positional alignment is correct by construction. This also
    // subsumes the day-ordering the sparse rows lacked (an upserted/recomputed day could arrive out
    // of heap position). 5m/30m are already dense (see readings-pg densify). Raw `rows` upstream are
    // untouched, so the Sankey/flow-matrix read is unaffected.
    if (interval === "1d") {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const byDay = new Map(rows.map((r) => [r.interval_end, r.value]));
      const dense: typeof rows = [];
      for (let t = firstEpoch; t <= lastEpoch; t += DAY_MS) {
        dense.push({
          interval_end: t,
          value: byDay.has(t) ? byDay.get(t)! : null,
        });
      }
      rows = dense;
    }

    // Get source device for series ID
    const sourceDevice = await DeviceConfigRegistry.deviceByHandle(
      series.point.systemId,
    );
    if (!sourceDevice) continue;

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

    // Format timestamps (`timezoneOffsetMin` is now a parameter — see the signature)
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
