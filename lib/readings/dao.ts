/**
 * The time-series data-access seam — UUIDs in, rids below.
 *
 * Config-v4 (the config-v4 epic record §3): the public methods here take the `pt_…`
 * TypeID (`PointId`) and their signatures are IDENTICAL before and after the Phase-8 cutover. Today
 * (pre-cutover) each method resolves `PointId → (system_id, index)` via {@link RegistryCache} and
 * issues the composite-key SQL the hot tables use verbatim; at the cutover the SAME methods will
 * resolve `PointId → point_rid` and issue rid-keyed SQL. Callers never change.
 *
 * Cutover seams are deliberately confined to this file and fall into three explicit categories:
 * point-keyed reads/writes (`PointId` → current composite address), device-keyed fleet/admin probes
 * (`DeviceId` → current device handle), and keyless maintenance operations. Every occurrence is tagged
 * `// SEAM:` so the Phase-8 harness must exercise it against both table shapes.
 *
 * Time crosses this boundary as epoch-ms UTC (every existing caller speaks epoch-ms; `Date` is a
 * DB-internal representation). The `agg_1d` day key stays a `YYYY-MM-DD` string. Writes optionally
 * run inside a caller transaction via the `exec?` param (the receiver: session-first, then raw + 5m).
 */
import {
  and,
  eq,
  gt,
  gte,
  lt,
  lte,
  inArray,
  desc,
  max,
  sql,
} from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { DeviceRegistry, RegistryCache } from "@/lib/registry";
import { Device, Point, type DeviceId, type PointId } from "@/lib/ids";
// The `points` identity table is broadly importable (NOT one of the three seam-restricted hot symbols),
// and joining it is how the rid-keyed twins recover the device address they no longer carry inline.
import { points } from "@/lib/db/planetscale/schema";
import {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "./schema-internal";
import type { SeedPreviewDatabaseOptions } from "./preview-seed";
import type { SyncProdToDevOptions } from "./prod-dev-sync";

type PgDb = ReturnType<typeof requirePlanetscaleDb>;
type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
/** A pool or a caller's transaction handle — writes run standalone or inside the receiver's tx. */
export type ReadingsExec = PgDb | PgTx;

// ── Boundary shapes ────────────────────────────────────────────────────────────────────────────────
export interface ReadWindow {
  fromMs: number;
  toMs: number;
  /** Upper bound: inclusive (`<= toMs`) by default; set `false` for a half-open window (`< toMs`).
   *  The lower bound is always inclusive. Half-open reproduces callers whose native query is
   *  `interval_end < hi` (e.g. flow-series' cache lead-in) byte-identically. */
  toInclusive?: boolean;
} // epoch-ms UTC
export interface DayRange {
  startDay: string;
  endDay: string;
} // inclusive, 'YYYY-MM-DD'

/** Per-point result: an ascending series keyed by the PUBLIC PointId. Points with no rows map to []. */
export type SeriesByPoint<R> = Map<PointId, R[]>;

export interface RawReading {
  measurementTimeMs: number;
  receivedTimeMs: number;
  value: number | null;
  valueStr: string | null;
  error: string | null;
  dataQuality: string;
  sessionId: string | null;
}
export interface Agg5mReading {
  intervalEndMs: number;
  /** Row ingestion time (agg_5m `created_at`, NOT NULL) as epoch-ms UTC — the vendors' "received time". */
  createdAtMs: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  delta: number | null;
  valueStr: string | null;
  sampleCount: number;
  errorCount: number;
  dataQuality: string | null;
  sessionId: string | null;
}
export interface Agg1dReading {
  day: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  delta: number | null;
  sampleCount: number;
  errorCount: number;
}

export interface RawInsert {
  point: PointId;
  measurementTimeMs: number;
  receivedTimeMs: number;
  value: number | null;
  valueStr: string | null;
  dataQuality?: string;
  sessionId: string | null;
}
export interface Agg5mInsert {
  point: PointId;
  intervalEndMs: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  delta: number | null;
  valueStr: string | null;
  sampleCount: number;
  errorCount: number;
  dataQuality: string | null;
  sessionId: string | null;
}
export interface Agg1dUpsert {
  point: PointId;
  day: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  delta: number | null;
  sampleCount: number;
  errorCount: number;
}

/** Latest cache-worthy value for one active, typed point. Raw wins when both stores have data. */
export interface ActivePointLatest {
  point: PointId;
  logicalPathStem: string;
  metricType: string;
  metricUnit: string;
  displayName: string;
  value: number | null;
  valueStr: string | null;
  measurementTimeMs: number;
  receivedTimeMs: number;
  sessionId: string | null;
  sessionLabel: string | null;
}

export interface Agg5mCoverage {
  firstMs: number;
  lastMs: number;
  /** Exact 5m-row count — rides the same grouped index scan as the MIN/MAX. */
  samples: number;
}

// ── Internal helpers ────────────────────────────────────────────────────────────────────────────────
/** Pick the read window's upper-bound operator: half-open `lt` when `toInclusive === false`, else
 *  inclusive `lte`. Extracted pure so the half-open branch is pinned by reference in a unit test — the
 *  SEAM WHERE below is otherwise only exercised end-to-end. */
export const upperBoundOp = (toInclusive: boolean | undefined) =>
  toInclusive === false ? lt : lte;

/** SQL fragment: the local trading-day ('YYYY-MM-DD') of an interval-END, shifted `offsetMin` minutes
 *  east of UTC. The `- 1 second` puts an interval ending at local 00:00 into the PREVIOUS trading day.
 *  Mirrors the original `lib/coverage/find-gaps.ts` expression verbatim. */
const localDayExpr = (offsetMin: number) =>
  sql<string>`to_char(${pointReadingsAgg5m.intervalEnd} + (${offsetMin} || ' minutes')::interval - interval '1 second', 'YYYY-MM-DD')`;

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────
async function readRaw(
  points: PointId[],
  window: ReadWindow,
  exec?: ReadingsExec,
): Promise<SeriesByPoint<RawReading>> {
  const out: SeriesByPoint<RawReading> = new Map(points.map((p) => [p, []]));
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  const from = new Date(window.fromMs);
  const to = new Date(window.toMs);
  // SEAM: rid-keyed WHERE (single query, no per-device fan-out).
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  const rows = await db
    .select({
      pointRid: pointReadings.pointRid,
      measurementTime: pointReadings.measurementTime,
      receivedTime: pointReadings.receivedTime,
      value: pointReadings.value,
      valueStr: pointReadings.valueStr,
      error: pointReadings.error,
      dataQuality: pointReadings.dataQuality,
      sessionId: pointReadings.sessionId,
    })
    .from(pointReadings)
    .where(
      and(
        inArray(pointReadings.pointRid, rids),
        gte(pointReadings.measurementTime, from),
        upperBoundOp(window.toInclusive)(pointReadings.measurementTime, to),
      ),
    )
    .orderBy(pointReadings.measurementTime);
  for (const r of rows) {
    const id = pointByRid.get(r.pointRid);
    if (!id) continue;
    out.get(id)!.push({
      measurementTimeMs: r.measurementTime.getTime(),
      receivedTimeMs: r.receivedTime.getTime(),
      value: r.value,
      valueStr: r.valueStr,
      error: r.error,
      dataQuality: r.dataQuality,
      sessionId: r.sessionId,
    });
  }
  return out;
}

async function read5m(
  points: PointId[],
  window: ReadWindow,
  exec?: ReadingsExec,
): Promise<SeriesByPoint<Agg5mReading>> {
  const out: SeriesByPoint<Agg5mReading> = new Map(points.map((p) => [p, []]));
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  const from = new Date(window.fromMs);
  const to = new Date(window.toMs);
  // SEAM: rid-keyed WHERE (single query, no per-device fan-out).
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  const rows = await db
    .select({
      pointRid: pointReadingsAgg5m.pointRid,
      intervalEnd: pointReadingsAgg5m.intervalEnd,
      createdAt: pointReadingsAgg5m.createdAt,
      avg: pointReadingsAgg5m.avg,
      min: pointReadingsAgg5m.min,
      max: pointReadingsAgg5m.max,
      last: pointReadingsAgg5m.last,
      delta: pointReadingsAgg5m.delta,
      valueStr: pointReadingsAgg5m.valueStr,
      sampleCount: pointReadingsAgg5m.sampleCount,
      errorCount: pointReadingsAgg5m.errorCount,
      dataQuality: pointReadingsAgg5m.dataQuality,
      sessionId: pointReadingsAgg5m.sessionId,
    })
    .from(pointReadingsAgg5m)
    .where(
      and(
        inArray(pointReadingsAgg5m.pointRid, rids),
        gte(pointReadingsAgg5m.intervalEnd, from),
        upperBoundOp(window.toInclusive)(pointReadingsAgg5m.intervalEnd, to),
      ),
    )
    .orderBy(pointReadingsAgg5m.intervalEnd);
  for (const r of rows) {
    const id = pointByRid.get(r.pointRid);
    if (!id) continue;
    out.get(id)!.push({
      intervalEndMs: r.intervalEnd.getTime(),
      createdAtMs: r.createdAt.getTime(),
      avg: r.avg,
      min: r.min,
      max: r.max,
      last: r.last,
      delta: r.delta,
      valueStr: r.valueStr,
      sampleCount: r.sampleCount,
      errorCount: r.errorCount,
      dataQuality: r.dataQuality,
      sessionId: r.sessionId,
    });
  }
  return out;
}

async function read1d(
  points: PointId[],
  range: DayRange,
  exec?: ReadingsExec,
): Promise<SeriesByPoint<Agg1dReading>> {
  const out: SeriesByPoint<Agg1dReading> = new Map(points.map((p) => [p, []]));
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE (single query, no per-device fan-out).
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  const rows = await db
    .select({
      pointRid: pointReadingsAgg1d.pointRid,
      day: pointReadingsAgg1d.day,
      avg: pointReadingsAgg1d.avg,
      min: pointReadingsAgg1d.min,
      max: pointReadingsAgg1d.max,
      last: pointReadingsAgg1d.last,
      delta: pointReadingsAgg1d.delta,
      sampleCount: pointReadingsAgg1d.sampleCount,
      errorCount: pointReadingsAgg1d.errorCount,
    })
    .from(pointReadingsAgg1d)
    .where(
      and(
        inArray(pointReadingsAgg1d.pointRid, rids),
        gte(pointReadingsAgg1d.day, range.startDay),
        lte(pointReadingsAgg1d.day, range.endDay),
      ),
    )
    .orderBy(pointReadingsAgg1d.day);
  for (const r of rows) {
    const id = pointByRid.get(r.pointRid);
    if (!id) continue;
    out.get(id)!.push({
      day: r.day,
      avg: r.avg,
      min: r.min,
      max: r.max,
      last: r.last,
      delta: r.delta,
      sampleCount: r.sampleCount,
      errorCount: r.errorCount,
    });
  }
  return out;
}

/**
 * Latest raw sample per point (the PG fallback for the KV `latest:` cache — values must stay
 * byte-identical to serving). `null` when a point has no rows.
 */
async function latestForPoints(
  points: PointId[],
  exec?: ReadingsExec,
): Promise<Map<PointId, RawReading | null>> {
  const out = new Map<PointId, RawReading | null>(points.map((p) => [p, null]));
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE; DISTINCT ON (point_rid).
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  const rows = await db
    .selectDistinctOn([pointReadings.pointRid], {
      pointRid: pointReadings.pointRid,
      measurementTime: pointReadings.measurementTime,
      receivedTime: pointReadings.receivedTime,
      value: pointReadings.value,
      valueStr: pointReadings.valueStr,
      error: pointReadings.error,
      dataQuality: pointReadings.dataQuality,
      sessionId: pointReadings.sessionId,
    })
    .from(pointReadings)
    .where(inArray(pointReadings.pointRid, rids))
    .orderBy(pointReadings.pointRid, desc(pointReadings.measurementTime));
  for (const r of rows) {
    const id = pointByRid.get(r.pointRid);
    if (!id) continue;
    out.set(id, {
      measurementTimeMs: r.measurementTime.getTime(),
      receivedTimeMs: r.receivedTime.getTime(),
      value: r.value,
      valueStr: r.valueStr,
      error: r.error,
      dataQuality: r.dataQuality,
      sessionId: r.sessionId,
    });
  }
  return out;
}

/**
 * Latest 5-minute aggregate per point (the Enphase adapter's last-reading probe). `null` when a point
 * has no rows. The agg_5m analogue of {@link latestForPoints}.
 */
async function latest5mForPoints(
  points: PointId[],
  exec?: ReadingsExec,
): Promise<Map<PointId, Agg5mReading | null>> {
  const out = new Map<PointId, Agg5mReading | null>(
    points.map((p) => [p, null]),
  );
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE; DISTINCT ON (point_rid).
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  const rows = await db
    .selectDistinctOn([pointReadingsAgg5m.pointRid], {
      pointRid: pointReadingsAgg5m.pointRid,
      intervalEnd: pointReadingsAgg5m.intervalEnd,
      createdAt: pointReadingsAgg5m.createdAt,
      avg: pointReadingsAgg5m.avg,
      min: pointReadingsAgg5m.min,
      max: pointReadingsAgg5m.max,
      last: pointReadingsAgg5m.last,
      delta: pointReadingsAgg5m.delta,
      valueStr: pointReadingsAgg5m.valueStr,
      sampleCount: pointReadingsAgg5m.sampleCount,
      errorCount: pointReadingsAgg5m.errorCount,
      dataQuality: pointReadingsAgg5m.dataQuality,
      sessionId: pointReadingsAgg5m.sessionId,
    })
    .from(pointReadingsAgg5m)
    .where(inArray(pointReadingsAgg5m.pointRid, rids))
    .orderBy(pointReadingsAgg5m.pointRid, desc(pointReadingsAgg5m.intervalEnd));
  for (const r of rows) {
    const id = pointByRid.get(r.pointRid);
    if (!id) continue;
    out.set(id, {
      intervalEndMs: r.intervalEnd.getTime(),
      createdAtMs: r.createdAt.getTime(),
      avg: r.avg,
      min: r.min,
      max: r.max,
      last: r.last,
      delta: r.delta,
      valueStr: r.valueStr,
      sampleCount: r.sampleCount,
      errorCount: r.errorCount,
      dataQuality: r.dataQuality,
      sessionId: r.sessionId,
    });
  }
  return out;
}

/**
 * Latest cache-worthy value for every active point with a logical path. Raw is preferred whenever
 * present; agg5m is the fallback for 5m-native vendors. The LATERAL probes reproduce the former
 * dev-KV rebuild query exactly while returning the public PointId.
 *
 * ⚠️ Hand-written SQL: `tsc` is blind to it, so a table rename here fails only at RUNTIME. It must be
 * DRIVEN (rebuild the latest-values path) after any edit.
 */
async function latestForActivePoints(
  exec?: ReadingsExec,
): Promise<ActivePointLatest[]> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: both LATERAL probes key on the rid-keyed twins (pr.point_rid = p.rid), and since slice 1b the
  // driver is `points` — `p.rid` is the SAME sequence value `point_info.rid` held (0043: one counter), so
  // the probes are unchanged. No `devices` join: every column projected here lives on the point row
  // (`points.id` IS the old `point_uid`, `unit`/`name` are the old `metric_unit`/`display_name`). The
  // OUTPUT column names are held fixed so the row mapper below is untouched.
  const res = await db.execute(
    sql.raw(`
    WITH candidates AS (
      SELECT p.id AS point_uid, p.logical_path AS logical_path_stem, p.metric_type,
             p.unit AS metric_unit, p.name AS display_name,
             r.value, r.value_str, r.measurement_time AS mt, r.received_time AS rt,
             r.session_id, 0 AS src_rank
      FROM points p
      JOIN LATERAL (
        SELECT value, value_str, measurement_time, received_time, session_id
        FROM point_readings pr
        WHERE pr.point_rid = p.rid
        ORDER BY measurement_time DESC LIMIT 1
      ) r ON true
      WHERE p.active = true AND p.logical_path IS NOT NULL
      UNION ALL
      SELECT p.id AS point_uid, p.logical_path AS logical_path_stem, p.metric_type,
             p.unit AS metric_unit, p.name AS display_name,
             a.last AS value, a.value_str, a.interval_end AS mt, a.interval_end AS rt,
             a.session_id, 1 AS src_rank
      FROM points p
      JOIN LATERAL (
        SELECT last, value_str, interval_end, session_id
        FROM point_readings_agg_5m ag
        WHERE ag.point_rid = p.rid
        ORDER BY interval_end DESC LIMIT 1
      ) a ON true
      WHERE p.active = true AND p.logical_path IS NOT NULL
    )
    SELECT DISTINCT ON (c.point_uid)
      c.point_uid, c.logical_path_stem, c.metric_type, c.metric_unit, c.display_name,
      c.value, c.value_str,
      EXTRACT(EPOCH FROM c.mt AT TIME ZONE 'UTC') * 1000 AS measurement_time_ms,
      EXTRACT(EPOCH FROM c.rt AT TIME ZONE 'UTC') * 1000 AS received_time_ms,
      c.session_id, s.session_label
    FROM candidates c
    LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.value IS NOT NULL OR c.value_str IS NOT NULL
    ORDER BY c.point_uid, c.src_rank, c.mt DESC
  `),
  );
  type Row = {
    point_uid: string;
    logical_path_stem: string;
    metric_type: string;
    metric_unit: string;
    display_name: string;
    value: number | null;
    value_str: string | null;
    measurement_time_ms: number | string;
    received_time_ms: number | string;
    session_id: string | null;
    session_label: string | null;
  };
  return ((res as unknown as { rows?: Row[] }).rows ?? []).map((r) => ({
    point: Point.encode(r.point_uid),
    logicalPathStem: r.logical_path_stem,
    metricType: r.metric_type,
    metricUnit: r.metric_unit,
    displayName: r.display_name,
    value: r.value,
    valueStr: r.value_str,
    measurementTimeMs: Number(r.measurement_time_ms),
    receivedTimeMs: Number(r.received_time_ms),
    sessionId: r.session_id,
    sessionLabel: r.session_label,
  }));
}

/** Indexed MIN/MAX coverage for a set of agg5m points. Missing points map to null. */
async function agg5mCoverageForPoints(
  points: PointId[],
  exec?: ReadingsExec,
): Promise<Map<PointId, Agg5mCoverage | null>> {
  const out = new Map<PointId, Agg5mCoverage | null>(
    points.map((point) => [point, null]),
  );
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE/GROUP BY.
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  const rows = await db
    .select({
      pointRid: pointReadingsAgg5m.pointRid,
      first: sql<Date | null>`min(${pointReadingsAgg5m.intervalEnd})`,
      last: sql<Date | null>`max(${pointReadingsAgg5m.intervalEnd})`,
      samples: sql<number>`count(*)::int`,
    })
    .from(pointReadingsAgg5m)
    .where(inArray(pointReadingsAgg5m.pointRid, rids))
    .groupBy(pointReadingsAgg5m.pointRid);
  for (const row of rows) {
    const point = pointByRid.get(row.pointRid);
    if (!point || row.first == null || row.last == null) continue;
    out.set(point, {
      firstMs: new Date(row.first as string | number | Date).getTime(),
      lastMs: new Date(row.last as string | number | Date).getTime(),
      samples: Number(row.samples),
    });
  }
  return out;
}

/** PostgreSQL planner estimate for one hot store; operational display only. */
async function approximateRowCount(
  store: ReadingStore,
  exec?: ReadingsExec,
): Promise<number | null> {
  const db = exec ?? requirePlanetscaleDb();
  const table = STORE_TABLE[store];
  const res = await db.execute(sql`
    SELECT n_live_tup
    FROM pg_stat_user_tables
    WHERE schemaname = 'public' AND relname = ${table}
  `);
  const row = (res.rows?.[0] ?? null) as { n_live_tup?: unknown } | null;
  return row?.n_live_tup == null ? null : Number(row.n_live_tup);
}

/**
 * Latest `agg_5m` `interval_end` (epoch-ms UTC) PER point, or `null` for a point with no rows — the
 * battery-provenance blend watermark gate (`blendIsCurrent`). Reproduces the per-point
 * `MAX(interval_end)` probe verbatim (batched with `GROUP BY point_id`).
 */
async function latestAgg5mIntervalMsForPoints(
  points: PointId[],
  exec?: ReadingsExec,
): Promise<Map<PointId, number | null>> {
  const out = new Map<PointId, number | null>(points.map((p) => [p, null]));
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE + per-point MAX(interval_end).
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  const rows = await db
    .select({
      pointRid: pointReadingsAgg5m.pointRid,
      m: max(pointReadingsAgg5m.intervalEnd),
    })
    .from(pointReadingsAgg5m)
    .where(inArray(pointReadingsAgg5m.pointRid, rids))
    .groupBy(pointReadingsAgg5m.pointRid);
  for (const r of rows) {
    const id = pointByRid.get(r.pointRid);
    if (!id || r.m == null) continue;
    out.set(id, new Date(r.m as string | number | Date).getTime());
  }
  return out;
}

/**
 * Latest `agg_5m` `updated_at` (epoch-ms UTC) for ONE point over an `interval_end` window
 * (`> afterIntervalEndMs`, `<= throughIntervalEndMs`), or `null` when nothing matches — the
 * battery-provenance checkpoint staleness probe. Reproduces `MAX(updated_at)` verbatim.
 */
async function latestAgg5mUpdatedAtForPoint(
  point: PointId,
  opts: { afterIntervalEndMs: number; throughIntervalEndMs: number },
  exec?: ReadingsExec,
): Promise<number | null> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE. MAX(updated_at) over an interval_end window.
  const rid = await RegistryCache.ridForPoint(point);
  const [row] = await db
    .select({ m: max(pointReadingsAgg5m.updatedAt) })
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.pointRid, rid),
        gt(pointReadingsAgg5m.intervalEnd, new Date(opts.afterIntervalEndMs)),
        lte(
          pointReadingsAgg5m.intervalEnd,
          new Date(opts.throughIntervalEndMs),
        ),
      ),
    );
  return row?.m != null
    ? new Date(row.m as string | number | Date).getTime()
    : null;
}

/**
 * Latest `agg_5m` `updated_at` (epoch-ms UTC) ACROSS several points over one `interval_end` window
 * (`> afterIntervalEndMs`, `<= throughIntervalEndMs`), or `null` when nothing matches — the
 * run-provenance staleness probe (`rehealStaleRuns`, lib/run-tracking/recompute.ts).
 *
 * The singular {@link latestAgg5mUpdatedAtForPoint} answers the same question one point at a time;
 * this asks it of a whole watch set in ONE round trip, because the probe's caller only ever needs
 * "did ANY input move", never which. Batched exactly like `latestAgg5mIntervalMsForPoints` (rid-keyed
 * `IN`), minus the `GROUP BY` — the max is taken across the set.
 */
async function latestAgg5mUpdatedAtForPoints(
  points: PointId[],
  opts: { afterIntervalEndMs: number; throughIntervalEndMs: number },
  exec?: ReadingsExec,
): Promise<number | null> {
  if (points.length === 0) return null;
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE. MAX(updated_at) over an interval_end window, across the whole set.
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  if (rids.length === 0) return null;
  const [row] = await db
    .select({ m: max(pointReadingsAgg5m.updatedAt) })
    .from(pointReadingsAgg5m)
    .where(
      and(
        inArray(pointReadingsAgg5m.pointRid, rids),
        gt(pointReadingsAgg5m.intervalEnd, new Date(opts.afterIntervalEndMs)),
        lte(
          pointReadingsAgg5m.intervalEnd,
          new Date(opts.throughIntervalEndMs),
        ),
      ),
    );
  return row?.m != null
    ? new Date(row.m as string | number | Date).getTime()
    : null;
}

/**
 * Per-(point, local-day) `agg_5m` row counts within an interval-end window (the coverage gap-finder,
 * `lib/coverage/find-gaps.ts`). `offsetMin` sets the local-day bucket (see {@link localDayExpr}); the
 * window is `[fromMs, toMs)` on `interval_end` (half-open, matching the original scan bounds). Result:
 * per PointId, a Map of localDay → count (points/days with no rows are simply absent).
 */
async function countAgg5mByLocalDay(
  points: PointId[],
  opts: { fromMs: number; toMs: number; offsetMin: number },
  exec?: ReadingsExec,
): Promise<Map<PointId, Map<string, number>>> {
  const out = new Map<PointId, Map<string, number>>(
    points.map((p) => [p, new Map()]),
  );
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  const from = new Date(opts.fromMs);
  const to = new Date(opts.toMs);
  const localDay = localDayExpr(opts.offsetMin);
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  // SEAM: rid-keyed WHERE. Raw SQL to reproduce the grouped local-day aggregate verbatim (the query
  // builder mis-serialises a reused GROUP BY expression).
  const res = await db.execute(sql`
    SELECT ${localDay} AS local_day,
           ${pointReadingsAgg5m.pointRid} AS point_rid,
           count(*)::int AS n
    FROM ${pointReadingsAgg5m}
    WHERE ${pointReadingsAgg5m.pointRid} IN (${sql.join(
      rids.map((r) => sql`${r}`),
      sql`, `,
    )})
      AND ${pointReadingsAgg5m.intervalEnd} >= ${from}
      AND ${pointReadingsAgg5m.intervalEnd} <  ${to}
    GROUP BY 1, 2
  `);
  for (const row of res.rows ?? []) {
    const rid = Number((row as { point_rid: unknown }).point_rid);
    const id = pointByRid.get(rid);
    if (!id) continue;
    const day = String((row as { local_day: unknown }).local_day);
    out.get(id)!.set(day, Number((row as { n: unknown }).n));
  }
  return out;
}

/**
 * Per-point `agg_5m` row count for ONE local day (the coverage runner's landing probe,
 * `countMaxPresent`). `WHERE localDay(offsetMin) = day`. Result: per PointId, its count (0 when absent).
 */
async function countAgg5mForLocalDay(
  points: PointId[],
  opts: { day: string; offsetMin: number },
  exec?: ReadingsExec,
): Promise<Map<PointId, number>> {
  const out = new Map<PointId, number>(points.map((p) => [p, 0]));
  if (points.length === 0) return out;
  const db = exec ?? requirePlanetscaleDb();
  const localDay = localDayExpr(opts.offsetMin);
  const ridByPoint = await RegistryCache.ridsForPoints(points);
  const rids = [...ridByPoint.values()];
  const pointByRid = new Map<number, PointId>(
    [...ridByPoint].map(([p, r]) => [r, p]),
  );
  // SEAM: rid-keyed WHERE. Raw SQL, verbatim with the original.
  const res = await db.execute(sql`
    SELECT ${pointReadingsAgg5m.pointRid} AS point_rid, count(*)::int AS n
    FROM ${pointReadingsAgg5m}
    WHERE ${pointReadingsAgg5m.pointRid} IN (${sql.join(
      rids.map((r) => sql`${r}`),
      sql`, `,
    )})
      AND ${localDay} = ${opts.day}
    GROUP BY ${pointReadingsAgg5m.pointRid}
  `);
  for (const row of res.rows ?? []) {
    const rid = Number((row as { point_rid: unknown }).point_rid);
    const id = pointByRid.get(rid);
    if (!id) continue;
    out.set(id, Number((row as { n: unknown }).n));
  }
  return out;
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────
/** point_readings — first-write-wins on the (point, time) unique. */
async function insertRaw(
  rows: RawInsert[],
  exec?: ReadingsExec,
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };
  const ridByPoint = await RegistryCache.ridsForPoints(
    rows.map((r) => r.point),
  );
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed value-building.
  const values = rows.map((r) => ({
    pointRid: ridByPoint.get(r.point)!,
    sessionId: r.sessionId,
    measurementTime: new Date(r.measurementTimeMs),
    receivedTime: new Date(r.receivedTimeMs),
    value: r.value,
    valueStr: r.valueStr,
    dataQuality: r.dataQuality ?? "good",
  }));
  const res = await db
    .insert(pointReadings)
    .values(values)
    .onConflictDoNothing()
    // Project a CUTOVER-INVARIANT column. Only `res.length` is ever read (every caller destructures
    // `{ inserted }`), so the column choice is arbitrary — but `point_readings.id`, the surrogate this
    // used to name, is DROPPED by the cutover in favour of the natural `(point_rid, measurement_time)`
    // PK. Naming it would 42703 on the receiver's hot path at resume, i.e. on the irreversible side.
    .returning({ k: pointReadings.measurementTime });
  return { inserted: res.length };
}

/**
 * point_readings_agg_5m. `upsert:true` (5m-native late refinements) overwrites the interval;
 * `upsert:false` (raw-vendor recompute owns the value) is first-write-wins. Mirrors the receiver
 * (`receive/route.ts`) conflict handling verbatim.
 *
 * `preserveVendorMeta` (only meaningful with `upsert:true`) narrows the on-conflict SET to the 7
 * aggregate value columns + `updated_at`, leaving `session_id`/`value_str`/`data_quality` untouched.
 * This is for the raw→5m recompute (`aggregate-points-pg.ts`), which OWNS the value columns but not
 * the vendor-meta columns — so a re-run must not clobber meta a 5m-native queue write may have set on
 * the same interval. Byte-identical to the legacy recompute's upsert. The receiver omits the flag and
 * gets the full-fidelity SET (it owns all columns).
 *
 * `writeDataQuality` (only meaningful with `preserveVendorMeta:true`) re-adds
 * `data_quality = excluded.data_quality` to the narrowed SET — the derivation/model writers
 * (battery-provenance blend, HWS) are the SOLE writer of their derived points and OWN both the value
 * columns AND `data_quality` (they set `"estimated"`/`"good"`), but never `session_id`/`value_str`
 * (always NULL for a derived point). Byte-identical to their legacy upsert.
 */
async function insert5m(
  rows: Agg5mInsert[],
  opts: {
    upsert: boolean;
    preserveVendorMeta?: boolean;
    writeDataQuality?: boolean;
  },
  exec?: ReadingsExec,
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };
  const ridByPoint = await RegistryCache.ridsForPoints(
    rows.map((r) => r.point),
  );
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed value-building.
  const values = rows.map((r) => ({
    pointRid: ridByPoint.get(r.point)!,
    intervalEnd: new Date(r.intervalEndMs),
    sessionId: r.sessionId,
    avg: r.avg,
    min: r.min,
    max: r.max,
    last: r.last,
    delta: r.delta,
    valueStr: r.valueStr,
    sampleCount: r.sampleCount,
    errorCount: r.errorCount,
    dataQuality: r.dataQuality,
  }));
  const insert = db.insert(pointReadingsAgg5m).values(values);
  const res = await (
    opts.upsert
      ? insert.onConflictDoUpdate({
          target: [pointReadingsAgg5m.pointRid, pointReadingsAgg5m.intervalEnd],
          set: {
            avg: sql`excluded.avg`,
            min: sql`excluded.min`,
            max: sql`excluded.max`,
            last: sql`excluded.last`,
            delta: sql`excluded.delta`,
            sampleCount: sql`excluded.sample_count`,
            errorCount: sql`excluded.error_count`,
            updatedAt: sql`now()`,
            // Vendor-meta columns: overwritten on a full-fidelity write (receiver); preserved for the
            // value-only recompute; `data_quality` re-added when a derived writer owns it.
            ...(opts.preserveVendorMeta
              ? opts.writeDataQuality
                ? { dataQuality: sql`excluded.data_quality` }
                : {}
              : {
                  sessionId: sql`excluded.session_id`,
                  valueStr: sql`excluded.value_str`,
                  dataQuality: sql`excluded.data_quality`,
                }),
          },
        })
      : insert.onConflictDoNothing()
  )
    // Cutover-invariant projection — `system_id` does not exist on the rid-keyed twin. Only
    // `res.length` is read. See insertRaw.
    .returning({ k: pointReadingsAgg5m.intervalEnd });
  return { written: res.length };
}

/** point_readings_agg_1d — always upsert (a day is recomputed as late readings land). */
async function upsert1d(
  rows: Agg1dUpsert[],
  exec?: ReadingsExec,
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };
  const ridByPoint = await RegistryCache.ridsForPoints(
    rows.map((r) => r.point),
  );
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed value-building.
  const values = rows.map((r) => ({
    pointRid: ridByPoint.get(r.point)!,
    day: r.day,
    avg: r.avg,
    min: r.min,
    max: r.max,
    last: r.last,
    delta: r.delta,
    sampleCount: r.sampleCount,
    errorCount: r.errorCount,
  }));
  const res = await db
    .insert(pointReadingsAgg1d)
    .values(values)
    .onConflictDoUpdate({
      target: [pointReadingsAgg1d.pointRid, pointReadingsAgg1d.day],
      set: {
        avg: sql`excluded.avg`,
        min: sql`excluded.min`,
        max: sql`excluded.max`,
        last: sql`excluded.last`,
        delta: sql`excluded.delta`,
        sampleCount: sql`excluded.sample_count`,
        errorCount: sql`excluded.error_count`,
        updatedAt: sql`now()`,
      },
    })
    // Cutover-invariant projection — `system_id` does not exist on the rid-keyed twin. See insertRaw.
    .returning({ k: pointReadingsAgg1d.day });
  return { written: res.length };
}

// ── Maintenance / range ops (not point-scoped) ─────────────────────────────────────────────────────
// Hot-table access WITHOUT a PointId key: a global earliest-interval probe, a distinct-device
// enumeration, and a whole-day-range delete. They live in the seam (the ONLY hot-table importer) but
// sit outside the PointId-keyed read/write surface above. `deviceIdsWithAgg5mSince` is an ADDITIONAL
// cutover touch-point beyond the two point-keyed SEAM kinds in the file header — tagged `// SEAM:` so
// Phase 8 finds it; the other two are cutover-invariant (interval_end / day keys are unchanged).

/** Earliest `agg_5m` interval as epoch-ms UTC, or null when the table is empty. */
async function earliestAgg5mMs(exec?: ReadingsExec): Promise<number | null> {
  const db = exec ?? requirePlanetscaleDb();
  const [row] = await db
    .select({ intervalEnd: pointReadingsAgg5m.intervalEnd })
    .from(pointReadingsAgg5m)
    .orderBy(pointReadingsAgg5m.intervalEnd)
    .limit(1);
  return row ? row.intervalEnd.getTime() : null;
}

/**
 * Distinct device (device) ids with `agg_5m` rows at/after `sinceMs`.
 * // SEAM: reads `system_id` directly today; Phase 8 → DISTINCT device via a `point_rid` join. The
 * return shape (device ids == device ids == device_rids) is stable across the cutover.
 */
async function deviceIdsWithAgg5mSince(
  sinceMs: number,
  exec?: ReadingsExec,
): Promise<DeviceId[]> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: the rid-keyed twin has no system_id — recover the distinct devices via a point_rid → points join.
  const rows = await db
    .selectDistinct({ deviceUuid: points.deviceId })
    .from(pointReadingsAgg5m)
    .innerJoin(points, eq(pointReadingsAgg5m.pointRid, points.rid))
    .where(gte(pointReadingsAgg5m.intervalEnd, new Date(sinceMs)));
  return rows.map((r) => Device.encode(r.deviceUuid));
}

/**
 * Latest `agg_5m` `interval_end` (epoch-ms UTC) for ONE device (device), or null when it has no rows.
 * Seeds the OE scheduler's KV state (`loadState`).
 * // SEAM: filters `system_id` directly today; Phase 8 → a device_rid join. The return shape is stable
 * across the cutover because the public DeviceId is resolved inside this seam.
 */
async function latestAgg5mIntervalMsForDevice(
  deviceId: DeviceId,
  exec?: ReadingsExec,
): Promise<number | null> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: filter the device via a point_rid → points.device_id join (the twin has no system_id).
  const { uuid } = await DeviceRegistry.addrForDevice(deviceId, db);
  return maxAgg5mIntervalMsForDeviceUuids([uuid], db);
}

/**
 * Latest `agg_5m` `interval_end` (epoch-ms UTC) across a set of device uuids, or null when none of
 * them has any row. Shared by the one-device and many-device seams.
 *
 * ⚠️ The LATERAL is load-bearing — do NOT "simplify" this back to the flat
 *   `agg_5m JOIN points … WHERE points.device_id = … ORDER BY interval_end DESC LIMIT 1`.
 * Pre-cutover that shape rode `pr5m_system_time_idx (system_id, interval_end)`, which the twins do NOT
 * recreate. Left with only `pr5m_new_interval_end_idx`, the planner reads the flat form's
 * `ORDER BY … DESC LIMIT 1` as licence to walk the GLOBAL time index backwards and filter each row by
 * device — quick for a device that reported a minute ago, catastrophic for a stale one. Measured on
 * the transformed liveone-dev twin (5.5M agg_5m rows): a device last seen 2026-01-06 scanned 3,084,559
 * rows / ~994k buffers in **29.5 s**. Rewriting the predicate to `point_rid = ANY(array)` did NOT help
 * (27.2 s) — the misestimate is on the LIMIT, not the predicate.
 *
 * Driving from `points` turns each device's handful of rids into its own `(point_rid, interval_end)`
 * PK probe — an Index Only Scan Backward that stops on the first row — so cost tracks the device's
 * POINT COUNT, not the table size. Same stale device: **0.76 ms** (~39,000×); 28 ms cold for two
 * devices / 21 points.
 */
async function maxAgg5mIntervalMsForDeviceUuids(
  uuids: string[],
  db: ReadingsExec,
): Promise<number | null> {
  if (uuids.length === 0) return null;
  const list = uuids.map((u) => `'${u}'`).join(",");
  const res = await db.execute(
    sql.raw(
      `SELECT (EXTRACT(EPOCH FROM max(x.interval_end) AT TIME ZONE 'UTC') * 1000)::bigint AS latest_ms
       FROM points r
       CROSS JOIN LATERAL (
         SELECT a.interval_end FROM point_readings_agg_5m a
         WHERE a.point_rid = r.rid
         ORDER BY a.interval_end DESC LIMIT 1
       ) x
       WHERE r.device_id = ANY(ARRAY[${list}]::uuid[])`,
    ),
  );
  const raw = ((
    res as unknown as { rows?: { latest_ms: string | number | null }[] }
  ).rows ?? [])[0]?.latest_ms;
  return raw === null || raw === undefined ? null : Number(raw);
}

/** Which hot table's `created_at` axis an observability query reads. Kept inside the seam so callers
 *  never name a hot table (the boundary gate). Both tables carry `created_at NOT NULL DEFAULT now()`. */
type CreatedAtSource = "raw" | "agg5m";

/**
 * Count rows with `created_at >= sinceMs` on the raw or 5m hot table (fleet-wide ingestion counters;
 * admin/observations/stats + cron/monitor-observations). Cutover-invariant: `created_at` persists on
 * the rid-keyed twins; no composite/rid key in the WHERE.
 */
async function countByCreatedAtSince(
  which: CreatedAtSource,
  sinceMs: number,
  exec?: ReadingsExec,
): Promise<number> {
  const db = exec ?? requirePlanetscaleDb();
  const since = new Date(sinceMs);
  const n = sql<number>`count(*)::int`;
  const rows =
    which === "raw"
      ? await db
          .select({ n })
          .from(pointReadings)
          .where(gte(pointReadings.createdAt, since))
      : await db
          .select({ n })
          .from(pointReadingsAgg5m)
          .where(gte(pointReadingsAgg5m.createdAt, since));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Per-minute `created_at` histogram (`date_trunc('minute', created_at)`, `count(*)`) since `sinceMs`,
 * ascending, on the raw or 5m hot table (the admin stats sparkline). Cutover-invariant.
 */
async function createdAtHistogramSince(
  which: CreatedAtSource,
  sinceMs: number,
  exec?: ReadingsExec,
): Promise<{ minuteMs: number; count: number }[]> {
  const db = exec ?? requirePlanetscaleDb();
  const since = new Date(sinceMs);
  const n = sql<number>`count(*)::int`;
  const rows =
    which === "raw"
      ? await db
          .select({
            minute: sql<Date>`date_trunc('minute', ${pointReadings.createdAt})`,
            count: n,
          })
          .from(pointReadings)
          .where(gte(pointReadings.createdAt, since))
          .groupBy(sql`1`)
          .orderBy(sql`1`)
      : await db
          .select({
            minute: sql<Date>`date_trunc('minute', ${pointReadingsAgg5m.createdAt})`,
            count: n,
          })
          .from(pointReadingsAgg5m)
          .where(gte(pointReadingsAgg5m.createdAt, since))
          .groupBy(sql`1`)
          .orderBy(sql`1`);
  return rows.map((r) => ({
    minuteMs: new Date(r.minute).getTime(),
    count: Number(r.count),
  }));
}

/**
 * Distinct raw-`point_readings` device (device) ids with `created_at >= sinceMs` (stats `systems_24h`).
 * // SEAM: reads `system_id` directly today; Phase 8 → DISTINCT device via a `point_rid` join. The
 * return count (device ids == device ids == device_rids) is stable across the cutover.
 */
async function distinctDevicesByRawCreatedAtSince(
  sinceMs: number,
  exec?: ReadingsExec,
): Promise<number> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: count distinct devices via a point_rid → points join (the twin has no system_id).
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${points.deviceId})::int` })
    .from(pointReadings)
    .innerJoin(points, eq(pointReadings.pointRid, points.rid))
    .where(gte(pointReadings.createdAt, new Date(sinceMs)));
  return Number(row?.n ?? 0);
}

/** Latest raw-`point_readings` `created_at` (epoch-ms UTC) fleet-wide, or null when empty (the
 *  "last ingested at" clock). Cutover-invariant. */
async function latestRawCreatedAtMs(
  exec?: ReadingsExec,
): Promise<number | null> {
  const db = exec ?? requirePlanetscaleDb();
  const [row] = await db
    .select({ createdAt: pointReadings.createdAt })
    .from(pointReadings)
    .orderBy(desc(pointReadings.createdAt))
    .limit(1);
  return row ? row.createdAt.getTime() : null;
}

/** Fleet raw landing count over a DB-clock-relative lookback plus the all-time latest arrival. */
async function rawLandingHealth(
  lookbackMs: number,
  exec?: ReadingsExec,
): Promise<{ count: number; latestCreatedAtMs: number | null }> {
  const db = exec ?? requirePlanetscaleDb();
  const res = await db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE created_at >= now() - (${lookbackMs} || ' milliseconds')::interval
      )::int AS n,
      max(created_at) AS latest
    FROM ${pointReadings}
  `);
  const row = (res.rows?.[0] ?? {}) as { n?: unknown; latest?: unknown };
  return {
    count: Number(row.n ?? 0),
    latestCreatedAtMs:
      row.latest == null
        ? null
        : new Date(row.latest as string | number | Date).getTime(),
  };
}

/**
 * Latest `agg_5m` `interval_end` (epoch-ms UTC) across a SET of devices (devices), or null when the set
 * is empty or has no rows (the battery-provenance blend-freshness probe — caller passes the helper-vendor
 * device ids). // SEAM: filters `system_id` directly today; Phase 8 → a device_rid `IN`. Stable shape.
 */
async function maxAgg5mIntervalMsForDevices(
  deviceIds: DeviceId[],
  exec?: ReadingsExec,
): Promise<number | null> {
  if (deviceIds.length === 0) return null;
  const db = exec ?? requirePlanetscaleDb();
  const mappings = await DeviceRegistry.addrsForDevices(deviceIds, db);
  // SEAM: filter the device set via a point_rid → points.device_id join (the twin has no system_id).
  const uuids = deviceIds.map((id) => {
    const device = mappings.get(id);
    if (!device) throw new Error(`Missing device mapping for ${id}`);
    return device.uuid;
  });
  // Same planner trap as the single-device seam — see maxAgg5mIntervalMsForDeviceUuids.
  return maxAgg5mIntervalMsForDeviceUuids(uuids, db);
}

/**
 * Delete every `agg_1d` row in the inclusive `[startDay, endDay]` range across ALL points/devices
 * (day-keyed maintenance delete, not point-scoped). Returns the number of rows removed. Cutover-invariant:
 * the `day` text key is unchanged post-cutover (no composite/rid columns in the WHERE).
 */
async function delete1dRange(
  range: DayRange,
  exec?: ReadingsExec,
): Promise<{ deleted: number }> {
  const db = exec ?? requirePlanetscaleDb();
  const res = await db
    .delete(pointReadingsAgg1d)
    .where(
      and(
        gte(pointReadingsAgg1d.day, range.startDay),
        lte(pointReadingsAgg1d.day, range.endDay),
      ),
    )
    .returning({ day: pointReadingsAgg1d.day });
  return { deleted: res.length };
}

/**
 * Overwrite the `value` of existing raw readings, keyed on the real PK (point rid, measurement_time).
 *
 * REPAIR-ONLY. The ingest pipeline never needs this — it inserts. This exists so a vendor-semantics
 * defect (a sign convention stored inverted, a field never read) can be corrected in place by
 * REPLAYING the archived payload in `sessions.response` through the fixed adapter, rather than by
 * blind arithmetic like `value = -value`, which is neither idempotent nor safe to re-run. See
 * `scripts/utils/rebuild-sigenergy-readings.ts`.
 *
 * Silently ignores rows that don't exist — callers derive the list from a prior read, so a missing
 * row means it was deleted underneath us, not that the caller is wrong.
 */
async function updateRawValues(
  updates: { point: PointId; measurementTimeMs: number; value: number }[],
  exec?: ReadingsExec,
): Promise<{ updated: number }> {
  if (updates.length === 0) return { updated: 0 };
  const db = exec ?? requirePlanetscaleDb();
  const ridByPoint = await RegistryCache.ridsForPoints([
    ...new Set(updates.map((u) => u.point)),
  ]);
  let updated = 0;
  // Chunked so one statement can't blow the parameter limit on a multi-week repair.
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    const tuples = chunk
      .map((u) => {
        const rid = ridByPoint.get(u.point);
        if (rid == null) return null;
        return sql`(${rid}::integer, ${new Date(u.measurementTimeMs).toISOString()}::timestamp, ${u.value}::double precision)`;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (tuples.length === 0) continue;
    const res = await db.execute(sql`
      update point_readings pr
      set value = v.value
      from (values ${sql.join(tuples, sql`, `)}) as v(point_rid, measurement_time, value)
      where pr.point_rid = v.point_rid and pr.measurement_time = v.measurement_time
    `);
    updated += res.rowCount ?? 0;
  }
  return { updated };
}

// ── Admin readings views (config-v4 PR-I) ──────────────────────────────────────────────────────────
// The admin point-readings pivot + single-point ±window drill-downs, relocated VERBATIM from the former
// `lib/db/planetscale/readings-read-pg.ts`. They are raw `sql.raw(...)` queries — naming the hot tables
// is legal only inside `lib/readings/` (the seam's home / the boundary gate's structurally-allowed
// zone). Keeping the exact SQL keeps the admin routes byte-identical; the `// SEAM:` tags mark the
// Phase-8 re-key points (system_id → device_rid, point_id → point_rid).

/** A raw admin-view row: dynamic pivot columns, or the rich single-point window fields. */
type Row = Record<string, unknown>;

/** Which hot store an admin probe/pivot reads. A plain enum so callers never name a hot table. */
export type ReadingStore = "raw" | "agg5m" | "agg1d";
const STORE_TABLE: Record<ReadingStore, string> = {
  raw: "point_readings",
  agg5m: "point_readings_agg_5m",
  agg1d: "point_readings_agg_1d",
};
const STORE_TIME_COL: Record<ReadingStore, string> = {
  raw: "measurement_time",
  agg5m: "interval_end",
  agg1d: "day",
};

/** A `timestamp without time zone` literal (UTC) for an epoch-ms value — TZ-independent. */
function tsLitUTC(ms: number): string {
  return `(to_timestamp(${Number(ms)} / 1000.0) AT TIME ZONE 'UTC')`;
}

export type AdminPivotValueColumn =
  | "value"
  | "valueStr"
  | "avg"
  | "last"
  | "delta";

export interface AdminPivotParams {
  device: DeviceId;
  source: "raw" | "5m" | "daily";
  cursor: number | string | null;
  direction: "older" | "newer";
  limit: number;
  points: {
    point: PointId;
    /** Stable response key, restricted to the existing `point_<index>` wire grammar. */
    outputKey: string;
    valueColumn: AdminPivotValueColumn;
  }[];
}

/**
 * Admin point-readings pivot (rows = timestamps × columns = per-point aggregates), with keyset
 * pagination and a session-label join (raw/5m). `measurement_time` comes back as epoch-ms (raw/5m)
 * or a YYYY-MM-DD string (daily), matching the route's transform. Verbatim relocation of the former
 * `fetchAdminPivotRowsPg`. // SEAM: filters `system_id` directly (Phase 8 → device_rid).
 */
async function readAdminPivot(
  p: AdminPivotParams,
  exec?: ReadingsExec,
): Promise<Row[]> {
  const { source, cursor, direction } = p;
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: device filter → points.device_id (join); pivot CASE → pr.point_rid. The twin has no
  // system_id/point_id, so the on-device check keys on the point's own (immutable) systemId == the
  // device handle, and each pivot column selects its point by the globally-unique point_rid.
  const { handle: systemId, uuid: deviceUuid } =
    await DeviceRegistry.addrForDevice(p.device, db);
  const pointAddrs = await RegistryCache.addrsForPoints(
    p.points.map((point) => point.point),
  );
  const columns = {
    value: "value",
    valueStr: "value_str",
    avg: "avg",
    last: "last",
    delta: "delta",
  } as const;
  const pivotColumns = p.points
    .map((point) => {
      if (!/^point_\d+$/.test(point.outputKey))
        throw new Error(`Invalid admin pivot output key: ${point.outputKey}`);
      const addr = pointAddrs.get(point.point);
      if (!addr || addr.systemId !== systemId)
        throw new Error(`Admin pivot point is not on device ${p.device}`);
      return `MAX(CASE WHEN pr.point_rid = ${addr.rid} THEN pr.${columns[point.valueColumn]} END) as ${point.outputKey}`;
    })
    .join(",\n  ");
  const limit = Math.max(1, Math.min(1000, Math.trunc(p.limit)));
  const run = async (query: string): Promise<Row[]> => {
    const res = await db.execute(sql.raw(query));
    return ((res as { rows?: Row[] }).rows ?? []) as Row[];
  };

  if (source === "daily") {
    const cursorFilter = cursor
      ? direction === "older"
        ? `AND day < '${cursor}'`
        : `AND day > '${cursor}'`
      : "";
    const orderDirection = direction === "newer" && cursor ? "ASC" : "DESC";
    return run(`
      WITH recent_days AS (
        SELECT DISTINCT day
        FROM point_readings_agg_1d pr
        INNER JOIN points ON pr.point_rid = points.rid
        WHERE points.device_id = '${deviceUuid}'
        ${cursorFilter}
        ORDER BY day ${orderDirection}
        LIMIT ${limit}
      )
      SELECT
        pr.day as measurement_time,
        NULL as session_id,
        NULL as session_label,
        ${pivotColumns}
      FROM point_readings_agg_1d pr
      INNER JOIN points ON pr.point_rid = points.rid
      WHERE points.device_id = '${deviceUuid}'
        AND pr.day IN (SELECT day FROM recent_days)
      GROUP BY pr.day
      ORDER BY pr.day DESC
    `);
  }

  // raw / 5m share the timestamp shape; only the table + time column differ.
  const table = source === "5m" ? "point_readings_agg_5m" : "point_readings";
  const timeCol = source === "5m" ? "interval_end" : "measurement_time";
  const tsCursor =
    cursor != null ? `to_timestamp(${Number(cursor)} / 1000.0)` : null;
  const cursorFilter = tsCursor
    ? direction === "older"
      ? `AND ${timeCol} < ${tsCursor}`
      : `AND ${timeCol} > ${tsCursor}`
    : "";
  const orderDirection = direction === "newer" && cursor ? "ASC" : "DESC";

  const rows = await run(`
    WITH recent_timestamps AS (
      SELECT DISTINCT ${timeCol}
      FROM ${table} pr
      INNER JOIN points ON pr.point_rid = points.rid
      WHERE points.device_id = '${deviceUuid}'
      ${cursorFilter}
      ORDER BY ${timeCol} ${orderDirection}
      LIMIT ${limit}
    )
    SELECT
      (EXTRACT(EPOCH FROM pr.${timeCol} AT TIME ZONE 'UTC') * 1000)::bigint as measurement_time,
      pr.session_id,
      s.session_label,
      ${pivotColumns}
    FROM ${table} pr
    INNER JOIN points ON pr.point_rid = points.rid
    LEFT JOIN sessions s ON pr.session_id = s.id
    WHERE points.device_id = '${deviceUuid}'
      AND pr.${timeCol} IN (SELECT ${timeCol} FROM recent_timestamps)
    GROUP BY pr.${timeCol}, pr.session_id, s.session_label
    ORDER BY pr.${timeCol} DESC, pr.session_id
  `);
  // node-postgres returns the epoch-ms bigint as a string; coerce to a number so the route's
  // `new Date(measurement_time)` + cursor formatting work (raw/5m only — daily stays a YYYY-MM-DD string).
  return rows.map((r) => ({
    ...r,
    measurement_time: Number(r.measurement_time),
  }));
}

/**
 * Does device (device) `systemId` have ANY rows in `store`? (`SELECT 1 … LIMIT 1`, index-friendly —
 * never `COUNT(*)`). The admin pivot's "is there data in the other store?" probe.
 * // SEAM: filters `system_id` directly (Phase 8 → device_rid).
 */
async function hasReadingsForDevice(
  deviceId: DeviceId,
  store: ReadingStore,
  exec?: ReadingsExec,
): Promise<boolean> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: the twin has no system_id — probe via a point_rid → points.device_id join.
  const { uuid } = await DeviceRegistry.addrForDevice(deviceId, db);
  const res = await db.execute(
    sql.raw(
      `SELECT 1 FROM ${STORE_TABLE[store]} pr JOIN points ON pr.point_rid = points.rid WHERE points.device_id = '${uuid}' LIMIT 1`,
    ),
  );
  return (((res as { rows?: unknown[] }).rows ?? []).length ?? 0) > 0;
}

/**
 * Does device (device) `systemId` have any `store` row strictly older / newer than `boundary`? (the
 * admin pivot's hasOlder / hasNewer pagination probes; `SELECT 1 … LIMIT 1`). `boundary` is a
 * YYYY-MM-DD string for `agg1d` (string compare) or epoch-ms for raw/5m (→ `to_timestamp`).
 * `direction`: "older" → `<`, "newer" → `>`. // SEAM: filters `system_id` directly (Phase 8 → device_rid).
 */
async function hasReadingsForDeviceBeyond(
  deviceId: DeviceId,
  store: ReadingStore,
  boundary: number | string,
  direction: "older" | "newer",
  exec?: ReadingsExec,
): Promise<boolean> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: the twin has no system_id — probe via a point_rid → points.device_id join.
  const { uuid } = await DeviceRegistry.addrForDevice(deviceId, db);
  const op = direction === "older" ? "<" : ">";
  const rhs =
    store === "agg1d"
      ? `'${boundary}'`
      : `to_timestamp(${Number(boundary)} / 1000.0)`;
  const res = await db.execute(
    sql.raw(
      `SELECT 1 FROM ${STORE_TABLE[store]} pr JOIN points ON pr.point_rid = points.rid WHERE points.device_id = '${uuid}' AND pr.${STORE_TIME_COL[store]} ${op} ${rhs} LIMIT 1`,
    ),
  );
  return (((res as { rows?: unknown[] }).rows ?? []).length ?? 0) > 0;
}

/**
 * Raw readings in a ±1 hour window around `centerMs` for ONE point (admin single-point drill-down;
 * LEFT JOIN sessions for the label). Relocated from the former `fetchSinglePointReadingsPg` raw branch.
 * Returns rich rows keyed by the SQL aliases; `measurementTime` and `receivedTime` are epoch-ms.
 * // SEAM: composite-key WHERE (Phase 8 → point_rid).
 *
 * The projection deliberately omits `pr.id` / `pr.system_id` / `pr.point_id`: all three cease to exist
 * at the cutover (the surrogate id is dropped for the natural `(point_rid, measurement_time)` PK), and
 * no consumer reads them — the route supplies `metadata.systemId`/`pointId` from its own params and
 * `PointReadingInspectorModal` renders its own props. Dropping them now keeps the rid flip mechanical.
 */
async function readRawWindowAround(
  point: PointId,
  centerMs: number,
  exec?: ReadingsExec,
): Promise<Row[]> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE (single point).
  const rid = await RegistryCache.ridForPoint(point);
  const oneHour = 60 * 60 * 1000;
  const startTime = centerMs - oneHour;
  const endTime = centerMs + oneHour;
  const res = await db.execute(
    sql.raw(`
    SELECT
      pr.session_id as "sessionId",
      (EXTRACT(EPOCH FROM pr.measurement_time AT TIME ZONE 'UTC') * 1000)::bigint as "measurementTime",
      (EXTRACT(EPOCH FROM pr.received_time AT TIME ZONE 'UTC') * 1000)::bigint as "receivedTime",
      pr.value,
      pr.value_str as "valueStr",
      pr.error,
      pr.data_quality as "dataQuality",
      s.session_label as "sessionLabel"
    FROM point_readings pr
    LEFT JOIN sessions s ON pr.session_id = s.id
    WHERE pr.point_rid = ${rid}
      AND pr.measurement_time >= ${tsLitUTC(startTime)}
      AND pr.measurement_time <= ${tsLitUTC(endTime)}
    ORDER BY pr.measurement_time ASC
  `),
  );
  const rows = ((res as { rows?: Row[] }).rows ?? []) as Row[];
  // Coerce the epoch-ms bigints (returned as strings by node-postgres) to numbers.
  return rows.map((r) => ({
    ...r,
    measurementTime: Number(r.measurementTime),
    receivedTime: Number(r.receivedTime),
  }));
}

/**
 * 5-minute aggregates in a ROW_NUMBER ±10 window centred on the interval ending at `centerMs`, for ONE
 * point (admin single-point drill-down; LEFT JOIN sessions). Relocated from the former
 * `fetchSinglePointReadingsPg` 5m branch. `intervalEnd` is epoch-ms. // SEAM: composite-key WHERE
 * (Phase 8 → point_rid). The `system_id`/`point_id` passthroughs are omitted for the same reason as in
 * `readRawWindowAround` — they vanish at the cutover and nothing reads them.
 */
async function read5mRowWindowAround(
  point: PointId,
  centerMs: number,
  exec?: ReadingsExec,
): Promise<Row[]> {
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: rid-keyed WHERE (single point).
  const rid = await RegistryCache.ridForPoint(point);
  const res = await db.execute(
    sql.raw(`
      WITH all_rows AS (
        SELECT interval_end, ROW_NUMBER() OVER (ORDER BY interval_end ASC) as row_num
        FROM point_readings_agg_5m
        WHERE point_rid = ${rid}
      ),
      target_position AS (
        SELECT row_num as target_row FROM all_rows
        WHERE interval_end = ${tsLitUTC(centerMs)}
      ),
      ranked AS (
        SELECT
          pr.session_id as "sessionId",
          (EXTRACT(EPOCH FROM pr.interval_end AT TIME ZONE 'UTC') * 1000)::bigint as "intervalEnd",
          pr.avg,
          pr.min,
          pr.max,
          pr.last,
          pr.delta,
          pr.sample_count as "sampleCount",
          pr.error_count as "errorCount",
          pr.data_quality as "dataQuality",
          s.session_label as "sessionLabel",
          ROW_NUMBER() OVER (ORDER BY pr.interval_end ASC) as row_num
        FROM point_readings_agg_5m pr
        LEFT JOIN sessions s ON pr.session_id = s.id
        WHERE pr.point_rid = ${rid}
      )
      SELECT ranked.* FROM ranked, target_position
      WHERE ranked.row_num BETWEEN (target_position.target_row - 10) AND (target_position.target_row + 10)
      ORDER BY "intervalEnd" ASC
    `),
  );
  const rows = ((res as { rows?: Row[] }).rows ?? []) as Row[];
  // Coerce the epoch-ms bigint (returned as a string by node-postgres) to a number.
  return rows.map((r) => ({ ...r, intervalEnd: Number(r.intervalEnd) }));
}

/** Wrap several writes in ONE transaction (the receiver: session-first, then raw + 5m). */
function transaction<T>(fn: (tx: ReadingsExec) => Promise<T>): Promise<T> {
  return requirePlanetscaleDb().transaction(fn as (tx: PgTx) => Promise<T>);
}

/** Node-only preview transfer, lazy so application request paths never load child-process code. */
async function seedPreviewDatabase(options: SeedPreviewDatabaseOptions) {
  const { seedPreviewDatabase: run } = await import("./preview-seed");
  return run(options);
}

/** Node-only two-connection COPY sync, lazy so request paths never load pg-copy-streams. */
async function syncProdToDev(options: SyncProdToDevOptions) {
  const { syncProdToDev: run } = await import("./prod-dev-sync");
  return run(options);
}

export const ReadingsDao = {
  readRaw,
  read5m,
  read1d,
  latestForPoints,
  latest5mForPoints,
  latestForActivePoints,
  agg5mCoverageForPoints,
  approximateRowCount,
  latestAgg5mIntervalMsForPoints,
  latestAgg5mUpdatedAtForPoint,
  latestAgg5mUpdatedAtForPoints,
  countAgg5mByLocalDay,
  countAgg5mForLocalDay,
  insertRaw,
  insert5m,
  upsert1d,
  updateRawValues,
  earliestAgg5mMs,
  deviceIdsWithAgg5mSince,
  latestAgg5mIntervalMsForDevice,
  countByCreatedAtSince,
  createdAtHistogramSince,
  distinctDevicesByRawCreatedAtSince,
  latestRawCreatedAtMs,
  rawLandingHealth,
  maxAgg5mIntervalMsForDevices,
  delete1dRange,
  readAdminPivot,
  hasReadingsForDevice,
  hasReadingsForDeviceBeyond,
  readRawWindowAround,
  read5mRowWindowAround,
  transaction,
  seedPreviewDatabase,
  syncProdToDev,
};
