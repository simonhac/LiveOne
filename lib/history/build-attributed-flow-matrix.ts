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
import {
  buildSourceIntensities,
  computeBatteryProvenance,
  SOLAR_ACTUAL_COST,
} from "@/lib/battery-provenance/compute";
import { loadProvenanceInputs } from "@/lib/battery-provenance/load";
import { loadFlowSeriesFromAgg5m } from "@/lib/aggregation/flow-series-pg";
import { readPersistedBatteryBlend } from "@/lib/battery-provenance/persisted-blend";
import { resolveExportReceiptSeries } from "@/lib/battery-provenance/tariff";
import { loadWarmProvenanceInputs } from "@/lib/battery-provenance/warm-inputs";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  computeFlowAccounting,
  type FlowAccountingResult,
  type SourceIntensity,
} from "@/lib/aggregation/flow-matrix-core";
import {
  buildLoadPrices,
  compareLoadPaths,
  compareSourcePaths,
  colorForFlowPath,
  labelForFlowPath,
} from "@/lib/aggregation/flow-node-meta";
import {
  resolveLogicalSystem,
  type LogicalSystem,
} from "@/lib/aggregation/logical-system";
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
    selfRenewableKwh: knownGrid(
      acc.selfRenewableKwh,
      acc.selfRenewableKnownKwh,
    ),
    costC: knownGrid(acc.costC, acc.priceKnownKwh),
    revenueC: knownGrid(acc.revenueC, acc.revenueKnownKwh),
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
 * Build the attributed flow matrix for logical-system `handle` over `[startMs, endMs]`.
 *
 * 🛑 THIS PATH NO LONGER FOLDS. The battery's per-interval blend is READ from the `bidi.battery/*`
 * points the engine already writes (`readPersistedBatteryBlend`); everything else in a source
 * intensity — solar's constants, grid's OE/Amber series — was always pure. Three things follow:
 *
 *  - **One number, two readers.** A run period and this Sankey now price `source.battery` from the
 *    same series, so they cannot disagree about it. Re-folding here was the largest remaining
 *    divergence between the two surfaces (~23 gCO₂/kWh and ~0.44 c/kWh mean absolute deviation over a
 *    Kinkora week): same fold code, but a different seed over a different window, so late-arriving
 *    `agg_5m` moved them apart.
 *  - **D/W now agrees with M/Y** (`flow_attr_1d`), which is materialised from the same engine fold
 *    that wrote those points — rather than from a second, independently-seeded one.
 *  - **The window is read EXACTLY**, with no `WARMUP_MS` lead-in and no checkpoint seed, because
 *    nothing stateful runs here. That is the §1.3b/c read-amplification win: a 7-day Sankey reads 7
 *    days instead of 14.
 *
 * The fold survives only as a fallback for an Area that has a `source.battery` but NO persisted blend
 * at all (a brand-new Area, or one whose engine has never run). Partial coverage is NOT a fallback:
 * intervals without a row keep a null battery intensity and drop out of `computeFlowAccounting`'s
 * unbiased average, which is strictly better than re-deriving the whole window from a different basis.
 *
 * Returns `null` when the Area/logical system can't be resolved or has no usable timeline — the caller
 * treats that as "nothing to serve" (distinct from a thrown error, which the caller catches for P3
 * degradation).
 */
export async function buildAttributedFlowMatrix(
  handle: number,
  startMs: number,
  endMs: number,
  /** Pre-resolved logical system, when the caller already has one (e.g. `/api/history` resolves it
   *  once for the energy-only Sankey) — skips two internal `resolveLogicalSystem` calls (here and
   *  inside `loadProvenanceInputs`). Must be for the same `handle`; not verified. */
  logicalSystem?: LogicalSystem,
): Promise<DailyFlowMatrices | null> {
  const db = requirePlanetscaleDb();

  let inputs = await loadProvenanceInputs(
    handle,
    { startMs, endMs },
    { logicalSystem },
  );
  if (!inputs || inputs.timeline.length < 2) return null;

  const hasBattery = inputs.sources.some((s) => s.path === "source.battery");
  const blend = hasBattery
    ? await readPersistedBatteryBlend(db, inputs.areaId, inputs.timeline)
    : null;

  let sourceIntensities: (SourceIntensity | null)[];
  let exportReceiptPrice: (number | null)[];

  // `present`, not `covered` — an empty battery is a computed interval with null intensities, not a
  // missing engine. See `readPersistedBatteryBlend`.
  if (!hasBattery || (blend && blend.present > 0)) {
    sourceIntensities = buildSourceIntensities({
      sources: inputs.sources,
      timeline: inputs.timeline,
      gridEmissions: inputs.gridEmissions,
      gridRenewable: inputs.gridRenewable,
      gridPrice: inputs.gridPrice,
      gridEmissionsEstimated: inputs.gridEmissionsEstimated,
      gridPriceEstimated: inputs.gridPriceEstimated,
      steps: blend?.steps ?? [],
      solarCost: SOLAR_ACTUAL_COST,
    });
    exportReceiptPrice = resolveExportReceiptSeries(
      inputs.exportTariff,
      inputs.timeline,
      inputs.timezoneOffsetMin,
      inputs.gridExportPrice,
    );
  } else {
    // No blend has ever been written for this battery Area — fold it, warmly, exactly as this
    // function used to. Loud, because it costs a lead-in read and reintroduces the divergence above.
    console.warn(
      `[history] no persisted battery blend for handle=${handle} — falling back to a live fold`,
    );
    const warm = await loadWarmProvenanceInputs(
      db,
      handle,
      { startMs, endMs },
      { logicalSystem },
    );
    if (!warm) return null;
    inputs = warm.inputs;
    const result = computeBatteryProvenance(
      warm.inputs,
      {},
      {
        initialState: warm.initialState,
        efficiencyFallback: warm.efficiencyFallback,
      },
    );
    sourceIntensities = result.sourceIntensities;
    exportReceiptPrice = result.exportReceiptPrice;
  }

  const acc = computeFlowAccounting({
    timestamps: inputs.timeline,
    sources: inputs.sources,
    loads: inputs.loads,
    sourceIntensities,
    loadPrices: buildLoadPrices(inputs.loads, exportReceiptPrice),
    window: { startMs, endMs },
  });

  const ls = logicalSystem ?? (await resolveLogicalSystem(handle));
  const displayNameByStem = new Map<string, string>();
  for (const p of ls?.points ?? []) {
    if (!displayNameByStem.has(p.stem))
      displayNameByStem.set(p.stem, p.displayName);
  }

  const day = localDay(startMs, inputs.timezoneOffsetMin);
  return shapeAttributedFlowMatrix(acc, day, displayNameByStem);
}

/**
 * DEGRADED single-path fallback: the attributed matrix with the metric legs all-null and every
 * joule booked as `estimatedKwh` — the ENERGY leg is exact, nothing else is claimed.
 *
 * This is what replaces the retired energy-only `response.flowMatrix` (P3): when
 * {@link buildAttributedFlowMatrix} throws (a metric-leg input failed — blend read, learned params,
 * grid intensity series), the caller retries with this builder, which needs ONLY the logical
 * system + `agg_5m` — the same inputs the old energy-only matrix needed — so the one remaining
 * flow computation cannot fail anywhere the old fallback would have succeeded. All-null
 * intensities run through the SAME `computeFlowAccounting` allocation (a null intensity keeps the
 * cell's energy and books it estimated), so the energy grid is byte-identical to the full build's.
 */
export async function buildEnergyOnlyAttributedMatrix(
  handle: number,
  startMs: number,
  endMs: number,
  logicalSystem: LogicalSystem,
): Promise<DailyFlowMatrices | null> {
  const db = requirePlanetscaleDb();
  const { timeline, sources, loads } = await loadFlowSeriesFromAgg5m(
    db,
    logicalSystem.points,
    startMs,
    endMs,
    logicalSystem.energyPoints,
  );
  if (timeline.length < 2 || sources.length === 0 || loads.length === 0)
    return null;

  const acc = computeFlowAccounting({
    timestamps: timeline,
    sources,
    loads,
    sourceIntensities: sources.map(() => null),
    loadPrices: buildLoadPrices(
      loads,
      new Array<number | null>(timeline.length).fill(null),
    ),
    window: { startMs, endMs },
  });

  const displayNameByStem = new Map<string, string>();
  for (const p of logicalSystem.points) {
    if (!displayNameByStem.has(p.stem))
      displayNameByStem.set(p.stem, p.displayName);
  }
  const day = localDay(startMs, logicalSystem.timezoneOffsetMin);
  return shapeAttributedFlowMatrix(acc, day, displayNameByStem);
}
