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

/** Wrap several writes in ONE transaction (the receiver: session-first, then raw + 5m). */
function transaction<T>(fn: (tx: ReadingsExec) => Promise<T>): Promise<T> {
  return requirePlanetscaleDb().transaction(fn as (tx: PgTx) => Promise<T>);
}

export const ReadingsDao = {
  readRaw,
  read5m,
  read1d,
  latestForPoints,
  insertRaw,
  insert5m,
  upsert1d,
  earliestAgg5mMs,
  systemIdsWithAgg5mSince,
  delete1dRange,
  transaction,
};
