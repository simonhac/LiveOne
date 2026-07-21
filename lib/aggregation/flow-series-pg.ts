/**
 * Shared PG→FlowSeries builder — the single place that turns a set of logical power points + a time
 * window of `point_readings_agg_5m` into the canonical source/load `FlowSeries` the flow accounting
 * integrates. Used by the engine's attributed `point_readings_flow_attr_1d` rollup
 * (`battery-provenance-pg.ts`) — the sole flow matrix — so the materialised Sankey and any live path
 * built on this helper share byte-identical edges by construction.
 *
 * DB-touching but domain-light: it reads signed 5-minute `avg` for the given point refs (which may
 * span child systems for a multi-device area), aligns them onto one dense timeline, converts to kW +
 * applies each point's transform, and hands off to the pure `buildFlowSeries` for the role split
 * (battery/grid direction, solar leaf/residual, rest-of-house).
 */

import { and, eq, gte, lt, lte, or } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pointReadingsAgg5m } from "@/lib/db/planetscale/schema";
import {
  buildFlowSeries,
  applyPowerTransform,
  ClassifiedPoint,
} from "@/lib/aggregation/flow-series";
import type { FlowSeries } from "@/lib/aggregation/flow-matrix-core";
import type { Agg5mAvgCache } from "@/lib/history/agg5m-cache";

type PgDb = NonNullable<typeof planetscaleDb>;

/** A logical power point to integrate: its physical origin (may be a child system) + its semantics. */
export interface FlowSeriesPoint {
  ref: { systemId: number; pointId: number };
  stem: string;
  metricUnit: string | null;
  transform: string | null;
}

/** Convert an aggregate value to kW given the point's metric unit (W/Wh → /1000). */
function toKw(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return unit === "W" || unit === "Wh" ? value / 1000 : value;
}

export interface FlowSeriesBundle {
  /** Dense shared timeline (epoch ms, ascending) — the union of the points' interval_ends in range. */
  timeline: number[];
  sources: FlowSeries[];
  loads: FlowSeries[];
}

/**
 * Read `agg_5m` for `points` over `[startMs, endMs]` (inclusive), build the shared dense timeline, and
 * resolve the canonical source/load `FlowSeries` via `buildFlowSeries`. Returns empty series when the
 * points have no data in range (the caller then clears/skips the window). Identical construction for
 * every consumer, so a flow matrix and its attributed superset never disagree on which edges exist.
 */
export async function loadFlowSeriesFromAgg5m(
  db: PgDb,
  points: FlowSeriesPoint[],
  startMs: number,
  endMs: number,
  /** Optional request-scoped cache of the raw sparse `agg_5m` avg rows the `/api/history` "fetch" span
   *  already read (§1.3a). Covered role points reuse those in-window rows and query only the pre-window
   *  lead-in `[startMs, cache.from)`; uncovered points fall back to a full `[startMs, endMs]` query. The
   *  reconstructed row set is identical to the single-query path — a pure read elimination. */
  cache?: Agg5mAvgCache,
): Promise<FlowSeriesBundle> {
  if (points.length === 0) return { timeline: [], sources: [], loads: [] };

  type NormRow = {
    systemId: number;
    pointId: number;
    t: number;
    avg: number | null;
  };
  const merged: NormRow[] = [];

  // Query `batch` over [lo, hi) (hiInclusive=false) or [lo, hi] (true) and append normalized rows.
  const queryInto = async (
    batch: FlowSeriesPoint[],
    lo: number,
    hi: number,
    hiInclusive: boolean,
  ): Promise<void> => {
    if (batch.length === 0) return;
    const refConds = batch.map((p) =>
      and(
        eq(pointReadingsAgg5m.systemId, p.ref.systemId),
        eq(pointReadingsAgg5m.pointId, p.ref.pointId),
      ),
    );
    const rows = await db
      .select({
        systemId: pointReadingsAgg5m.systemId,
        pointId: pointReadingsAgg5m.pointId,
        intervalEnd: pointReadingsAgg5m.intervalEnd,
        avg: pointReadingsAgg5m.avg,
      })
      .from(pointReadingsAgg5m)
      .where(
        and(
          or(...refConds),
          gte(pointReadingsAgg5m.intervalEnd, new Date(lo)),
          hiInclusive
            ? lte(pointReadingsAgg5m.intervalEnd, new Date(hi))
            : lt(pointReadingsAgg5m.intervalEnd, new Date(hi)),
        ),
      );
    for (const r of rows)
      merged.push({
        systemId: r.systemId,
        pointId: r.pointId,
        t: r.intervalEnd.getTime(),
        avg: r.avg,
      });
  };

  // Split into cache-covered points (reuse in-window rows + query only the lead-in) and uncovered
  // points (full [startMs, endMs] query). With no cache, every point is a full query — today's path.
  const fullPoints: FlowSeriesPoint[] = [];
  const leadInPoints: FlowSeriesPoint[] = [];
  let leadInFrom: number | undefined;
  for (const p of points) {
    const s = cache?.slice(p.ref.systemId, p.ref.pointId, startMs, endMs);
    if (s?.covered) {
      for (const r of s.rows)
        merged.push({
          systemId: p.ref.systemId,
          pointId: p.ref.pointId,
          t: r.t,
          avg: r.avg,
        });
      // Lead-in only when the window starts before the cache's lower bound (uniform across covered
      // points in one request). A seeded anchor inside the cache window needs no lead-in query.
      if (startMs < s.from) {
        leadInPoints.push(p);
        leadInFrom = s.from;
      }
    } else {
      fullPoints.push(p);
    }
  }
  if (leadInPoints.length > 0 && leadInFrom !== undefined)
    await queryInto(leadInPoints, startMs, leadInFrom, false); // [startMs, from)
  await queryInto(fullPoints, startMs, endMs, true); // [startMs, endMs]

  if (merged.length === 0) return { timeline: [], sources: [], loads: [] };

  const timeline = [...new Set(merged.map((r) => r.t))].sort((a, b) => a - b);
  const tIndex = new Map<number, number>(timeline.map((t, i) => [t, i]));

  const avgByPoint = new Map<string, Map<number, number | null>>();
  for (const r of merged) {
    const key = `${r.systemId}.${r.pointId}`;
    let series = avgByPoint.get(key);
    if (!series) {
      series = new Map();
      avgByPoint.set(key, series);
    }
    series.set(r.t, r.avg);
  }

  const classified: ClassifiedPoint[] = [];
  for (const p of points) {
    const series = avgByPoint.get(`${p.ref.systemId}.${p.ref.pointId}`);
    if (!series) continue;
    const power = new Array<number | null>(timeline.length).fill(null);
    for (const [t, v] of series) {
      const i = tIndex.get(t);
      if (i !== undefined)
        power[i] = applyPowerTransform(toKw(v, p.metricUnit), p.transform);
    }
    classified.push({ stem: p.stem, power });
  }

  const { sources, loads } = buildFlowSeries(classified);
  return { timeline, sources, loads };
}
