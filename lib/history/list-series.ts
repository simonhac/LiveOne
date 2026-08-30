/**
 * The metadata-only listing mode of `/api/history` (`?list=series`): what series exist for a
 * subject, WITHOUT fetching any data arrays. The natural first call against an unfamiliar area or
 * device — series ids (`{handle}/{logicalPath}.{aggField}`) and the stat-suffix vocabulary appear
 * nowhere else a caller can cheaply reach.
 *
 * Enumeration comes from the cached point registry (`PointManager.getSeriesForDevice`, which
 * handles multi-device area handles); coverage comes from ONE grouped MIN/MAX/COUNT over the
 * subject's `point_readings_agg_5m` rows (`ReadingsDao.agg5mCoverageForPoints`), deduped per point
 * — every agg field of a point shares the same coverage row.
 *
 * Note `metricType` here is the point's real metric type, unlike the OpenNEM payload's per-series
 * `type`, which is a hardcoded `"power"` for wire-compat and must stay that way.
 */
import { PointManager } from "@/lib/point/point-manager";
import { getSeriesPath, type SeriesInfo } from "@/lib/point/series-info";
import { ReadingsDao, type Agg5mCoverage } from "@/lib/readings/dao";
import { Point, type PointId } from "@/lib/ids";
import { formatTime_fromJSDate } from "@/lib/date-utils";

export interface SeriesListingEntry {
  /** The full series id as `--series`-less consumers address it, e.g. `13/load/power.avg`. */
  id: string;
  /** The device-less, glob-matchable form, e.g. `load/power.avg`. */
  path: string;
  label: string;
  metricType: string;
  aggField: string;
  units: string;
  /** The intervals this series is declared at (30m is served by rebucketing 5m). */
  intervals: ("5m" | "1d")[];
  /** First/last 5m-aggregate timestamps, local at the subject's fixed offset; null = no data. */
  firstData: string | null;
  lastData: string | null;
  /** Exact 5m-aggregate row count for the point; null = no data. */
  samples: number | null;
}

export interface SeriesListing {
  list: "series";
  count: number;
  series: SeriesListingEntry[];
}

/** Pure core: registry entries + coverage → wire entries. Split out so it is unit-testable. */
export function renderSeriesListing(
  seriesInfos: SeriesInfo[],
  coverageByPoint: Map<PointId, Agg5mCoverage | null>,
  tzOffsetMin: number,
): SeriesListingEntry[] {
  const local = (ms: number) =>
    formatTime_fromJSDate(new Date(ms), tzOffsetMin);
  return seriesInfos.map((s) => {
    const cov = coverageByPoint.get(Point.encode(s.point.pointUid)) ?? null;
    return {
      id: getSeriesPath(s).toString(),
      path: `${s.point.getPath()}.${s.aggregationField}`,
      label: s.point.name,
      metricType: s.point.metricType,
      aggField: s.aggregationField,
      units: s.point.metricUnit,
      intervals: s.intervals,
      firstData: cov ? local(cov.firstMs) : null,
      lastData: cov ? local(cov.lastMs) : null,
      samples: cov ? cov.samples : null,
    };
  });
}

export async function buildSeriesListing(
  handle: number,
  tzOffsetMin: number,
  patterns?: string[],
): Promise<SeriesListing> {
  const pointManager = PointManager.getInstance();
  const seriesInfos = await pointManager.getSeriesForDevice(
    handle,
    patterns && patterns.length > 0 ? patterns : undefined,
  );
  const pointIds = [
    ...new Set(seriesInfos.map((s) => Point.encode(s.point.pointUid))),
  ];
  const coverage = await ReadingsDao.agg5mCoverageForPoints(pointIds);
  const series = renderSeriesListing(seriesInfos, coverage, tzOffsetMin);
  return { list: "series", count: series.length, series };
}
