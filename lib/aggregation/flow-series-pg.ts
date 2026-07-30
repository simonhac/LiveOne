/**
 * Shared PG→FlowSeries builder — the single place that turns a set of logical power points + a time
 * window of `point_readings_agg_5m` into the canonical source/load `FlowSeries` the flow accounting
 * integrates. Used by the engine's attributed `point_readings_flow_attr_1d` rollup
 * (`battery-provenance-pg.ts`) — the sole flow matrix — so the materialised Sankey and any live path
 * built on this helper share byte-identical edges by construction.
 *
 * DB-touching but domain-light: it reads signed 5-minute `avg` for the given point refs (which may
 * span child devices for a multi-device area), aligns them onto one dense timeline, converts to kW +
 * applies each point's transform, and hands off to the pure `buildFlowSeries` for the role split
 * (battery/grid direction, solar leaf/residual, rest-of-house).
 */

import { planetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";
import {
  buildFlowSeries,
  applyPowerTransform,
  applyEnergyTransform,
  toIntervalKwh,
  ClassifiedPoint,
  EnergySeriesInput,
} from "@/lib/aggregation/flow-series";
import type { FlowSeries } from "@/lib/aggregation/flow-matrix-core";
import type { Agg5mAvgCache } from "@/lib/history/agg5m-cache";
import type { PointId } from "@/lib/ids";

type PgDb = NonNullable<typeof planetscaleDb>;

/** A logical power point to integrate: its physical origin (may be a child device) + its semantics. */
export interface FlowSeriesPoint {
  /**
   * The point's identity, supplied by the caller (`LogicalSystemPoint.point`). Reading it here
   * removes a `RegistryCache.pointForAddr` round trip per point per batch — the caller resolved
   * the row, so it already holds the uuid (config-v4 Phase 12 slice D).
   */
  point: PointId;
  /** Physical origin — still the key the emitted `NormRow`s carry downstream. */
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
  /** Exact-energy accumulator points (`LogicalSystem.energyPoints`): their `delta` becomes the
   *  `FlowSeries.energyKwh` overlays the integrator prefers over power integration. Read on the
   *  direct-query path (the avg cache never covers them — ≤ a handful of points), and their
   *  interval_ends JOIN the shared timeline, so an interval the power series dropped still exists. */
  energyPoints?: FlowSeriesPoint[],
): Promise<FlowSeriesBundle> {
  if (points.length === 0) return { timeline: [], sources: [], loads: [] };

  type NormRow = {
    systemId: number;
    pointId: number;
    t: number;
    avg: number | null;
    delta: number | null;
  };
  const merged: NormRow[] = [];

  // Read `batch`'s agg_5m over [lo, hi) (hiInclusive=false) or [lo, hi] (true) via the readings seam
  // and append normalized rows. Each point carries its own identity, so `refByPoint` is just the
  // reverse map back to the composite address the emitted `NormRow`s are keyed by.
  const queryInto = async (
    batch: FlowSeriesPoint[],
    lo: number,
    hi: number,
    hiInclusive: boolean,
  ): Promise<void> => {
    if (batch.length === 0) return;
    const refByPoint = new Map<
      PointId,
      { systemId: number; pointId: number }
    >();
    const pointIds: PointId[] = [];
    for (const p of batch) {
      refByPoint.set(p.point, p.ref);
      pointIds.push(p.point);
    }
    if (pointIds.length === 0) return;
    const series = await ReadingsDao.read5m(
      pointIds,
      { fromMs: lo, toMs: hi, toInclusive: hiInclusive },
      db,
    );
    for (const [id, rows] of series) {
      const ref = refByPoint.get(id)!;
      for (const r of rows)
        merged.push({
          systemId: ref.systemId,
          pointId: ref.pointId,
          t: r.intervalEndMs,
          avg: r.avg,
          delta: r.delta,
        });
    }
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
          delta: null, // cache rows are avg-only; power points never read delta
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
  // Energy points always take the direct-query path alongside the uncovered power points.
  await queryInto(
    [...fullPoints, ...(energyPoints ?? [])],
    startMs,
    endMs,
    true,
  ); // [startMs, endMs]

  if (merged.length === 0) return { timeline: [], sources: [], loads: [] };

  const timeline = [...new Set(merged.map((r) => r.t))].sort((a, b) => a - b);
  const tIndex = new Map<number, number>(timeline.map((t, i) => [t, i]));

  type Cell = { avg: number | null; delta: number | null };
  const rowsByPoint = new Map<string, Map<number, Cell>>();
  for (const r of merged) {
    const key = `${r.systemId}.${r.pointId}`;
    let series = rowsByPoint.get(key);
    if (!series) {
      series = new Map();
      rowsByPoint.set(key, series);
    }
    series.set(r.t, { avg: r.avg, delta: r.delta });
  }

  const classified: ClassifiedPoint[] = [];
  for (const p of points) {
    const series = rowsByPoint.get(`${p.ref.systemId}.${p.ref.pointId}`);
    if (!series) continue;
    const power = new Array<number | null>(timeline.length).fill(null);
    for (const [t, v] of series) {
      const i = tIndex.get(t);
      if (i !== undefined)
        power[i] = applyPowerTransform(toKw(v.avg, p.metricUnit), p.transform);
    }
    classified.push({ stem: p.stem, power });
  }

  // Exact-energy overlays, slot-aligned to the shared timeline (slot i = the delta stamped at
  // timeline[i]); buildFlowSeries' attach step owns the slot→interval shift.
  const energySeries: EnergySeriesInput[] = [];
  for (const p of energyPoints ?? []) {
    const series = rowsByPoint.get(`${p.ref.systemId}.${p.ref.pointId}`);
    if (!series) continue;
    const energyKwhBySlot = new Array<number | null>(timeline.length).fill(
      null,
    );
    for (const [t, v] of series) {
      const i = tIndex.get(t);
      if (i !== undefined)
        energyKwhBySlot[i] = applyEnergyTransform(
          toIntervalKwh(v.delta, p.metricUnit),
          p.transform,
        );
    }
    energySeries.push({ stem: p.stem, energyKwhBySlot });
  }

  const { sources, loads } = buildFlowSeries(
    classified,
    energySeries,
    timeline,
  );
  return { timeline, sources, loads };
}
