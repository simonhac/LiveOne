/**
 * Postgres side of the `/api/history` readings shadow (PR-12).
 *
 * `fetchAggRowsPg` mirrors the Turso raw-SQL fetch in `app/api/history/route.ts`, returning the
 * SAME uniform `AggRow[]` so it can feed the shared `buildSeriesFromAggRows`. The 5m/30m dense
 * timeline that the Turso `WITH RECURSIVE` CTE generates is reproduced here in JS (identical grid
 * math) rather than via PG `generate_series`, so the grid is identical by construction and never
 * drifts on timestamp/timezone boundary semantics.
 *
 * `compareHistorySeries` is the shadow comparator for the served OpenNEM payload.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  pointReadingsAgg5m as pgAgg5m,
  pointReadingsAgg1d as pgAgg1d,
} from "@/lib/db/planetscale/schema";
import { FIVE_MIN_MS } from "@/lib/aggregation/point-aggregates";
import { OpenNEMDataSeries } from "@/types/opennem";
import {
  SHADOW_SKIP,
  pairMatches,
  type ReadingsCompareResult,
} from "@/lib/db/readings-shadow";
import type { AggRow } from "./build-series";

export interface AggFetchParams {
  /** Distinct `[systemId, pointId]` pairs to fetch (same set the Turso CTE joins against). */
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
 * Fetch the uniform `AggRow[]` from Postgres for `/api/history`. Returns `SHADOW_SKIP` when PG is
 * unconfigured. Best-effort: callers run it under the shadow harness and swallow errors.
 */
export async function fetchAggRowsPg(
  p: AggFetchParams,
): Promise<AggRow[] | typeof SHADOW_SKIP> {
  if (!planetscaleDb) return SHADOW_SKIP;
  const db = planetscaleDb;
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
        );
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

  // 5m / 30m: query the sparse PG rows, then densify to the exact grid the Turso CTE emits.
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

    // Densify: emit the same dense grid as the Turso `WITH RECURSIVE timeline` CTE — seed at
    // queryFirstEpoch, step 5min, and include the first grid point that reaches/passes lastEpoch
    // (the CTE generates R+5min for every R < lastEpoch, so the largest emitted value is the first
    // grid point ≥ lastEpoch). Rows ascending per point, matching the CTE's ORDER BY.
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

/**
 * Compare the served OpenNEM series from Turso vs Postgres. Series are matched by `id`; their
 * `history.data` arrays are index-aligned (both grids are identical) and compared element-wise with
 * `pairMatches` — so a value present on one side but null on the other (live-tail lag, or PG agg_1d
 * having no data_quality → null `.quality`) is never a divergence; only two present values that
 * differ count. Reports up to the first 10 diverging cells.
 */
export function compareHistorySeries(
  turso: OpenNEMDataSeries[],
  pg: OpenNEMDataSeries[],
): ReadingsCompareResult {
  const tById = new Map(turso.map((s) => [s.id, s]));
  const pById = new Map(pg.map((s) => [s.id, s]));
  const diffs: string[] = [];

  for (const id of new Set([...tById.keys(), ...pById.keys()])) {
    const t = tById.get(id);
    const p = pById.get(id);
    if (!t || !p) {
      diffs.push(`${id}: present only in ${t ? "turso" : "pg"}`);
      continue;
    }
    const td = t.history.data;
    const pd = p.history.data;
    if (td.length !== pd.length) {
      diffs.push(`${id}: numIntervals turso=${td.length} pg=${pd.length}`);
    }
    const n = Math.min(td.length, pd.length);
    for (let i = 0; i < n; i++) {
      if (!pairMatches(td[i], pd[i])) {
        diffs.push(`${id}[${i}]: turso=${td[i]} pg=${pd[i]}`);
      }
    }
  }

  if (diffs.length === 0) return { matched: true };
  return {
    matched: false,
    detail: `series=${turso.length}/${pg.length} ${diffs.slice(0, 10).join("; ")}`,
  };
}
