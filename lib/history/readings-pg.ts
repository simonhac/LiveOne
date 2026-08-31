/**
 * Postgres side of the `/api/history` readings fetch.
 *
 * `fetchAggRowsPg` returns a uniform `AggRow[]` so it can feed the shared
 * `buildSeriesFromAggRows`. The dense timeline is produced here in JS (identical grid math for
 * every serve path), so the grid never drifts on timestamp/timezone boundary semantics.
 *
 * Intervals map to reads as: `5m` → `agg_5m` rows verbatim; `30m` → `agg_5m` reduced to 30-minute
 * buckets IN SQL (`ReadingsDao.read30m` — 6× fewer rows over the wire; the served rows arrive
 * pre-bucketed, so `buildSeriesFromAggRows` has no 30m reduce step any more); `1d` → `agg_1d`.
 *
 * Reads flow through the config-v4 readings seam (`ReadingsDao`): the caller supplies each point's
 * `PointId` alongside its `(systemId, pointId)` composite address, the DAO reads by `PointId`, and
 * results are mapped back to the composite address for the served rows.
 */
import { FIVE_MIN_MS } from "@/lib/aggregation/point-aggregates";
import {
  ReadingsDao,
  type Agg5mReading,
  type Agg30mReading,
} from "@/lib/readings";
import type { PointId } from "@/lib/ids";
import type { AggRow } from "./build-series";

const THIRTY_MIN_MS = 30 * 60 * 1000;

/**
 * One point to fetch: its identity plus the composite address the SERVED rows are keyed by.
 *
 * The caller resolves both — `SeriesInfo.point` is a `PointInfo` (which carries `point_uid`) — so
 * this fetch never spends a registry round trip rediscovering an identity that was already in hand
 * (config-v4 Phase 12 slice D). `systemId`/`pointId` stay because `AggRow.point_id` is still the
 * integer index on the wire; they die with the handle in Phase 13.
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
  /** 5m/30m only: dense-grid bounds in epoch-ms — `firstEpoch` is the first served grid point
   *  (interval-aligned; the 30m read's 25-minute lead-in is applied internally). */
  firstEpoch?: number;
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
 * supplies each point's identity alongside its address, so there is nothing to resolve.
 *
 * A point deleted mid-request surfaces from the DAO instead of being silently dropped, which is
 * the better answer (see config-v4 Phase 12 slice D).
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
export async function fetchAggRowsPg(p: AggFetchParams): Promise<AggRow[]> {
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

  // 5m / 30m: read the sparse rows (30m arriving pre-bucketed from SQL), then densify to the exact
  // grid. One DAO read per device, run CONCURRENTLY (see the 1d path's note above).
  const firstEpoch = p.firstEpoch!;
  const lastEpoch = p.lastEpoch!;
  const stepMs = p.interval === "30m" ? THIRTY_MIN_MS : FIVE_MIN_MS;
  // A 30m bucket `B` reduces the six 5m rows ending in `(B−30m, B]`, so the first served bucket
  // needs rows from 25 minutes before it (the earliest interval-end inside it).
  const readFromMs =
    p.interval === "30m"
      ? firstEpoch - (THIRTY_MIN_MS - FIVE_MIN_MS)
      : firstEpoch;

  const perDevice = await Promise.all(
    Array.from(idsByDevice, async ([systemId, ids]) => {
      const pointIds = pointsFor(systemId, ids);
      const byPoint: Map<PointId, (Agg5mReading | Agg30mReading)[]> =
        p.interval === "30m"
          ? await ReadingsDao.read30m(pointIds, {
              fromMs: readFromMs,
              toMs: lastEpoch,
              // Buckets key off the SERVED grid's origin, not a global UTC :00/:30 grid — a subject
              // at a :45 offset makes the request's boundaries UTC :15/:45 (see read30m's note).
              anchorMs: firstEpoch,
            })
          : await ReadingsDao.read5m(pointIds, {
              fromMs: readFromMs,
              toMs: lastEpoch,
            });

      // Densify: emit a dense grid — seed at firstEpoch, step `stepMs`, and include the first grid
      // point that reaches/passes lastEpoch. Rows ascending per point.
      const deviceRows: AggRow[] = [];
      for (const pointId of pointIds) {
        const intId = pointToInt.get(pointId)!;
        const byMs = new Map<number, Agg5mReading | Agg30mReading>();
        for (const r of byPoint.get(pointId)!) byMs.set(r.intervalEndMs, r);
        for (let t = firstEpoch; ; t += stepMs) {
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
