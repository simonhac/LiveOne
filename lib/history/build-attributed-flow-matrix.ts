/**
 * On-the-fly ATTRIBUTED energy-flow matrix (energy + emissions/renewable/cost/estimated legs) for an
 * arbitrary sub-daily window — the server-side compute behind the Sankey node tooltips
 * (`/api/history?include=sankey`). Mirrors `writeAttrRollup`'s per-day rollup
 * (`lib/db/planetscale/battery-provenance-pg.ts`) but for one caller-supplied `[startMs, endMs]` window
 * instead of the local-day split, and shapes the result as a 1-entry `DailyFlowMatrices` (day = the
 * window's local start day; the reducers below sum across `days` so a single bucket is fine).
 *
 * P2 (series-universe parity, see the sankey-side-tooltip handoff): loads its flow series via the SAME
 * `resolveLogicalSystem` + `loadFlowSeriesFromAgg5m` path the energy-only history Sankey
 * (`lib/history/build-flow-matrix.ts`) uses. Since PR#193 retired the `FLOW_ATTR_UNIFIED` gate,
 * `loadProvenanceInputs` always takes that unified series path — no opt-in needed here.
 *
 * P3 (graceful degradation): this function can throw (DB error, no Area, incomplete role set) — the
 * caller (`/api/history`) wraps it in a try/catch and degrades to the energy-only matrix + limited
 * tooltips, carrying `attributedFlowOmittedReason`. Returns `null` (not a throw) when the Area/inputs
 * can't be resolved at all — same "nothing to serve" contract as `loadProvenanceInputs`.
 */

import { CalendarDate } from "@internationalized/date";
import { computeBatteryProvenance } from "@/lib/battery-provenance/compute";
import { loadProvenanceInputs } from "@/lib/battery-provenance/load";
import { WARMUP_MS } from "@/lib/db/planetscale/battery-provenance-pg";
import {
  computeFlowAccounting,
  type FlowAccountingResult,
} from "@/lib/aggregation/flow-matrix-core";
import {
  compareLoadPaths,
  compareSourcePaths,
  colorForFlowPath,
  labelForFlowPath,
} from "@/lib/aggregation/flow-node-meta";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import type {
  DailyFlowMatrices,
  DailyFlowMatrix,
  EnergyFlowNode,
} from "@/lib/energy-flow-matrix";

/** Local (Area-timezone) calendar day string for `ms`, e.g. "2026-07-20". */
function localDay(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60000);
  return new CalendarDate(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
  ).toString();
}

/**
 * Shape a `FlowAccountingResult` (already windowed) into a 1-entry `DailyFlowMatrices` with
 * canonical-sorted node ids/labels/colors — the same ordering `toEnergyFlowMatrix` applies, extended
 * with the metric legs. `null` cells mirror `writeAttrRollup`: a cell is `null` (excluded from that
 * metric's average) when NO energy on that edge had a known intensity, even if some energy flowed.
 * Pure — no DB — so it's independently testable against `buildFlowMatrixFromAggRows`'s energy leg.
 */
export function shapeAttributedFlowMatrix(
  acc: FlowAccountingResult,
  day: string,
  displayNameByStem: Map<string, string>,
): DailyFlowMatrices {
  const sOrder = acc.sources
    .map((_, i) => i)
    .sort((a, b) => compareSourcePaths(acc.sources[a], acc.sources[b]));
  const lOrder = acc.loads
    .map((_, i) => i)
    .sort((a, b) => compareLoadPaths(acc.loads[a], acc.loads[b]));

  const numGrid = (grid: number[][]): number[][] =>
    sOrder.map((si) => lOrder.map((li) => grid[si][li]));
  const knownGrid = (
    grid: number[][],
    knownKwh: number[][],
  ): (number | null)[][] =>
    sOrder.map((si) =>
      lOrder.map((li) => (knownKwh[si][li] > 0 ? grid[si][li] : null)),
    );

  const dayEntry: DailyFlowMatrix = {
    day,
    matrix: numGrid(acc.energyKwh),
    emissionsG: knownGrid(acc.emissionsG, acc.emissionsKnownKwh),
    renewableKwh: knownGrid(acc.renewableKwh, acc.renewableKnownKwh),
    costC: knownGrid(acc.costC, acc.priceKnownKwh),
    estimatedKwh: numGrid(acc.estimatedKwh),
  };

  const node = (path: string): EnergyFlowNode => ({
    id: path,
    label: labelForFlowPath(path, displayNameByStem),
    color: colorForFlowPath(path),
  });

  return {
    sources: sOrder.map((i) => node(acc.sources[i])),
    loads: lOrder.map((i) => node(acc.loads[i])),
    days: [dayEntry],
  };
}

/**
 * Build the attributed flow matrix for logical-system `handle` over `[startMs, endMs]`. Loads a
 * `WARMUP_MS` lead-in for the battery fold to reach a reset before the window (same warm-up the prod
 * driver uses), runs the SAME `computeBatteryProvenance` fold the write path does (safe — and already
 * exercised — for battery-less Areas too: with no `source.battery` in `inputs.sources` the fold simply
 * produces no battery source-intensity entry), then re-runs `computeFlowAccounting` clipped to the exact
 * requested window (mirrors `writeAttrRollup`'s per-day re-slice).
 *
 * Returns `null` when the Area/logical system can't be resolved or has no usable timeline — the caller
 * treats that as "nothing to serve" (distinct from a thrown error, which the caller catches for P3
 * degradation).
 */
export async function buildAttributedFlowMatrix(
  handle: number,
  startMs: number,
  endMs: number,
): Promise<DailyFlowMatrices | null> {
  const inputs = await loadProvenanceInputs(handle, {
    startMs: startMs - WARMUP_MS,
    endMs,
  });
  if (!inputs) return null;

  const result = computeBatteryProvenance(inputs);
  const acc = computeFlowAccounting({
    timestamps: inputs.timeline,
    sources: inputs.sources,
    loads: inputs.loads,
    sourceIntensities: result.sourceIntensities,
    window: { startMs, endMs },
  });

  const logicalSystem = await resolveLogicalSystem(handle);
  const displayNameByStem = new Map<string, string>();
  for (const p of logicalSystem?.points ?? []) {
    if (!displayNameByStem.has(p.stem))
      displayNameByStem.set(p.stem, p.displayName);
  }

  const day = localDay(startMs, inputs.timezoneOffsetMin);
  return shapeAttributedFlowMatrix(acc, day, displayNameByStem);
}
