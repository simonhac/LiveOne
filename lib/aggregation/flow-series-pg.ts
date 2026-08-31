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
  /** Exact-energy accumulator points (`LogicalSystem.energyPoints`): their `delta` becomes the
   *  `FlowSeries.energyKwh` overlays the integrator prefers over power integration. Their
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

  // One query for the power points + energy overlays together over [startMs, endMs]. (The
  // request-scoped avg cache that once split this into covered/lead-in reads is gone — the
  // /api/history fetch and attr spans no longer share rows; see the attributed-window builder.)
  await queryInto([...points, ...(energyPoints ?? [])], startMs, endMs, true);

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
