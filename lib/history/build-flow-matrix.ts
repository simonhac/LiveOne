/**
 * Compute the energy-flow (Sankey) matrix from the signed 5-minute rows the history read already
 * loaded — the sub-daily serving path (≤ 1 week). For `interval` 5m and 30m the history fetch loads
 * `point_readings_agg_5m` into `allRows` (the 30m bucketing happens *after*, in
 * `buildSeriesFromAggRows`), so the signed 5m series is in hand and the Sankey costs no extra query.
 * For 1d the history rows are daily averages that cancel direction — that path is served from the
 * materialized `point_readings_flow_attr_1d` instead (see docs/architecture/energy-flow-matrix.md).
 *
 * Parity: this mirrors the engine's flow_attr rollup (`lib/db/planetscale/battery-provenance-pg.ts`) —
 * raw `avg`, the same kW normalization, the same `buildFlowSeries`/`computeFlowMatrix` core — so the
 * sub-daily (5m) and materialized (1d) Sankeys agree by construction. Both apply the point's `transform` through
 * the shared `applyPowerTransform` (only "i" = invert matters for a power point — e.g. a grid/AC-source
 * channel wired so import reads negative, a generator); it's applied IDENTICALLY here and in the engine
 * recompute, so the two paths stay byte-identical. That shared helper is the single home for the rule.
 */

import type { AggRow } from "@/lib/history/build-series";
import type { LogicalSystem } from "@/lib/aggregation/logical-system";
import {
  buildFlowSeries,
  applyPowerTransform,
  applyEnergyTransform,
  toIntervalKwh,
  ClassifiedPoint,
  EnergySeriesInput,
} from "@/lib/aggregation/flow-series";
import { computeFlowMatrix } from "@/lib/aggregation/flow-matrix-core";
import { toEnergyFlowMatrix } from "@/lib/aggregation/flow-node-meta";
import type { EnergyFlowMatrix } from "@/lib/energy-flow-matrix";

/** Convert an aggregate value to kW given the point's metric unit (W/Wh → /1000). */
function toKw(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return unit === "W" || unit === "Wh" ? value / 1000 : value;
}

/**
 * Build the `EnergyFlowMatrix` for a logical system from in-memory signed 5m rows.
 *
 * @param allRows  the agg_5m rows already fetched for the request (5m, or 30m pre-bucketing)
 * @param logicalSystem  the role→point mapping (`resolveLogicalSystem`); its points may span systems
 * @returns the matrix, or null if no participating point has data / no source or load resolves
 */
export function buildFlowMatrixFromAggRows(
  allRows: AggRow[],
  logicalSystem: LogicalSystem,
): EnergyFlowMatrix | null {
  // Index each point's signed avg AND interval delta by interval_end, and collect the shared 5m
  // timeline (energy points' interval_ends join it too, so an interval the power series dropped
  // still exists on the timeline).
  const avgByPoint = new Map<string, Map<number, number | null>>();
  const deltaByPoint = new Map<string, Map<number, number | null>>();
  const timestampSet = new Set<number>();
  for (const r of allRows) {
    if (r.interval_end === undefined) continue; // 1d rows carry `day`, not interval_end — skip
    timestampSet.add(r.interval_end);
    const key = `${r.system_id}.${r.point_id}`;
    let series = avgByPoint.get(key);
    if (!series) {
      series = new Map();
      avgByPoint.set(key, series);
    }
    series.set(r.interval_end, r.avg ?? null);
    let deltas = deltaByPoint.get(key);
    if (!deltas) {
      deltas = new Map();
      deltaByPoint.set(key, deltas);
    }
    deltas.set(r.interval_end, r.delta ?? null);
  }

  const timestamps = [...timestampSet].sort((a, b) => a - b);
  const tIndex = new Map<number, number>(timestamps.map((t, i) => [t, i]));

  const classified: ClassifiedPoint[] = [];
  const displayNameByStem = new Map<string, string>();
  for (const p of logicalSystem.points) {
    const series = avgByPoint.get(`${p.ref.systemId}.${p.ref.pointId}`);
    if (!series) continue; // this role point wasn't in the fetched window
    const power = new Array<number | null>(timestamps.length).fill(null);
    for (const [t, v] of series) {
      const i = tIndex.get(t);
      if (i !== undefined)
        power[i] = applyPowerTransform(toKw(v, p.metricUnit), p.transform);
    }
    classified.push({ stem: p.stem, power });
    if (!displayNameByStem.has(p.stem))
      displayNameByStem.set(p.stem, p.displayName);
  }

  if (classified.length === 0) return null;

  // Exact-energy overlays from the logical system's accumulator points (fetched into `allRows`
  // by the route when a Sankey is requested); slot-aligned — buildFlowSeries owns the shift.
  const energySeries: EnergySeriesInput[] = [];
  for (const p of logicalSystem.energyPoints) {
    const deltas = deltaByPoint.get(`${p.ref.systemId}.${p.ref.pointId}`);
    if (!deltas) continue; // energy rows absent (older client/fetch) → power fallback, never omit
    const energyKwhBySlot = new Array<number | null>(timestamps.length).fill(
      null,
    );
    for (const [t, v] of deltas) {
      const i = tIndex.get(t);
      if (i !== undefined)
        energyKwhBySlot[i] = applyEnergyTransform(
          toIntervalKwh(v, p.metricUnit),
          p.transform,
        );
    }
    energySeries.push({ stem: p.stem, energyKwhBySlot });
  }

  const { sources, loads } = buildFlowSeries(
    classified,
    energySeries,
    timestamps,
  );
  if (sources.length === 0 || loads.length === 0) return null;

  const result = computeFlowMatrix({ timestamps, sources, loads });
  return toEnergyFlowMatrix(
    result.sources,
    result.loads,
    result.matrix,
    displayNameByStem,
  );
}
