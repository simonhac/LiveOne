/**
 * The time-series data-access seam — UUIDs in, rids below.
 *
 * Config-v4 (docs/plans/config-v4-execution-plan.md §3): the public methods here take the `pt_…`
 * TypeID (`PointId`) and their signatures are IDENTICAL before and after the Phase-8 cutover. Today
 * (pre-cutover) each method resolves `PointId → (system_id, index)` via {@link RegistryCache} and
 * issues the composite-key SQL the hot tables use verbatim; at the cutover the SAME methods will
 * resolve `PointId → point_rid` and issue rid-keyed SQL. Callers never change.
 *
 * ┌─ SEAM / CUTOVER TOUCH-POINTS ──────────────────────────────────────────────────────────────────┐
 * │ The ONLY places that know the hot-table key shape are the two `// SEAM:` sections below —        │
 * │  (1) write value-building: `{ systemId, pointId: a.index, … }`                                   │
 * │  (2) read WHERE + result mapping: `and(eq(system_id), inArray(point_id, …))` + `rev` reverse-map │
 * │ Phase 8 reimplements exactly these to use `point_rid` (and drops `schema-internal`'s composite   │
 * │ columns for the rid column). Nothing else in this file changes.                                  │
 * └────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Time crosses this boundary as epoch-ms UTC (every existing caller speaks epoch-ms; `Date` is a
 * DB-internal representation). The `agg_1d` day key stays a `YYYY-MM-DD` string. Writes optionally
 * run inside a caller transaction via the `exec?` param (the receiver: session-first, then raw + 5m).
 */
import { and, eq, gte, lt, lte, inArray, desc, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { RegistryCache, type PointAddr } from "@/lib/registry";
import type { PointId } from "@/lib/ids";
import {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "./schema-internal";

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

// ── Internal helpers ────────────────────────────────────────────────────────────────────────────────
const addrKey = (systemId: number, index: number) => `${systemId}.${index}`;

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

/** Group resolved addresses by system + build the (systemId.index → PointId) reverse map. */
function groupBySystem(addrs: Map<PointId, PointAddr>): {
  bySystem: Map<number, number[]>;
  rev: Map<string, PointId>;
} {
  const bySystem = new Map<number, number[]>();
  const rev = new Map<string, PointId>();
  for (const [id, a] of addrs) {
    let idxs = bySystem.get(a.systemId);
    if (!idxs) bySystem.set(a.systemId, (idxs = []));
    idxs.push(a.index);
    rev.set(addrKey(a.systemId, a.index), id);
  }
  return { bySystem, rev };
}

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
  // SEAM: composite-key expansion + WHERE (Phase 8 → point_rid).
  const { bySystem, rev } = groupBySystem(
    await RegistryCache.addrsForPoints(points),
  );
  for (const [systemId, indexes] of bySystem) {
    const rows = await db
      .select({
        pointId: pointReadings.pointId,
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
          eq(pointReadings.systemId, systemId),
          inArray(pointReadings.pointId, indexes),
          gte(pointReadings.measurementTime, from),
          upperBoundOp(window.toInclusive)(pointReadings.measurementTime, to),
        ),
      )
      .orderBy(pointReadings.measurementTime);
    for (const r of rows) {
      const id = rev.get(addrKey(systemId, r.pointId));
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
  // SEAM: composite-key expansion + WHERE (Phase 8 → point_rid).
  const { bySystem, rev } = groupBySystem(
    await RegistryCache.addrsForPoints(points),
  );
  for (const [systemId, indexes] of bySystem) {
    const rows = await db
      .select({
        pointId: pointReadingsAgg5m.pointId,
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
          eq(pointReadingsAgg5m.systemId, systemId),
          inArray(pointReadingsAgg5m.pointId, indexes),
          gte(pointReadingsAgg5m.intervalEnd, from),
          upperBoundOp(window.toInclusive)(pointReadingsAgg5m.intervalEnd, to),
        ),
      )
      .orderBy(pointReadingsAgg5m.intervalEnd);
    for (const r of rows) {
      const id = rev.get(addrKey(systemId, r.pointId));
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
  // SEAM: composite-key expansion + WHERE (Phase 8 → point_rid).
  const { bySystem, rev } = groupBySystem(
    await RegistryCache.addrsForPoints(points),
  );
  for (const [systemId, indexes] of bySystem) {
    const rows = await db
      .select({
        pointId: pointReadingsAgg1d.pointId,
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
          eq(pointReadingsAgg1d.systemId, systemId),
          inArray(pointReadingsAgg1d.pointId, indexes),
          gte(pointReadingsAgg1d.day, range.startDay),
          lte(pointReadingsAgg1d.day, range.endDay),
        ),
      )
      .orderBy(pointReadingsAgg1d.day);
    for (const r of rows) {
      const id = rev.get(addrKey(systemId, r.pointId));
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
  // SEAM: composite-key expansion + WHERE (Phase 8 → point_rid; DISTINCT ON (point_rid)).
  const { bySystem, rev } = groupBySystem(
    await RegistryCache.addrsForPoints(points),
  );
  for (const [systemId, indexes] of bySystem) {
    const rows = await db
      .selectDistinctOn([pointReadings.pointId], {
        pointId: pointReadings.pointId,
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
          eq(pointReadings.systemId, systemId),
          inArray(pointReadings.pointId, indexes),
        ),
      )
      .orderBy(pointReadings.pointId, desc(pointReadings.measurementTime));
    for (const r of rows) {
      const id = rev.get(addrKey(systemId, r.pointId));
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
  // SEAM: composite-key expansion + WHERE (Phase 8 → point_rid; DISTINCT ON (point_rid)).
  const { bySystem, rev } = groupBySystem(
    await RegistryCache.addrsForPoints(points),
  );
  for (const [systemId, indexes] of bySystem) {
    const rows = await db
      .selectDistinctOn([pointReadingsAgg5m.pointId], {
        pointId: pointReadingsAgg5m.pointId,
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
          eq(pointReadingsAgg5m.systemId, systemId),
          inArray(pointReadingsAgg5m.pointId, indexes),
        ),
      )
      .orderBy(
        pointReadingsAgg5m.pointId,
        desc(pointReadingsAgg5m.intervalEnd),
      );
    for (const r of rows) {
      const id = rev.get(addrKey(systemId, r.pointId));
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
  }
  return out;
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
  const { bySystem, rev } = groupBySystem(
    await RegistryCache.addrsForPoints(points),
  );
  for (const [systemId, indexes] of bySystem) {
    // SEAM: composite-key WHERE (Phase 8 → point_rid). Raw SQL to reproduce the grouped local-day
    // aggregate verbatim (the query builder mis-serialises a reused GROUP BY expression).
    const res = await db.execute(sql`
      SELECT ${localDay} AS local_day,
             ${pointReadingsAgg5m.pointId} AS point_id,
             count(*)::int AS n
      FROM ${pointReadingsAgg5m}
      WHERE ${pointReadingsAgg5m.systemId} = ${systemId}
        AND ${pointReadingsAgg5m.pointId} IN (${sql.join(
          indexes.map((i) => sql`${i}`),
          sql`, `,
        )})
        AND ${pointReadingsAgg5m.intervalEnd} >= ${from}
        AND ${pointReadingsAgg5m.intervalEnd} <  ${to}
      GROUP BY 1, 2
    `);
    for (const row of res.rows ?? []) {
      const pid = Number((row as { point_id: unknown }).point_id);
      const id = rev.get(addrKey(systemId, pid));
      if (!id) continue;
      const day = String((row as { local_day: unknown }).local_day);
      out.get(id)!.set(day, Number((row as { n: unknown }).n));
    }
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
  const { bySystem, rev } = groupBySystem(
    await RegistryCache.addrsForPoints(points),
  );
  for (const [systemId, indexes] of bySystem) {
    // SEAM: composite-key WHERE (Phase 8 → point_rid). Raw SQL, verbatim with the original.
    const res = await db.execute(sql`
      SELECT ${pointReadingsAgg5m.pointId} AS point_id, count(*)::int AS n
      FROM ${pointReadingsAgg5m}
      WHERE ${pointReadingsAgg5m.systemId} = ${systemId}
        AND ${pointReadingsAgg5m.pointId} IN (${sql.join(
          indexes.map((i) => sql`${i}`),
          sql`, `,
        )})
        AND ${localDay} = ${opts.day}
      GROUP BY ${pointReadingsAgg5m.pointId}
    `);
    for (const row of res.rows ?? []) {
      const pid = Number((row as { point_id: unknown }).point_id);
      const id = rev.get(addrKey(systemId, pid));
      if (!id) continue;
      out.set(id, Number((row as { n: unknown }).n));
    }
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
  const addrs = await RegistryCache.addrsForPoints(rows.map((r) => r.point));
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: composite-key value-building (Phase 8 → { pointRid }).
  const values = rows.map((r) => {
    const a = addrs.get(r.point)!;
    return {
      systemId: a.systemId,
      pointId: a.index,
      sessionId: r.sessionId,
      measurementTime: new Date(r.measurementTimeMs),
      receivedTime: new Date(r.receivedTimeMs),
      value: r.value,
      valueStr: r.valueStr,
      dataQuality: r.dataQuality ?? "good",
    };
  });
  const res = await db
    .insert(pointReadings)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: pointReadings.id });
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
 */
async function insert5m(
  rows: Agg5mInsert[],
  opts: { upsert: boolean; preserveVendorMeta?: boolean },
  exec?: ReadingsExec,
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };
  const addrs = await RegistryCache.addrsForPoints(rows.map((r) => r.point));
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: composite-key value-building (Phase 8 → { pointRid }).
  const values = rows.map((r) => {
    const a = addrs.get(r.point)!;
    return {
      systemId: a.systemId,
      pointId: a.index,
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
    };
  });
  const insert = db.insert(pointReadingsAgg5m).values(values);
  const res = await (
    opts.upsert
      ? insert.onConflictDoUpdate({
          target: [
            pointReadingsAgg5m.systemId,
            pointReadingsAgg5m.pointId,
            pointReadingsAgg5m.intervalEnd,
          ],
          set: {
            avg: sql`excluded.avg`,
            min: sql`excluded.min`,
            max: sql`excluded.max`,
            last: sql`excluded.last`,
            delta: sql`excluded.delta`,
            sampleCount: sql`excluded.sample_count`,
            errorCount: sql`excluded.error_count`,
            updatedAt: sql`now()`,
            // Vendor-meta columns: overwritten on a full-fidelity write (receiver), preserved for the
            // value-only recompute.
            ...(opts.preserveVendorMeta
              ? {}
              : {
                  sessionId: sql`excluded.session_id`,
                  valueStr: sql`excluded.value_str`,
                  dataQuality: sql`excluded.data_quality`,
                }),
          },
        })
      : insert.onConflictDoNothing()
  ).returning({ systemId: pointReadingsAgg5m.systemId });
  return { written: res.length };
}

/** point_readings_agg_1d — always upsert (a day is recomputed as late readings land). */
async function upsert1d(
  rows: Agg1dUpsert[],
  exec?: ReadingsExec,
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };
  const addrs = await RegistryCache.addrsForPoints(rows.map((r) => r.point));
  const db = exec ?? requirePlanetscaleDb();
  // SEAM: composite-key value-building (Phase 8 → { pointRid }).
  const values = rows.map((r) => {
    const a = addrs.get(r.point)!;
    return {
      systemId: a.systemId,
      pointId: a.index,
      day: r.day,
      avg: r.avg,
      min: r.min,
      max: r.max,
      last: r.last,
      delta: r.delta,
      sampleCount: r.sampleCount,
      errorCount: r.errorCount,
    };
  });
  const res = await db
    .insert(pointReadingsAgg1d)
    .values(values)
    .onConflictDoUpdate({
      target: [
        pointReadingsAgg1d.systemId,
        pointReadingsAgg1d.pointId,
        pointReadingsAgg1d.day,
      ],
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
    .returning({ systemId: pointReadingsAgg1d.systemId });
  return { written: res.length };
}

// ── Maintenance / range ops (not point-scoped) ─────────────────────────────────────────────────────
// Hot-table access WITHOUT a PointId key: a global earliest-interval probe, a distinct-device
// enumeration, and a whole-day-range delete. They live in the seam (the ONLY hot-table importer) but
// sit outside the PointId-keyed read/write surface above. `systemIdsWithAgg5mSince` is an ADDITIONAL
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
 * Distinct device (system) ids with `agg_5m` rows at/after `sinceMs`.
 * // SEAM: reads `system_id` directly today; Phase 8 → DISTINCT device via a `point_rid` join. The
 * return shape (device ids == system ids == device_rids) is stable across the cutover.
 */
async function systemIdsWithAgg5mSince(
  sinceMs: number,
  exec?: ReadingsExec,
): Promise<number[]> {
  const db = exec ?? requirePlanetscaleDb();
  const rows = await db
    .selectDistinct({ systemId: pointReadingsAgg5m.systemId })
    .from(pointReadingsAgg5m)
    .where(gte(pointReadingsAgg5m.intervalEnd, new Date(sinceMs)));
  return rows.map((r) => r.systemId);
}

/**
 * Latest `agg_5m` `interval_end` (epoch-ms UTC) for ONE device (system), or null when it has no rows.
 * Seeds the OE scheduler's KV state (`loadState`).
 * // SEAM: filters `system_id` directly today; Phase 8 → a device_rid join. The return shape is stable
 * across the cutover (device ids == system ids == device_rids), like `systemIdsWithAgg5mSince`.
 */
async function latestAgg5mIntervalMsForSystem(
  systemId: number,
  exec?: ReadingsExec,
): Promise<number | null> {
  const db = exec ?? requirePlanetscaleDb();
  const [row] = await db
    .select({ intervalEnd: pointReadingsAgg5m.intervalEnd })
    .from(pointReadingsAgg5m)
    .where(eq(pointReadingsAgg5m.systemId, systemId))
    .orderBy(desc(pointReadingsAgg5m.intervalEnd))
    .limit(1);
  return row ? row.intervalEnd.getTime() : null;
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
 * Distinct raw-`point_readings` device (system) ids with `created_at >= sinceMs` (stats `systems_24h`).
 * // SEAM: reads `system_id` directly today; Phase 8 → DISTINCT device via a `point_rid` join. The
 * return count (device ids == system ids == device_rids) is stable across the cutover.
 */
async function distinctSystemsByRawCreatedAtSince(
  sinceMs: number,
  exec?: ReadingsExec,
): Promise<number> {
  const db = exec ?? requirePlanetscaleDb();
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${pointReadings.systemId})::int` })
    .from(pointReadings)
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

/**
 * Latest `agg_5m` `interval_end` (epoch-ms UTC) across a SET of devices (systems), or null when the set
 * is empty or has no rows (the battery-provenance blend-freshness probe — caller passes the helper-vendor
 * system ids). // SEAM: filters `system_id` directly today; Phase 8 → a device_rid `IN`. Stable shape.
 */
async function maxAgg5mIntervalMsForSystems(
  systemIds: number[],
  exec?: ReadingsExec,
): Promise<number | null> {
  if (systemIds.length === 0) return null;
  const db = exec ?? requirePlanetscaleDb();
  const [row] = await db
    .select({ intervalEnd: pointReadingsAgg5m.intervalEnd })
    .from(pointReadingsAgg5m)
    .where(inArray(pointReadingsAgg5m.systemId, systemIds))
    .orderBy(desc(pointReadingsAgg5m.intervalEnd))
    .limit(1);
  return row ? row.intervalEnd.getTime() : null;
}

/**
 * Delete every `agg_1d` row in the inclusive `[startDay, endDay]` range across ALL points/systems
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

export interface AdminPivotParams {
  systemId: number;
  source: string; // "raw" | "5m" | "daily"
  cursor: number | string | null;
  direction: string; // "older" | "newer"
  limit: number;
  /**
   * Caller-built `MAX(CASE …)` pivot projections (e.g. `MAX(CASE WHEN pr.system_id = 1 AND
   * pr.point_id = 0 THEN pr.value END) as point_0`). Names value columns, NOT a hot table, so the
   * boundary gate does not flag the caller. // SEAM: the caller addresses points by `pr.point_id =
   * <index>` here — Phase 8 re-keys that to `pr.point_rid = <rid>` in the caller alongside the
   * `system_id` filter below.
   */
  pivotColumns: string;
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
  const { systemId, source, cursor, direction, limit, pivotColumns } = p;
  const db = exec ?? requirePlanetscaleDb();
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
        INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
        WHERE pi.system_id = ${systemId}
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
      WHERE pr.system_id = ${systemId}
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
      INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
      WHERE pi.system_id = ${systemId}
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
    LEFT JOIN sessions s ON pr.session_id = s.id
    WHERE pr.system_id = ${systemId}
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
 * Does device (system) `systemId` have ANY rows in `store`? (`SELECT 1 … LIMIT 1`, index-friendly —
 * never `COUNT(*)`). The admin pivot's "is there data in the other store?" probe.
 * // SEAM: filters `system_id` directly (Phase 8 → device_rid).
 */
async function hasReadingsForSystem(
  systemId: number,
  store: ReadingStore,
  exec?: ReadingsExec,
): Promise<boolean> {
  const db = exec ?? requirePlanetscaleDb();
  const res = await db.execute(
    sql.raw(
      `SELECT 1 FROM ${STORE_TABLE[store]} WHERE system_id = ${systemId} LIMIT 1`,
    ),
  );
  return (((res as { rows?: unknown[] }).rows ?? []).length ?? 0) > 0;
}

/**
 * Does device (system) `systemId` have any `store` row strictly older / newer than `boundary`? (the
 * admin pivot's hasOlder / hasNewer pagination probes; `SELECT 1 … LIMIT 1`). `boundary` is a
 * YYYY-MM-DD string for `agg1d` (string compare) or epoch-ms for raw/5m (→ `to_timestamp`).
 * `direction`: "older" → `<`, "newer" → `>`. // SEAM: filters `system_id` directly (Phase 8 → device_rid).
 */
async function hasReadingsForSystemBeyond(
  systemId: number,
  store: ReadingStore,
  boundary: number | string,
  direction: "older" | "newer",
  exec?: ReadingsExec,
): Promise<boolean> {
  const db = exec ?? requirePlanetscaleDb();
  const op = direction === "older" ? "<" : ">";
  const rhs =
    store === "agg1d"
      ? `'${boundary}'`
      : `to_timestamp(${Number(boundary)} / 1000.0)`;
  const res = await db.execute(
    sql.raw(
      `SELECT 1 FROM ${STORE_TABLE[store]} WHERE system_id = ${systemId} AND ${STORE_TIME_COL[store]} ${op} ${rhs} LIMIT 1`,
    ),
  );
  return (((res as { rows?: unknown[] }).rows ?? []).length ?? 0) > 0;
}

/**
 * Raw readings in a ±1 hour window around `centerMs` for ONE point (admin single-point drill-down;
 * LEFT JOIN sessions for the label). Verbatim relocation of the former `fetchSinglePointReadingsPg`
 * raw branch. Returns rich rows keyed by the SQL aliases (id/systemId/pointId/…); `measurementTime`
 * and `receivedTime` are epoch-ms. // SEAM: composite-key WHERE (Phase 8 → point_rid).
 */
async function readRawWindowAround(
  point: PointId,
  centerMs: number,
  exec?: ReadingsExec,
): Promise<Row[]> {
  const db = exec ?? requirePlanetscaleDb();
  const { systemId, index } = await RegistryCache.addrForPoint(point);
  const oneHour = 60 * 60 * 1000;
  const startTime = centerMs - oneHour;
  const endTime = centerMs + oneHour;
  const res = await db.execute(
    sql.raw(`
    SELECT
      pr.id,
      pr.system_id as "systemId",
      pr.point_id as "pointId",
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
    WHERE pr.system_id = ${systemId}
      AND pr.point_id = ${index}
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
 * point (admin single-point drill-down; LEFT JOIN sessions). Verbatim relocation of the former
 * `fetchSinglePointReadingsPg` 5m branch. `intervalEnd` is epoch-ms. // SEAM: composite-key WHERE
 * (Phase 8 → point_rid).
 */
async function read5mRowWindowAround(
  point: PointId,
  centerMs: number,
  exec?: ReadingsExec,
): Promise<Row[]> {
  const db = exec ?? requirePlanetscaleDb();
  const { systemId, index } = await RegistryCache.addrForPoint(point);
  const res = await db.execute(
    sql.raw(`
      WITH all_rows AS (
        SELECT interval_end, ROW_NUMBER() OVER (ORDER BY interval_end ASC) as row_num
        FROM point_readings_agg_5m
        WHERE system_id = ${systemId} AND point_id = ${index}
      ),
      target_position AS (
        SELECT row_num as target_row FROM all_rows
        WHERE interval_end = ${tsLitUTC(centerMs)}
      ),
      ranked AS (
        SELECT
          pr.system_id as "systemId",
          pr.point_id as "pointId",
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
        WHERE pr.system_id = ${systemId} AND pr.point_id = ${index}
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

export const ReadingsDao = {
  readRaw,
  read5m,
  read1d,
  latestForPoints,
  latest5mForPoints,
  countAgg5mByLocalDay,
  countAgg5mForLocalDay,
  insertRaw,
  insert5m,
  upsert1d,
  earliestAgg5mMs,
  systemIdsWithAgg5mSince,
  latestAgg5mIntervalMsForSystem,
  countByCreatedAtSince,
  createdAtHistogramSince,
  distinctSystemsByRawCreatedAtSince,
  latestRawCreatedAtMs,
  maxAgg5mIntervalMsForSystems,
  delete1dRange,
  readAdminPivot,
  hasReadingsForSystem,
  hasReadingsForSystemBeyond,
  readRawWindowAround,
  read5mRowWindowAround,
  transaction,
};
