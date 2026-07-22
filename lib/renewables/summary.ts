/**
 * Renewables metrics — the client-safe reduction the `renewables` tile computes from the SHARED
 * attributed-flow payload (`DailyFlowMatrices`, served by `/api/history?include=sankey` and consumed
 * via `siteDataQuery` — NO dedicated route). `reduceRenewablesMetrics` flattens that period-scoped
 * payload into per-edge aggregates and runs the pure `computeRenewablesMetrics` below. No DB / HTTP /
 * React — only types + arithmetic, safe to import from the browser bundle.
 *
 * The three metrics, over a period, from the flow matrix (`point_readings_flow_attr_1d`; multi-day =
 * SUM by source_path/load_path):
 *
 *   consumption            = Σ energy, load ∉ {grid, battery}
 *   selfRenewToLoads       = Σ self_renewable_kwh over those consumption edges
 *   renewToLoads           = Σ renewable_kwh over those consumption edges
 *   selfRenewGenerated     = Σ self_renewable_kwh over ALL edges whose source is a behind-the-meter
 *                            generator (solar; `source.solar*`). Battery-charge edges contribute
 *                            nothing extra — their self-renewable content was already counted when the
 *                            solar entered (solar→battery is itself a solar-source edge).
 *   selfRenewExported      = Σ self_renewable_kwh on edges with load = grid (solar→grid directly, and
 *                            battery→grid at the blend).
 *
 * 1. Renewable autarky              = selfRenewToLoads / consumption
 *    Share of consumption covered by our OWN renewable generation (direct, or via the battery at its
 *    self-renewable blend). Grid renewables excluded. Generator excluded. Clamp [0,1].
 * 2. Own-renewable self-consumption = 1 − selfRenewExported / selfRenewGenerated
 *    Of the renewable energy WE generated, the fraction consumed on site (battery round-trip losses
 *    reduce this, correctly — lost energy was neither exported nor consumed). Null when
 *    selfRenewGenerated = 0. Clamp [0,1].
 * 3. Renewable share of consumption = renewToLoads / consumption
 *    Own + grid renewables; the grid leg uses the existing OpenElectricity-mix attribution (reproduces
 *    today's `renewable_kwh` semantics exactly — no new data). Clamp [0,1].
 *
 * Distinct-metric guard: on a site with a generator, (1) must NOT count generator energy even though it
 * is self-origin — that is what distinguishes renewable autarky from plain autarky. Generator energy
 * flows as `source.grid` with self_renewable = 0, so it never enters selfRenewToLoads.
 */

import type { DailyFlowMatrices } from "@/lib/energy-flow-matrix";

/** One aggregated source→load edge over the requested period (summed across days). */
export interface RenewablesEdgeAgg {
  sourcePath: string;
  loadPath: string;
  /** Σ energy_kwh over the period (always ≥ 0). */
  energyKwh: number;
  /** Σ renewable_kwh where non-null (the attributed renewable energy). */
  renewableKwh: number;
  /** Σ self_renewable_kwh where non-null. */
  selfRenewableKwh: number;
  /** # of contributing (area, day) rows on this edge where self_renewable_kwh was NULL (unknown). Any
   *  non-zero count on a metric's contributing edge set makes that metric unavailable — no fallback. */
  selfRenewableNullRows: number;
  /** Σ estimated_kwh (confidence numerator). */
  estimatedKwh: number;
}

export interface RenewablesMetrics {
  /** Metric 1 — renewable autarky (0..1); null when there was no consumption, or self-renewable was
   *  unknown on any consumption edge in the period (partial data — no silent fallback). */
  renewableAutarky: number | null;
  /** Metric 2 — own-renewable self-consumption (0..1); null when we generated no own renewable in the
   *  period, or self-renewable was unknown on any generator/export edge (partial data). */
  ownRenewableSelfConsumption: number | null;
  /** Metric 3 — renewable share of consumption (0..1); null when there was no consumption. Uses only
   *  the existing renewable_kwh leg, so it is never affected by partial self-renewable data. */
  renewableShare: number | null;
}

export interface RenewablesSummary {
  metrics: RenewablesMetrics;
  /** Consumption energy (kWh) over the period — the denominator of metrics 1 & 3. */
  consumptionKwh: number;
  /** Own renewable we generated (kWh) — the denominator of metric 2. */
  selfRenewGeneratedKwh: number;
  /** Confidence: consumption energy whose attribution used an estimated/unknown source intensity. */
  estimatedKwh: number;
  /** 100 · estimatedKwh / consumptionKwh (0 when there is no consumption). */
  pctEstimated: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The channel of a source/load path — the segment after the leading "source."/"load." (mirrors
 *  `channelId` in flow-matrix-core). "load.grid" → "grid" (export); "load.battery" → "battery"
 *  (charge); "source.solar.local" → "solar" (a behind-the-meter generator). */
function channel(path: string): string {
  const dot = path.indexOf(".");
  const rest = dot === -1 ? "" : path.slice(dot + 1);
  const dot2 = rest.indexOf(".");
  return dot2 === -1 ? rest : rest.slice(0, dot2);
}

/** A consumption edge: a real on-site load — NOT the battery-charge edge (load.battery) nor the grid
 *  export edge (load.grid). */
function isConsumptionLoad(loadPath: string): boolean {
  const c = channel(loadPath);
  return c !== "grid" && c !== "battery";
}

/** A behind-the-meter generator source: solar (any leaf). Grid / battery / generator-as-grid excluded. */
function isBehindMeterGenerator(sourcePath: string): boolean {
  return channel(sourcePath) === "solar";
}

/** Pure metric computation over the period's aggregated edges. */
export function computeRenewablesMetrics(
  edges: RenewablesEdgeAgg[],
): RenewablesSummary {
  let consumption = 0;
  let selfRenewToLoads = 0;
  let renewToLoads = 0;
  let selfRenewGenerated = 0;
  let selfRenewExported = 0;
  let estimatedConsumption = 0;
  // Partial-data guard: if self_renewable is unknown on ANY edge that contributes to the self-renewable
  // metrics (a consumption edge, a behind-the-meter generator source, or an export edge), BOTH metrics
  // 1 and 2 are unavailable for the period — no silent fallback. Metric 3 (renewable_kwh only) is fine.
  let selfRenewPartial = false;

  for (const e of edges) {
    const consumptionEdge = isConsumptionLoad(e.loadPath);
    const exportEdge = channel(e.loadPath) === "grid";
    const generatorSource = isBehindMeterGenerator(e.sourcePath);

    if (consumptionEdge) {
      consumption += e.energyKwh;
      selfRenewToLoads += e.selfRenewableKwh;
      renewToLoads += e.renewableKwh;
      estimatedConsumption += e.estimatedKwh;
    }
    if (generatorSource) selfRenewGenerated += e.selfRenewableKwh;
    if (exportEdge) selfRenewExported += e.selfRenewableKwh;

    if (
      e.selfRenewableNullRows > 0 &&
      (consumptionEdge || generatorSource || exportEdge)
    ) {
      selfRenewPartial = true;
    }
  }

  const renewableAutarky =
    consumption <= 0 || selfRenewPartial
      ? null
      : clamp01(selfRenewToLoads / consumption);
  const ownRenewableSelfConsumption =
    selfRenewGenerated <= 0 || selfRenewPartial
      ? null
      : clamp01(1 - selfRenewExported / selfRenewGenerated);
  const renewableShare =
    consumption <= 0 ? null : clamp01(renewToLoads / consumption);

  return {
    metrics: {
      renewableAutarky,
      ownRenewableSelfConsumption,
      renewableShare,
    },
    consumptionKwh: consumption,
    selfRenewGeneratedKwh: selfRenewGenerated,
    estimatedKwh: estimatedConsumption,
    pctEstimated:
      consumption > 0 ? (100 * estimatedConsumption) / consumption : 0,
  };
}

/**
 * Reduce the shared attributed-flow payload (a `source=modern` {@link DailyFlowMatrices}) to the three
 * renewables metrics over the whole window — summing across all days and all edges, the same additive
 * discipline as `reduceLoadProvenance`/`reduceSourceProvenance`. This is the tile's entry point: it
 * follows the dashboard's selected period (1D/7D/30D) because the payload does.
 *
 * Returns null for a legacy energy-only payload (no metric legs at all). When the metric legs are
 * present but `selfRenewableKwh` is absent (an older attributed payload predating this leg), every
 * energy-bearing edge counts as an unknown self-renewable row — so metrics 1-2 come back null
 * (unavailable) while metric 3 still computes from `renewableKwh`.
 */
export function reduceRenewablesMetrics(
  d: DailyFlowMatrices,
): RenewablesSummary | null {
  // Metric legs ride only on modern payloads; bail if the first day lacks them entirely.
  if (d.days.length > 0 && d.days[0].emissionsG === undefined) return null;

  const S = d.sources.length;
  const L = d.loads.length;
  const edges: RenewablesEdgeAgg[] = [];
  for (let s = 0; s < S; s++) {
    for (let l = 0; l < L; l++) {
      let energyKwh = 0;
      let renewableKwh = 0;
      let selfRenewableKwh = 0;
      let selfRenewableNullRows = 0;
      let estimatedKwh = 0;
      for (const day of d.days) {
        const e = day.matrix[s]?.[l] ?? 0;
        if (e <= 0) continue;
        energyKwh += e;
        const rk = day.renewableKwh?.[s]?.[l];
        if (rk != null) renewableKwh += rk;
        const sr = day.selfRenewableKwh?.[s]?.[l];
        if (sr != null) selfRenewableKwh += sr;
        else selfRenewableNullRows += 1; // energy flowed but self-renewable was unknown that day
        estimatedKwh += day.estimatedKwh?.[s]?.[l] ?? 0;
      }
      if (energyKwh <= 0) continue;
      edges.push({
        sourcePath: d.sources[s].id,
        loadPath: d.loads[l].id,
        energyKwh,
        renewableKwh,
        selfRenewableKwh,
        selfRenewableNullRows,
        estimatedKwh,
      });
    }
  }
  return computeRenewablesMetrics(edges);
}
