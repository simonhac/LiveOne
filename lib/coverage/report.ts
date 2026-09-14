/**
 * Build one device's coverage-density report — the server half of `liveone device coverage`.
 *
 * Enumeration mirrors `?list=series` exactly (`lib/history/list-series.ts`): the same
 * `PointManager.getSeriesForDevice(handle, patterns)` walk, so the same `--series` globs select the
 * same things and the two payloads can be read side by side. What differs is the measurement —
 * `?list=series` reports EXTENTS (index probes on the ends, which say nothing about the interior),
 * this reports DENSITY, per local day.
 *
 * One grouped `count(*) … group by local_day` for the whole device, via
 * `ReadingsDao.countAgg5mByLocalDay` — the same primitive the coverage-repair cron runs nightly
 * (`lib/coverage/find-gaps.ts`). All arithmetic on the result is in `./density`, which is pure.
 */
import { PointManager } from "@/lib/point/point-manager";
import { ReadingsDao } from "@/lib/readings";
import { Point, type PointId } from "@/lib/ids";
import { getSeriesPath } from "@/lib/point/series-info";
import { COVERAGE_PROVIDERS } from "./providers";
import {
  densityForPoint,
  eachLocalDay,
  observedMaxPerDay,
  resolveExpectedPerDay,
  type ExpectedBasis,
  type PointDensity,
} from "./density";

export interface DeviceCoverageReport {
  device: {
    id: string;
    name: string;
    handle: number;
    vendor: string;
    status: string;
    dayOffsetMin: number;
  };
  window: { start: string; end: string; days: string[] };
  cadenceMinutes: number | null;
  expectedPerDay: number;
  expectedBasis: ExpectedBasis;
  count: number;
  points: PointDensity[];
}

const DAY_MS = 86_400_000;

/** UTC instant of local midnight of `day` in a zone `offsetMin` minutes east of UTC. */
function localMidnightUtcMs(day: string, offsetMin: number): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetMin * 60_000;
}

/**
 * The declared cadence for a vendor, or null when it has none.
 *
 * 🛑 Null is the COMMON case, not an error. Cadence is declared only on the three
 * `CoverageRepairProvider`s — the vendors whose gaps are re-fetchable — so every push vendor
 * (`fusher`, `gusher`) lands here with nothing to say. That is precisely why the caller must fall
 * back to an observed expectation and report which one it used.
 */
function vendorCadenceMinutes(vendor: string): number | null {
  return (
    COVERAGE_PROVIDERS.find((p) => p.vendorType === vendor)?.cadenceMinutes ??
    null
  );
}

export async function buildDeviceCoverage(
  device: {
    id: string;
    name: string;
    handle: number;
    vendor: string;
    status: string;
    dayOffsetMin: number;
  },
  window: { start: string; end: string },
  patterns: string[] | undefined,
  cadenceOverride: number | null,
): Promise<DeviceCoverageReport> {
  const days = eachLocalDay(window.start, window.end);
  const offsetMin = device.dayOffsetMin;

  const seriesInfos = await PointManager.getInstance().getSeriesForDevice(
    device.handle,
    patterns && patterns.length > 0 ? patterns : undefined,
  );

  // 🛑 Fold series onto their POINT before counting. Several agg fields (`soc.avg`/`min`/`max`)
  // share one point and one agg_5m row; counting per series would multiply every number by the
  // number of stat suffixes the point happens to expose.
  const byPoint = new Map<
    PointId,
    {
      pointId: string;
      logicalPath: string | null;
      metricType: string;
      unit: string | null;
      series: string[];
    }
  >();
  for (const s of seriesInfos) {
    const id = Point.encode(s.point.pointUid);
    const entry = byPoint.get(id);
    if (entry) {
      entry.series.push(getSeriesPath(s).toString());
      continue;
    }
    byPoint.set(id, {
      pointId: id,
      // 🛑 The STEM, not `getPath()`. `getPath()` is `{stem}/{metricType}` already, so using it here
      // rendered `bidi.battery/soc/soc` everywhere the metric is appended — and its fallback for a
      // stemless point is `{index}/{metricType}`, which is per-DEVICE, so two unrelated stemless
      // points on different devices collided into one key in `--against`.
      logicalPath: s.point.logicalPathStem,
      metricType: s.point.metricType,
      unit: s.point.metricUnit ?? null,
      series: [getSeriesPath(s).toString()],
    });
  }
  const pointIds = [...byPoint.keys()];

  // 🛑 The scan DELIBERATELY over-reaches by a day at each end, exactly as `findCoverageGaps` does,
  // and the day list below does the filtering. Tight bounds are wrong here, and wrong by one in a
  // way that is almost invisible:
  //
  // `localDayExpr` buckets on `interval_end - 1 second`, so a row belongs to local day D when its
  // `interval_end` falls in (midnight(D), midnight(D) + 1 day] — the interval-END convention, where
  // the LAST interval of day D is stamped at D+1's midnight. The DAO filters `>= from AND < to`, so
  // `to = midnight(end) + 1 day` EXCLUDES precisely that row: a complete final day counted 287 of
  // 288 and every report grew a spurious one-interval gap on its last day.
  //
  // Over-reaching costs one extra day of index scan at each edge and cannot be off by one. The
  // surplus buckets are keyed by days absent from `days`, so `densityForPoint` ignores them — and
  // `observedMaxPerDay` is scoped to `days` for the same reason.
  const counts = pointIds.length
    ? await ReadingsDao.countAgg5mByLocalDay(pointIds, {
        fromMs: localMidnightUtcMs(window.start, offsetMin) - DAY_MS,
        toMs: localMidnightUtcMs(window.end, offsetMin) + 2 * DAY_MS,
        offsetMin,
      })
    : new Map<PointId, Map<string, number>>();

  const vendorCadence = vendorCadenceMinutes(device.vendor);
  // The observed basis is fleet-wide across the selected points, not per point: a device's cadence
  // is a property of its poller, and letting each point invent its own expectation would hide a
  // point that has NEVER reached the others' rate.
  let observedMax = 0;
  for (const id of pointIds) {
    const m = observedMaxPerDay(counts.get(id) ?? new Map(), days);
    if (m > observedMax) observedMax = m;
  }
  const expected = resolveExpectedPerDay(
    cadenceOverride,
    vendorCadence,
    observedMax,
  );

  const points = [...byPoint.values()]
    .map((p) =>
      densityForPoint(
        p,
        days,
        counts.get(p.pointId as PointId) ?? new Map(),
        expected,
      ),
    )
    .sort((a, b) =>
      `${a.logicalPath}/${a.metricType}` < `${b.logicalPath}/${b.metricType}`
        ? -1
        : 1,
    );

  return {
    device,
    window: { ...window, days },
    cadenceMinutes:
      cadenceOverride ??
      vendorCadence ??
      (expected.expectedPerDay > 0
        ? Math.round(1440 / expected.expectedPerDay)
        : null),
    expectedPerDay: expected.expectedPerDay,
    expectedBasis: expected.basis,
    count: points.length,
    points,
  };
}
