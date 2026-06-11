/**
 * Postgres side of the `/api/history` readings fetch.
 *
 * `fetchAggRowsPg` returns a uniform `AggRow[]` so it can feed the shared
 * `buildSeriesFromAggRows`. The 5m/30m dense timeline is reproduced here in JS (identical grid
 * math) rather than via PG `generate_series`, so the grid is identical by construction and never
 * drifts on timestamp/timezone boundary semantics.
 *
 * `compareHistorySeries` is a comparator for the served OpenNEM payload.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  pointReadingsAgg5m as pgAgg5m,
  pointReadingsAgg1d as pgAgg1d,
} from "@/lib/db/planetscale/schema";
import { FIVE_MIN_MS } from "@/lib/aggregation/point-aggregates";
import type { AggRow } from "./build-series";

export interface AggFetchParams {
  /** Distinct `[systemId, pointId]` pairs to fetch. */
  uniquePairs: Array<[number, number]>;
  interval: "5m" | "30m" | "1d";
  /** 5m/30m only: dense-timeline bounds in epoch-ms (queryFirstEpoch = firstEpoch − 25m for 30m). */
  queryFirstEpoch?: number;
  lastEpoch?: number;
  /** 1d only: inclusive day range, YYYY-MM-DD. */
  startDate?: string;
  endDate?: string;
}

function groupPointIdsBySystem(
  pairs: Array<[number, number]>,
): Map<number, number[]> {
  const bySystem = new Map<number, number[]>();
  for (const [systemId, pointId] of pairs) {
    let arr = bySystem.get(systemId);
    if (!arr) {
      arr = [];
      bySystem.set(systemId, arr);
    }
    arr.push(pointId);
  }
  return bySystem;
}

/**
 * Fetch the uniform `AggRow[]` from Postgres for `/api/history`.
 */
export async function fetchAggRowsPg(p: AggFetchParams): Promise<AggRow[]> {
  const db = requirePlanetscaleDb();
  const idsBySystem = groupPointIdsBySystem(p.uniquePairs);

  if (p.interval === "1d") {
    const rows: AggRow[] = [];
    for (const [systemId, ids] of idsBySystem) {
      const res = await db
        .select({
          systemId: pgAgg1d.systemId,
          pointId: pgAgg1d.pointId,
          day: pgAgg1d.day,
          avg: pgAgg1d.avg,
          min: pgAgg1d.min,
          max: pgAgg1d.max,
          last: pgAgg1d.last,
          delta: pgAgg1d.delta,
        })
        .from(pgAgg1d)
        .where(
          and(
            eq(pgAgg1d.systemId, systemId),
            inArray(pgAgg1d.pointId, ids),
            gte(pgAgg1d.day, p.startDate!),
            lte(pgAgg1d.day, p.endDate!),
          ),
        )
        // Order by `system_id, point_id, day`. The shared 1d transform
        // (buildSeriesFromAggRows) maps rows in arrival order without re-sorting, so an unordered
        // PG scan (e.g. a recomputed/upserted day returned out of heap position) would shift the
        // served day series by one. Ordering here keeps the output deterministic.
        .orderBy(pgAgg1d.systemId, pgAgg1d.pointId, pgAgg1d.day);
      for (const r of res) {
        rows.push({
          system_id: r.systemId,
          point_id: r.pointId,
          day: r.day,
          avg: r.avg,
          min: r.min,
          max: r.max,
          last: r.last,
          delta: r.delta,
          data_quality: null, // PG point_readings_agg_1d has no data_quality column
        });
      }
    }
    return rows;
  }

  // 5m / 30m: query the sparse PG rows, then densify to the exact grid.
  const queryFirstEpoch = p.queryFirstEpoch!;
  const lastEpoch = p.lastEpoch!;
  const rows: AggRow[] = [];

  for (const [systemId, ids] of idsBySystem) {
    const res = await db
      .select({
        pointId: pgAgg5m.pointId,
        intervalEnd: pgAgg5m.intervalEnd,
        avg: pgAgg5m.avg,
        min: pgAgg5m.min,
        max: pgAgg5m.max,
        last: pgAgg5m.last,
        delta: pgAgg5m.delta,
        dataQuality: pgAgg5m.dataQuality,
      })
      .from(pgAgg5m)
      .where(
        and(
          eq(pgAgg5m.systemId, systemId),
          inArray(pgAgg5m.pointId, ids),
          gte(pgAgg5m.intervalEnd, new Date(queryFirstEpoch)),
          lte(pgAgg5m.intervalEnd, new Date(lastEpoch)),
        ),
      );

    const byKey = new Map<string, (typeof res)[number]>();
    for (const r of res)
      byKey.set(`${r.pointId}:${r.intervalEnd.getTime()}`, r);

    // Densify: emit a dense grid — seed at
    // queryFirstEpoch, step 5min, and include the first grid point that reaches/passes lastEpoch
    // (R+5min for every R < lastEpoch, so the largest emitted value is the first
    // grid point ≥ lastEpoch). Rows ascending per point.
    for (const pointId of ids) {
      for (let t = queryFirstEpoch; ; t += FIVE_MIN_MS) {
        const hit = byKey.get(`${pointId}:${t}`);
        rows.push({
          system_id: systemId,
          point_id: pointId,
          interval_end: t,
          avg: hit?.avg ?? null,
          min: hit?.min ?? null,
          max: hit?.max ?? null,
          last: hit?.last ?? null,
          delta: hit?.delta ?? null,
          data_quality: hit?.dataQuality ?? null,
        });
        if (t >= lastEpoch) break;
      }
    }
  }
  return rows;
}
