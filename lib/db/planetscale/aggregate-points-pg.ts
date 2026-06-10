/**
 * Postgres-side aggregation recompute (Move 1 / PR-11, behind `AGG_COMPUTE_IN_PG`).
 *
 * The end-state is Turso-free, so Postgres can't keep depending on Turso to compute and
 * ship the raw-vendor aggregates. This module rebuilds the 5m (and 1d) aggregates from
 * Postgres' OWN data:
 *
 *  - 5m: when raw readings land in PG (the queue receiver), recompute the affected
 *    `(systemId, intervalEnd)` aggregates from PG `point_readings`. Only raw-vendor points
 *    have raw in PG, so only they are touched; 5m-native vendors (Enphase/Amber) keep
 *    flowing their pre-computed 5m through the queue and are never recomputed here.
 *  - 1d: the daily cron recomputes each day's aggregate from PG `point_readings_agg_5m`
 *    (which by then holds both the recomputed raw-vendor 5m and the queue-fed 5m-native
 *    5m), instead of mirroring the Turso-computed 1d over the queue.
 *
 * The per-point math is shared with the Turso path via `lib/aggregation/point-aggregates.ts`
 * so the two engines compute identical values by construction — which is what
 * `scripts/reconcile-agg-values.ts` proves before the Turso publishers are trimmed (PR-13).
 *
 * SHADOW SAFETY: in PR-11 reads are still served from Turso, so nothing here is user-facing.
 * Every recompute is idempotent (`onConflictDoUpdate`, keyed by the business key) and the
 * live entry points are best-effort — a failure logs and is swallowed so it can never break
 * ingestion or the Turso aggregation it shadows.
 */

import { and, eq, gt, gte, lte, asc, sql } from "drizzle-orm";
import { CalendarDate } from "@internationalized/date";
import { planetscaleDb } from "./index";
import {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
  pointInfo,
} from "./schema";
import {
  aggregate5mForPoint,
  aggregate1dForPoint,
  intervalEndForMs,
  dayToUnixRangeForAggregation,
  FIVE_MIN_MS,
  type FiveMinRow,
} from "@/lib/aggregation/point-aggregates";
import type { Observation } from "@/lib/observations/types";

type PgDb = NonNullable<typeof planetscaleDb>;

/** A pool or a transaction handle — the inner recompute runs against either. */
type PgExecutor = PgDb | Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/**
 * Fixed namespace for the per-system 5m-recompute advisory lock (paired with the systemId as
 * the second key) so it can't collide with any other advisory-lock use. Value is arbitrary.
 */
const AGG5M_RECOMPUTE_LOCK_NS = 0x41475335; // ascii "AGS5"

/** Minimal system shape the 1d recompute needs (Turso `systems` row satisfies it). */
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
 * Mirrors `updatePointAggregates5m` (the Turso writer): for each interval, group the raw
 * readings by point, then compute via the shared helper — including its granularity (only
 * the reading's own interval is recomputed, never a neighbour).
 *
 * The transform='d' `previousLast` is read from the previous interval's raw (the last
 * non-null reading), which equals the previous interval's stored `last`. This matches Turso's
 * `getPointsLastValues5m` value AND works at the flag-flip boundary, where the previous
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
 * Inner recompute: read raw → group by point → upsert 5m for the given intervals, against a
 * transaction handle so the caller's advisory lock serializes it per system.
 */
async function recompute5mIntervalsWithin(
  db: PgExecutor,
  systemId: number,
  intervalEndsMs: number[],
): Promise<{ intervalsProcessed: number; rowsUpserted: number }> {
  // point_info metadata (transform / metric_type) for the system, from the PG mirror.
  const points = await db
    .select({
      index: pointInfo.index,
      transform: pointInfo.transform,
      metricType: pointInfo.metricType,
    })
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));

  const meta = new Map<
    number,
    { transform: string | null; metricType: string | null }
  >();
  for (const p of points) {
    meta.set(p.index, { transform: p.transform, metricType: p.metricType });
  }

  const intervals = [...new Set(intervalEndsMs)].sort((a, b) => a - b);
  let rowsUpserted = 0;
  // Points seen in raw but absent from the PG point_info mirror — skipped (see below).
  const skippedMissingMeta = new Set<number>();

  for (const intervalEndMs of intervals) {
    const intervalStartMs = intervalEndMs - FIVE_MIN_MS;
    const prevStartMs = intervalStartMs - FIVE_MIN_MS;

    // One scan over the previous interval (for transform='d' previousLast) plus the current
    // interval (the readings we aggregate): (prevStart, intervalEnd].
    const rows = await db
      .select({
        pointId: pointReadings.pointId,
        measurementTime: pointReadings.measurementTime,
        value: pointReadings.value,
      })
      .from(pointReadings)
      .where(
        and(
          eq(pointReadings.systemId, systemId),
          gt(pointReadings.measurementTime, new Date(prevStartMs)),
          lte(pointReadings.measurementTime, new Date(intervalEndMs)),
        ),
      )
      .orderBy(asc(pointReadings.pointId), asc(pointReadings.measurementTime));

    // Group by point, splitting the previous-interval slice (for previousLast) from the
    // current-interval slice (the values aggregated). Rows are time-ordered ascending.
    interface Group {
      prevLast: number | null;
      currValues: number[];
      currErrors: number;
      hasCurrent: boolean;
    }
    const groups = new Map<number, Group>();
    for (const r of rows) {
      const tMs = r.measurementTime.getTime();
      let g = groups.get(r.pointId);
      if (!g) {
        g = {
          prevLast: null,
          currValues: [],
          currErrors: 0,
          hasCurrent: false,
        };
        groups.set(r.pointId, g);
      }
      if (tMs <= intervalStartMs) {
        // Previous interval: track the last non-null value (ascending order → last wins).
        if (r.value !== null) g.prevLast = r.value;
      } else {
        // Current interval: collect valid values / count errors.
        g.hasCurrent = true;
        if (r.value === null) g.currErrors++;
        else g.currValues.push(r.value);
      }
    }

    const toUpsert: (typeof pointReadingsAgg5m.$inferInsert)[] = [];
    for (const [pointId, g] of groups) {
      // Only points with a reading in the CURRENT interval get a row (matches Turso, which
      // queries the current interval and creates a row per point present — incl. all-error).
      if (!g.hasCurrent) continue;
      // If the point isn't in the PG point_info mirror we can't know its transform/metricType
      // (Turso, where config is authoritative, always can). Defaulting to null/null would
      // silently mis-compute energy/'d' points, so SKIP it — leaving the row absent (the
      // reconciler treats only-in-Turso as non-failing) rather than writing a wrong value.
      // Normal, fully-mirrored systems skip nothing; this only guards a not-yet-mirrored
      // brand-new point.
      const m = meta.get(pointId);
      if (!m) {
        skippedMissingMeta.add(pointId);
        continue;
      }
      const result = aggregate5mForPoint({
        values: g.currValues,
        errorCount: g.currErrors,
        transform: m.transform,
        metricType: m.metricType,
        previousLast:
          m.transform === "d" && g.prevLast !== null ? g.prevLast : undefined,
      });
      toUpsert.push({
        systemId,
        pointId,
        intervalEnd: new Date(intervalEndMs),
        avg: result.avg,
        min: result.min,
        max: result.max,
        last: result.last,
        delta: result.delta,
        sampleCount: result.sampleCount,
        errorCount: result.errorCount,
      });
    }

    if (toUpsert.length > 0) {
      await db
        .insert(pointReadingsAgg5m)
        .values(toUpsert)
        .onConflictDoUpdate({
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
          },
        });
      rowsUpserted += toUpsert.length;
    }
  }

  if (skippedMissingMeta.size > 0) {
    console.warn(
      `[PG-Agg5m] system=${systemId}: skipped ${skippedMissingMeta.size} point(s) absent ` +
        `from the PG point_info mirror (${[...skippedMissingMeta].join(", ")}) — their 5m ` +
        `aggregates are left to land once point_info is mirrored.`,
    );
  }

  return { intervalsProcessed: intervals.length, rowsUpserted };
}

/**
 * Recompute a system/day's 1d aggregates from PG `point_readings_agg_5m`, upserting into
 * PG `point_readings_agg_1d`. Mirrors `aggregateDailyPointData` (the Turso writer): the
 * day spans 00:05..00:00-next-day, and `last` is taken from the previous day's 00:00
 * interval.
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

  const rows = await db
    .select({
      pointId: pointReadingsAgg5m.pointId,
      intervalEnd: pointReadingsAgg5m.intervalEnd,
      avg: pointReadingsAgg5m.avg,
      min: pointReadingsAgg5m.min,
      max: pointReadingsAgg5m.max,
      last: pointReadingsAgg5m.last,
      delta: pointReadingsAgg5m.delta,
      sampleCount: pointReadingsAgg5m.sampleCount,
      errorCount: pointReadingsAgg5m.errorCount,
    })
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, system.id),
        gte(pointReadingsAgg5m.intervalEnd, new Date(previousDayEndMs)),
        lte(pointReadingsAgg5m.intervalEnd, new Date(dayEndMs)),
      ),
    )
    .orderBy(asc(pointReadingsAgg5m.intervalEnd));

  if (rows.length === 0) return { rowsUpserted: 0 };

  // last value per point from the previous day's 00:00 interval.
  const lastValues = new Map<number, number | null>();
  const fiveMinByPoint = new Map<number, FiveMinRow[]>();
  for (const r of rows) {
    const tMs = r.intervalEnd.getTime();
    if (tMs === previousDayEndMs) {
      lastValues.set(r.pointId, r.last);
    }
    if (tMs >= dayStartMs && tMs <= dayEndMs) {
      let arr = fiveMinByPoint.get(r.pointId);
      if (!arr) {
        arr = [];
        fiveMinByPoint.set(r.pointId, arr);
      }
      arr.push(r);
    }
  }

  if (fiveMinByPoint.size === 0) return { rowsUpserted: 0 };

  const toUpsert: (typeof pointReadingsAgg1d.$inferInsert)[] = [];
  for (const [pointId, recs] of fiveMinByPoint) {
    const result = aggregate1dForPoint({
      rows: recs,
      last: lastValues.get(pointId) ?? null,
    });
    toUpsert.push({
      systemId: system.id,
      pointId,
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

  await db
    .insert(pointReadingsAgg1d)
    .values(toUpsert)
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
    });

  return { rowsUpserted: toUpsert.length };
}

// ============================================================================
// Best-effort entry points for the live pipeline
//
// These grab the memoized PG client, no-op if PG isn't configured, and never throw — an
// aggregation hiccup must not break ingestion (5m) or the Turso daily cron (1d) that this
// shadows. Callers should still `await` them so the work completes before a serverless
// function can freeze.
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
