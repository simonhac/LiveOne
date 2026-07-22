/**
 * Postgres-side aggregation recompute.
 *
 * Postgres is the sole aggregator, rebuilding the 5m (and 1d) aggregates from its OWN data:
 *
 *  - 5m: when raw readings land in PG (the queue receiver), recompute the affected
 *    `(systemId, intervalEnd)` aggregates from PG `point_readings`. Only raw-vendor points
 *    have raw in PG, so only they are touched; 5m-native vendors (Enphase/Amber) keep
 *    flowing their pre-computed 5m through the queue and are never recomputed here.
 *  - 1d: the daily cron recomputes each day's aggregate from PG `point_readings_agg_5m`
 *    (which by then holds both the recomputed raw-vendor 5m and the queue-fed 5m-native
 *    5m).
 *
 * The per-point math is shared via `lib/aggregation/point-aggregates.ts`.
 *
 * All hot-table access goes through the config-v4 readings seam (`ReadingsDao`, uuids in / rids
 * internal): raw + 5m + 1d are read/written by `PointId`, never by the composite `(system_id,
 * point_id)` address. `point_info` (metadata + the uuid↔index map) is not a hot table and is read
 * directly. Every recompute is idempotent (`onConflictDoUpdate`, keyed by the business key) and the
 * live entry points are best-effort — a failure logs and is swallowed so it can never break
 * ingestion.
 */

import { eq, sql } from "drizzle-orm";
import { CalendarDate } from "@internationalized/date";
import { planetscaleDb } from "./index";
import { pointInfo } from "./schema";
import {
  aggregate5mForPoint,
  aggregate1dForPoint,
  intervalEndForMs,
  dayToUnixRangeForAggregation,
  FIVE_MIN_MS,
  type FiveMinRow,
} from "@/lib/aggregation/point-aggregates";
import {
  ReadingsDao,
  type RawReading,
  type Agg5mReading,
  type Agg5mInsert,
  type Agg1dUpsert,
  type SeriesByPoint,
} from "@/lib/readings";
import { UnknownIdError } from "@/lib/registry";
import { Point, type PointId } from "@/lib/ids";
import type { Observation } from "@/lib/observations/types";

type PgDb = NonNullable<typeof planetscaleDb>;

/** A pool or a transaction handle — the inner recompute runs against either. */
type PgExecutor = PgDb | Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/**
 * Fixed namespace for the per-system 5m-recompute advisory lock (paired with the systemId as
 * the second key) so it can't collide with any other advisory-lock use. Value is arbitrary.
 */
const AGG5M_RECOMPUTE_LOCK_NS = 0x41475335; // ascii "AGS5"

/** Minimal system shape the 1d recompute needs (a `systems` row satisfies it). */
interface SystemForDailyAgg {
  id: number;
  timezoneOffsetMin: number;
}

/**
 * The distinct 5m interval-ends (ms) that a set of raw observations touch. A reading's
 * interval is `(end−5min, end]`. Sorted ascending so, within one recompute pass, an
 * earlier interval is rebuilt before a later one that may differentiate against it.
 */
export function affectedIntervalEndsMs(observations: Observation[]): number[] {
  const set = new Set<number>();
  for (const obs of observations) {
    const ms = Date.parse(obs.measurementTime);
    if (!Number.isNaN(ms)) set.add(intervalEndForMs(ms));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Expand a set of interval-ends to also include each one's immediate successor (end + 5min),
 * deduped + ascending.
 *
 * A transform='d' interval's delta is computed against the PREVIOUS interval's last reading,
 * so when raw for interval N lands we must also rebuild N+1. Recomputing the successor is what
 * makes the 5m recompute **independent of queue delivery order**: out-of-order or parallel
 * delivery still converges, because whichever of {N's message, N-1's message} recomputes N last
 * sees N-1's raw already committed. A successor with no readings yet is skipped by
 * `recomputeAgg5mForIntervals` (the `hasCurrent` guard), so this never creates future rows.
 */
export function withSuccessorIntervals(intervalEndsMs: number[]): number[] {
  const set = new Set<number>();
  for (const e of intervalEndsMs) {
    set.add(e);
    set.add(e + FIVE_MIN_MS);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Recompute the raw-vendor 5m aggregates for the given `(systemId, intervalEnd)` pairs
 * from PG `point_readings`, upserting into PG `point_readings_agg_5m`.
 *
 * Mirrors the legacy `updatePointAggregates5m` writer: for each interval, group the raw
 * readings by point, then compute via the shared helper — including its granularity (only
 * the reading's own interval is recomputed, never a neighbour).
 *
 * The transform='d' `previousLast` is read from the previous interval's raw (the last
 * non-null reading), which equals the previous interval's stored `last`. This matches the
 * legacy `getPointsLastValues5m` value AND works at the flag-flip boundary, where the previous
 * AGGREGATE row may not exist yet but the raw does.
 *
 * ORDER-INDEPENDENT (parallelism > 1 safe): callers pass each touched interval together with
 * its immediate successor (`withSuccessorIntervals`), and the recompute runs inside one
 * transaction guarded by a per-system advisory lock, with the raw already committed by the
 * receiver. So out-of-order / parallel delivery still converges to the correct value — when
 * interval N's raw lands we also rebuild N+1 (whose delta depends on N), and the advisory lock
 * makes the last writer for any interval observe all committed raw (different systems never
 * contend). The value reconciler is still run over a settled window as a backstop.
 */
export async function recomputeAgg5mForIntervals(
  db: PgDb,
  systemId: number,
  intervalEndsMs: number[],
): Promise<{ intervalsProcessed: number; rowsUpserted: number }> {
  if (intervalEndsMs.length === 0) {
    return { intervalsProcessed: 0, rowsUpserted: 0 };
  }
  // Serialize recomputes for THIS system: one transaction holding a per-system advisory lock,
  // so concurrent queue messages can't interleave a read-then-write on a shared interval and
  // lose an update. Transaction-scoped lock → released at commit, safe under the pooler.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${AGG5M_RECOMPUTE_LOCK_NS}::int4, ${systemId}::int4)`,
    );
    return recompute5mIntervalsWithin(tx, systemId, intervalEndsMs);
  });
}

/**
 * Inner recompute: read raw via the DAO → group by point → upsert 5m for the given intervals,
 * against a transaction handle so the caller's advisory lock serializes it per system.
 *
 * The point set is driven from `point_info` (so every point resolves to a `PointId`); the DAO reads
 * raw by that list. A point present in raw but absent from `point_info` is impossible (the composite
 * FK forbids it), and the raw→5m recompute only ever writes value-only aggregates (vendor-meta
 * columns are preserved by `preserveVendorMeta`).
 */
async function recompute5mIntervalsWithin(
  db: PgExecutor,
  systemId: number,
  intervalEndsMs: number[],
): Promise<{ intervalsProcessed: number; rowsUpserted: number }> {
  // point_info metadata (transform / metric_type) + identity (point_uid → PointId) for the system.
  const points = await db
    .select({
      pointUid: pointInfo.pointUid,
      transform: pointInfo.transform,
      metricType: pointInfo.metricType,
    })
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));

  const pointIds: PointId[] = [];
  const metaById = new Map<
    PointId,
    { transform: string | null; metricType: string | null }
  >();
  for (const p of points) {
    // point_uid is NOT NULL + a valid uuid, so encode can't fail — but never let one bad row abort
    // the whole recompute.
    let id: PointId;
    try {
      id = Point.encode(p.pointUid);
    } catch {
      continue;
    }
    pointIds.push(id);
    metaById.set(id, { transform: p.transform, metricType: p.metricType });
  }

  const intervals = [...new Set(intervalEndsMs)].sort((a, b) => a - b);
  let rowsUpserted = 0;

  for (const intervalEndMs of intervals) {
    const intervalStartMs = intervalEndMs - FIVE_MIN_MS;
    const prevStartMs = intervalStartMs - FIVE_MIN_MS;

    try {
      // One read over the previous interval (for transform='d' previousLast) plus the current
      // interval (the readings we aggregate). readRaw is inclusive-inclusive, so we read from
      // prevStartMs and drop `tMs === prevStartMs` in the classifier to reproduce the legacy
      // half-open `(prevStart, intervalEnd]` (byte-identical for ms-granular measurement_time).
      const byPoint = await ReadingsDao.readRaw(
        pointIds,
        { fromMs: prevStartMs, toMs: intervalEndMs },
        db,
      );

      const toUpsert: Agg5mInsert[] = [];
      for (const pointId of pointIds) {
        const rows: RawReading[] = byPoint.get(pointId)!; // pre-seeded to []
        // Split the previous-interval slice (for previousLast) from the current-interval slice
        // (the values aggregated). Rows are time-ordered ascending.
        let prevLast: number | null = null;
        const currValues: number[] = [];
        let currErrors = 0;
        let hasCurrent = false;
        for (const r of rows) {
          const tMs = r.measurementTimeMs;
          if (tMs <= prevStartMs) continue; // legacy gt(prevStart) lower bound
          if (tMs <= intervalStartMs) {
            // Previous interval: track the last non-null value (ascending order → last wins).
            if (r.value !== null) prevLast = r.value;
          } else {
            // Current interval: collect valid values / count errors.
            hasCurrent = true;
            if (r.value === null) currErrors++;
            else currValues.push(r.value);
          }
        }
        // Only points with a reading in the CURRENT interval get a row (matches the legacy writer).
        if (!hasCurrent) continue;
        const m = metaById.get(pointId);
        if (!m) continue; // defensive — pointIds derive from point_info, so this can't happen
        const result = aggregate5mForPoint({
          values: currValues,
          errorCount: currErrors,
          transform: m.transform,
          metricType: m.metricType,
          previousLast:
            m.transform === "d" && prevLast !== null ? prevLast : undefined,
        });
        toUpsert.push({
          point: pointId,
          intervalEndMs,
          avg: result.avg,
          min: result.min,
          max: result.max,
          last: result.last,
          delta: result.delta,
          valueStr: null,
          sampleCount: result.sampleCount,
          errorCount: result.errorCount,
          dataQuality: null,
          sessionId: null,
        });
      }

      if (toUpsert.length > 0) {
        // preserveVendorMeta: the recompute owns the value columns but must not clobber
        // session_id/value_str/data_quality a 5m-native queue write may have set on this interval.
        const { written } = await ReadingsDao.insert5m(
          toUpsert,
          { upsert: true, preserveVendorMeta: true },
          db,
        );
        rowsUpserted += written;
      }
    } catch (err) {
      // A point vanishing mid-run (rare TOCTOU) surfaces as UnknownIdError from the DAO's identity
      // resolution; skip this interval rather than aborting the whole recompute.
      if (err instanceof UnknownIdError) {
        console.warn(
          `[PG-Agg5m] system=${systemId} intervalEnd=${intervalEndMs}: skipped — ${err.message}`,
        );
        continue;
      }
      throw err;
    }
  }

  return { intervalsProcessed: intervals.length, rowsUpserted };
}

/**
 * Recompute a system/day's 1d aggregates from PG 5m (via the DAO), upserting into 1d. Mirrors the
 * legacy `aggregateDailyPointData` writer: the day spans 00:05..00:00-next-day, and `last` is taken
 * from the previous day's 00:00 interval.
 */
export async function recomputeAgg1dForDay(
  db: PgDb,
  system: SystemForDailyAgg,
  day: CalendarDate,
): Promise<{ rowsUpserted: number }> {
  const [dayStartUnix, dayEndUnix] = dayToUnixRangeForAggregation(
    day,
    system.timezoneOffsetMin,
  );
  const dayStartMs = dayStartUnix * 1000;
  const dayEndMs = dayEndUnix * 1000;
  // 00:00 interval (5 minutes before day start) — used for the daily `last`.
  const previousDayEndMs = dayStartMs - FIVE_MIN_MS;
  const dayStr = day.toString();

  // Enumerate the system's points as PointIds — the DAO reads 5m by PointId. (This path didn't read
  // point_info before; 5m FKs to point_info so the point set is identical to the old broad scan.)
  const points = await db
    .select({ pointUid: pointInfo.pointUid })
    .from(pointInfo)
    .where(eq(pointInfo.systemId, system.id));
  const pointIds: PointId[] = [];
  for (const p of points) {
    try {
      pointIds.push(Point.encode(p.pointUid));
    } catch {
      // unreachable with point_uid NOT NULL; never abort the day for one bad row.
    }
  }
  if (pointIds.length === 0) return { rowsUpserted: 0 };

  let byPoint: SeriesByPoint<Agg5mReading>;
  try {
    byPoint = await ReadingsDao.read5m(
      pointIds,
      { fromMs: previousDayEndMs, toMs: dayEndMs },
      db,
    );
  } catch (err) {
    if (err instanceof UnknownIdError) {
      console.warn(
        `[PG-Agg1d] system=${system.id} day=${dayStr}: skipped — ${err.message}`,
      );
      return { rowsUpserted: 0 };
    }
    throw err;
  }

  const toUpsert: Agg1dUpsert[] = [];
  for (const pointId of pointIds) {
    const rows = byPoint.get(pointId)!; // pre-seeded to []
    // last value from the previous day's 00:00 interval; the day's 5m rows [00:05..00:00-next-day].
    let last: number | null = null;
    const inDay: FiveMinRow[] = [];
    for (const r of rows) {
      const tMs = r.intervalEndMs;
      if (tMs === previousDayEndMs) last = r.last;
      if (tMs >= dayStartMs && tMs <= dayEndMs) {
        inDay.push({
          avg: r.avg,
          min: r.min,
          max: r.max,
          delta: r.delta,
          sampleCount: r.sampleCount,
          errorCount: r.errorCount,
        });
      }
    }
    // Only points with ≥1 in-day 5m row produce a 1d row (matches the legacy fiveMinByPoint gate).
    if (inDay.length === 0) continue;
    const result = aggregate1dForPoint({ rows: inDay, last });
    toUpsert.push({
      point: pointId,
      day: dayStr,
      avg: result.avg,
      min: result.min,
      max: result.max,
      last: result.last,
      delta: result.delta,
      sampleCount: result.sampleCount,
      errorCount: result.errorCount,
    });
  }

  if (toUpsert.length === 0) return { rowsUpserted: 0 };
  const { written } = await ReadingsDao.upsert1d(toUpsert, db);
  return { rowsUpserted: written };
}

// ============================================================================
// Best-effort entry points for the live pipeline
//
// These grab the memoized PG client, no-op if PG isn't configured, and never throw — an
// aggregation hiccup must not break ingestion (5m) or the daily cron (1d). Callers should
// still `await` them so the work completes before a serverless function can freeze.
// ============================================================================

/**
 * 5m receiver hook: recompute the aggregates for the intervals touched by a message's raw
 * observations. Best-effort. No-op if PG isn't configured or there are no raw observations.
 */
export async function recompute5mForRawObservationsBestEffort(
  systemId: number,
  rawObservations: Observation[],
): Promise<void> {
  if (!planetscaleDb) return;
  if (rawObservations.length === 0) return;
  try {
    // Rebuild each touched interval AND its immediate successor: a transform='d' interval's
    // delta depends on the previous interval's last reading, so when raw for N lands, N+1 must
    // be rebuilt too. This (plus the per-system advisory lock in recomputeAgg5mForIntervals) is
    // what makes the recompute independent of queue delivery order — so parallelism > 1 is safe.
    const intervals = withSuccessorIntervals(
      affectedIntervalEndsMs(rawObservations),
    );
    const { intervalsProcessed, rowsUpserted } =
      await recomputeAgg5mForIntervals(planetscaleDb, systemId, intervals);
    console.log(
      `[PG-Agg5m] system=${systemId} intervals=${intervalsProcessed} upserted=${rowsUpserted}`,
    );
  } catch (err) {
    console.error(`[PG-Agg5m] recompute failed for system=${systemId}:`, err);
  }
}

/**
 * 1d cron hook: recompute a system/day's 1d aggregates in PG from PG 5m. Best-effort.
 * No-op if PG isn't configured.
 */
export async function recompute1dForDayBestEffort(
  system: SystemForDailyAgg,
  day: CalendarDate,
): Promise<void> {
  if (!planetscaleDb) return;
  try {
    const { rowsUpserted } = await recomputeAgg1dForDay(
      planetscaleDb,
      system,
      day,
    );
    console.log(
      `[PG-Agg1d] system=${system.id} day=${day.toString()} upserted=${rowsUpserted}`,
    );
  } catch (err) {
    console.error(
      `[PG-Agg1d] recompute failed for system=${system.id} day=${day.toString()}:`,
      err,
    );
  }
}
