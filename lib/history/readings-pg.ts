/**
 * Postgres side of the `/api/history` readings fetch.
 *
 * `fetchAggRowsPg` returns a uniform `AggRow[]` so it can feed the shared
 * `buildSeriesFromAggRows`. The 5m/30m dense timeline is reproduced here in JS (identical grid
 * math) rather than via PG `generate_series`, so the grid is identical by construction and never
 * drifts on timestamp/timezone boundary semantics.
 *
 * Reads flow through the config-v4 readings seam (`ReadingsDao`): the caller supplies each point's
 * `PointId` alongside its `(systemId, pointId)` composite address, the DAO reads by `PointId`, and
 * results are mapped back to the composite address for the served rows.
 * The transform (densify, `avgCache` reconstruction, `data_quality` mapping) stays byte-identical to
 * the pre-seam direct-`agg` read.
 */
import { FIVE_MIN_MS } from "@/lib/aggregation/point-aggregates";
import { ReadingsDao, type Agg5mReading } from "@/lib/readings";
import type { PointId } from "@/lib/ids";
import type { AggRow } from "./build-series";
import type { Agg5mAvgCache, Agg5mAvgRow } from "./agg5m-cache";

/**
 * One point to fetch: its identity plus the composite address the SERVED rows are keyed by.
 *
 * The caller resolves both — `SeriesInfo.point` is a `PointInfo` (which carries `point_uid`) and
 * the Sankey's energy overlay comes from `LogicalSystemPoint` — so this fetch no longer spends a
 * `RegistryCache.pointForAddr` round trip per pair rediscovering an identity that was already in
 * hand (config-v4 Phase 12 slice D). `systemId`/`pointId` stay because `AggRow.point_id` is still
 * the integer index on the wire; they die with the handle in Phase 13.
 */
export interface AggFetchPoint {
  point: PointId;
  systemId: number;
  pointId: number;
}

export interface AggFetchParams {
  /** Distinct points to fetch (deduped by identity). */
  uniquePairs: AggFetchPoint[];
  interval: "5m" | "30m" | "1d";
  /** 5m/30m only: dense-timeline bounds in epoch-ms (queryFirstEpoch = firstEpoch − 25m for 30m). */
  queryFirstEpoch?: number;
  lastEpoch?: number;
  /** 1d only: inclusive day range, YYYY-MM-DD. */
  startDate?: string;
  endDate?: string;
}

function groupPointIdsByDevice(pairs: AggFetchPoint[]): Map<number, number[]> {
  const byDevice = new Map<number, number[]>();
  for (const { systemId, pointId } of pairs) {
    let arr = byDevice.get(systemId);
    if (!arr) {
      arr = [];
      byDevice.set(systemId, arr);
    }
    arr.push(pointId);
  }
  return byDevice;
}

/**
 * Build the two lookup maps the fetch below works through. Pure and synchronous: the caller
 * supplies each point's identity alongside its address, so there is nothing to resolve — this used
 * to be a concurrent `RegistryCache.pointForAddr` fan-out (config-v4 Phase 12 slice D).
 *
 * The old fan-out skipped an address with no registry identity rather than aborting the fetch.
 * That branch is gone with the lookup: `point_uid` is NOT NULL and the caller read the row, so an
 * unresolvable point is no longer representable here. A point deleted mid-request now surfaces
 * from the DAO instead of being silently dropped, which is the better answer.
 */
function resolvePairs(pairs: AggFetchPoint[]): {
  /** `"systemId.pointId"` → PointId. */
  pairToPoint: Map<string, PointId>;
  /** PointId → integer `pointId` (the reverse used to rebuild the served rows). */
  pointToInt: Map<PointId, number>;
} {
  const pairToPoint = new Map<string, PointId>();
  const pointToInt = new Map<PointId, number>();
  for (const { point, systemId, pointId } of pairs) {
    pairToPoint.set(`${systemId}.${pointId}`, point);
    pointToInt.set(point, pointId);
  }
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
  const idsByDevice = groupPointIdsByDevice(p.uniquePairs);
  const { pairToPoint, pointToInt } = resolvePairs(p.uniquePairs);

  // The resolved PointIds for a device's requested indices, preserving the caller's order (skipping
  // any unresolved address).
  const pointsFor = (systemId: number, ids: number[]): PointId[] =>
    ids
      .map((i) => pairToPoint.get(`${systemId}.${i}`))
      .filter((x): x is PointId => x !== undefined);

  if (p.interval === "1d") {
    // One DAO read per device, run CONCURRENTLY (independent devices don't need to serialize on the
    // pool) — `Promise.all` preserves `idsByDevice`'s insertion order in the result array regardless
    // of completion order. Cross-point/cross-device row order is irrelevant downstream: the shared 1d
    // transform re-densifies each series from a Map keyed by day, and the DAO already returns each
    // point's days ascending.
    const perDevice = await Promise.all(
      Array.from(idsByDevice, async ([systemId, ids]) => {
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
    return perDevice.flat();
  }

  // 5m / 30m: read the sparse rows, then densify to the exact grid. One DAO read per device, run
  // CONCURRENTLY (see the 1d path's note above — same guarantee applies here).
  const queryFirstEpoch = p.queryFirstEpoch!;
  const lastEpoch = p.lastEpoch!;

  const perDevice = await Promise.all(
    Array.from(idsByDevice, async ([systemId, ids]) => {
      const pointIds = pointsFor(systemId, ids);
      const byPoint = await ReadingsDao.read5m(pointIds, {
        fromMs: queryFirstEpoch,
        toMs: lastEpoch,
      });

      // §1.3a: reconstruct the PRE-densify sparse rows the avgCache expects (`{pointId, intervalEnd:
      // Date, avg}`), byte-identical to the former raw select. Populated per device over the same
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
      const deviceRows: AggRow[] = [];
      for (const pointId of pointIds) {
        const intId = pointToInt.get(pointId)!;
        const byMs = new Map<number, Agg5mReading>();
        for (const r of byPoint.get(pointId)!) byMs.set(r.intervalEndMs, r);
        for (let t = queryFirstEpoch; ; t += FIVE_MIN_MS) {
          const hit = byMs.get(t);
          deviceRows.push({
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
      return deviceRows;
    }),
  );
  return perDevice.flat();
}
