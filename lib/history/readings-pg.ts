/**
 * Postgres side of the `/api/history` readings fetch.
 *
 * `fetchAggRowsPg` returns a uniform `AggRow[]` so it can feed the shared
 * `buildSeriesFromAggRows`. The 5m/30m dense timeline is reproduced here in JS (identical grid
 * math) rather than via PG `generate_series`, so the grid is identical by construction and never
 * drifts on timestamp/timezone boundary semantics.
 *
 * Reads flow through the config-v4 readings seam (`ReadingsDao`): the `(systemId, pointId)`
 * composite address the caller supplies is resolved to a public `PointId` via `RegistryCache`, the
 * DAO reads by `PointId`, and results are mapped back to the composite address for the served rows.
 * The transform (densify, `avgCache` reconstruction, `data_quality` mapping) stays byte-identical to
 * the pre-seam direct-`agg` read.
 */
import { FIVE_MIN_MS } from "@/lib/aggregation/point-aggregates";
import { ReadingsDao, type Agg5mReading } from "@/lib/readings";
import { RegistryCache, UnknownIdError } from "@/lib/registry";
import type { PointId } from "@/lib/ids";
import type { AggRow } from "./build-series";
import type { Agg5mAvgCache, Agg5mAvgRow } from "./agg5m-cache";

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
 * Resolve every `[systemId, pointId]` composite address to its public `PointId`, concurrently.
 * `RegistryCache.pointForAddr` is a warm-cache synchronous hit in a live serving process; a cold
 * miss is a single indexed `point_info` lookup that also warms the address the DAO resolves below.
 * An address with no registry identity is skipped (`UnknownIdError`) rather than aborting the whole
 * fetch — the pre-seam read queried the `agg` tables directly and had no such identity dependency.
 */
async function resolvePairs(pairs: Array<[number, number]>): Promise<{
  /** `"systemId.pointId"` → PointId, for the resolved subset. */
  pairToPoint: Map<string, PointId>;
  /** PointId → integer `pointId` (the reverse used to rebuild the served rows). */
  pointToInt: Map<PointId, number>;
}> {
  const pairToPoint = new Map<string, PointId>();
  const pointToInt = new Map<PointId, number>();
  await Promise.all(
    pairs.map(async ([systemId, pointId]) => {
      try {
        const id = await RegistryCache.pointForAddr(systemId, pointId);
        pairToPoint.set(`${systemId}.${pointId}`, id);
        pointToInt.set(id, pointId);
      } catch (err) {
        if (err instanceof UnknownIdError) return; // skip-and-continue
        throw err;
      }
    }),
  );
  return { pairToPoint, pointToInt };
}

/**
 * Fetch the uniform `AggRow[]` from Postgres for `/api/history`.
 */
export async function fetchAggRowsPg(
  p: AggFetchParams,
  /** When set (the `/api/history` sankey path), record the raw sparse `avg` rows read here so the attr
   *  span's flow-series read can reuse them instead of re-querying `agg_5m` (§1.3a). 5m/30m only. */
  avgCache?: Agg5mAvgCache,
): Promise<AggRow[]> {
  const idsBySystem = groupPointIdsBySystem(p.uniquePairs);
  const { pairToPoint, pointToInt } = await resolvePairs(p.uniquePairs);

  // The resolved PointIds for a system's requested indices, preserving the caller's order (skipping
  // any unresolved address).
  const pointsFor = (systemId: number, ids: number[]): PointId[] =>
    ids
      .map((i) => pairToPoint.get(`${systemId}.${i}`))
      .filter((x): x is PointId => x !== undefined);

  if (p.interval === "1d") {
    // One DAO read per system, run CONCURRENTLY (independent systems don't need to serialize on the
    // pool) — `Promise.all` preserves `idsBySystem`'s insertion order in the result array regardless
    // of completion order. Cross-point/cross-system row order is irrelevant downstream: the shared 1d
    // transform re-densifies each series from a Map keyed by day, and the DAO already returns each
    // point's days ascending.
    const perSystem = await Promise.all(
      Array.from(idsBySystem, async ([systemId, ids]) => {
        const pointIds = pointsFor(systemId, ids);
        const byPoint = await ReadingsDao.read1d(pointIds, {
          startDay: p.startDate!,
          endDay: p.endDate!,
        });
        const rows: AggRow[] = [];
        for (const pointId of pointIds) {
          const intId = pointToInt.get(pointId)!;
          for (const r of byPoint.get(pointId)!) {
            rows.push({
              system_id: systemId,
              point_id: intId,
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
      }),
    );
    return perSystem.flat();
  }

  // 5m / 30m: read the sparse rows, then densify to the exact grid. One DAO read per system, run
  // CONCURRENTLY (see the 1d path's note above — same guarantee applies here).
  const queryFirstEpoch = p.queryFirstEpoch!;
  const lastEpoch = p.lastEpoch!;

  const perSystem = await Promise.all(
    Array.from(idsBySystem, async ([systemId, ids]) => {
      const pointIds = pointsFor(systemId, ids);
      const byPoint = await ReadingsDao.read5m(pointIds, {
        fromMs: queryFirstEpoch,
        toMs: lastEpoch,
      });

      // §1.3a: reconstruct the PRE-densify sparse rows the avgCache expects (`{pointId, intervalEnd:
      // Date, avg}`), byte-identical to the former raw select. Populated per system over the same
      // [queryFirstEpoch, lastEpoch] window; densify below is unaffected.
      if (avgCache) {
        const resolvedInts: number[] = [];
        const res: Agg5mAvgRow[] = [];
        for (const pointId of pointIds) {
          const intId = pointToInt.get(pointId)!;
          resolvedInts.push(intId);
          for (const r of byPoint.get(pointId)!) {
            res.push({
              pointId: intId,
              intervalEnd: new Date(r.intervalEndMs),
              avg: r.avg,
            });
          }
        }
        avgCache.record(
          systemId,
          resolvedInts,
          queryFirstEpoch,
          lastEpoch,
          res,
        );
      }

      // Densify: emit a dense grid — seed at queryFirstEpoch, step 5min, and include the first grid
      // point that reaches/passes lastEpoch (R+5min for every R < lastEpoch, so the largest emitted
      // value is the first grid point ≥ lastEpoch). Rows ascending per point.
      const systemRows: AggRow[] = [];
      for (const pointId of pointIds) {
        const intId = pointToInt.get(pointId)!;
        const byMs = new Map<number, Agg5mReading>();
        for (const r of byPoint.get(pointId)!) byMs.set(r.intervalEndMs, r);
        for (let t = queryFirstEpoch; ; t += FIVE_MIN_MS) {
          const hit = byMs.get(t);
          systemRows.push({
            system_id: systemId,
            point_id: intId,
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
      return systemRows;
    }),
  );
  return perSystem.flat();
}
