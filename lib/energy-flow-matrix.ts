import { ProcessedSiteData } from "./site-data-processor";
import {
  computeFlowMatrix,
  computeInstantFlowMatrix,
  FlowSeries,
} from "./aggregation/flow-matrix-core";
import { resolveSolarSources } from "./aggregation/flow-series";
import { getColorForPath } from "./chart-colors";

/**
 * Represents a source or load in the energy flow matrix
 */
export interface EnergyFlowNode {
  id: string;
  label: string;
  color: string;
}

/** Human label for a canonical solar path lacking an upstream-provided description. */
function solarLabel(stem: string): string {
  const prefix = "source.solar.";
  const ext = stem.startsWith(prefix) ? stem.slice(prefix.length) : "";
  return ext ? `Solar ${ext.charAt(0).toUpperCase()}${ext.slice(1)}` : "Solar";
}

/**
 * Energy flow matrix showing cumulative energy from each source to each load
 */
export interface EnergyFlowMatrix {
  // Metadata
  sources: EnergyFlowNode[];
  loads: EnergyFlowNode[];

  // Matrix data: [sourceIdx][loadIdx] = cumulative energy (kWh)
  matrix: number[][];

  // Totals
  sourceTotals: number[]; // Total energy from each source
  loadTotals: number[]; // Total energy to each load
  totalEnergy: number; // Grand total
}

/** One day's raw energy matrix, aligned to the shared {@link DailyFlowMatrices} node order. */
export interface DailyFlowMatrix {
  day: string; // system-local YYYY-MM-DD
  matrix: number[][]; // [sourceIdx][loadIdx] = that day's energy (kWh)
  // ── Metric legs — present ONLY for `source=modern` (from point_readings_flow_attr_1d). Same
  //    [sourceIdx][loadIdx] axes as `matrix`, and ADDITIVE over days like energy. `null` cell = the
  //    edge's intensity was unknown (or no flow) → excluded from that metric's average. `estimatedKwh`
  //    is the confidence denominator (energy attributed with an estimated/unknown intensity).
  emissionsG?: (number | null)[][]; // attributed gCO2
  renewableKwh?: (number | null)[][]; // attributed renewable energy (kWh)
  costC?: (number | null)[][]; // attributed cost (cents, signed)
  estimatedKwh?: number[][];
}

/**
 * The 30D Sankey payload: per-day energy matrices from `point_readings_flow_attr_1d`, served RAW (not
 * pre-summed). The node arrays are the union across the window so every day's matrix shares one
 * index order — the client sums them for the window view ({@link sumDailyFlowMatrices}) or picks
 * one day for the hovered view ({@link pickDailyFlowMatrix}).
 */
export interface DailyFlowMatrices {
  sources: EnergyFlowNode[];
  loads: EnergyFlowNode[];
  days: DailyFlowMatrix[];
  reason?: string; // why the result is empty (e.g. "not-materialized"), for the blank-Sankey copy
}

/** Build an {@link EnergyFlowMatrix} (with totals) from shared nodes + a dense [src][load] matrix. */
function matrixWithTotals(
  sources: EnergyFlowNode[],
  loads: EnergyFlowNode[],
  matrix: number[][],
): EnergyFlowMatrix {
  const sourceTotals = matrix.map((row) => row.reduce((sum, v) => sum + v, 0));
  const loadTotals = loads.map((_, l) =>
    matrix.reduce((sum, row) => sum + (row[l] ?? 0), 0),
  );
  const totalEnergy = sourceTotals.reduce((sum, v) => sum + v, 0);
  return { sources, loads, matrix, sourceTotals, loadTotals, totalEnergy };
}

/** Sum every day in the window into one energy matrix (the un-hovered 30D Sankey). */
export function sumDailyFlowMatrices(
  d: DailyFlowMatrices,
): EnergyFlowMatrix | null {
  if (d.days.length === 0) return null;
  const summed = d.sources.map((_, s) =>
    d.loads.map((_, l) =>
      d.days.reduce((sum, day) => sum + (day.matrix[s]?.[l] ?? 0), 0),
    ),
  );
  return matrixWithTotals(d.sources, d.loads, summed);
}

/** That single day's energy matrix (the hovered 30D Sankey), or null if the day isn't in range. */
export function pickDailyFlowMatrix(
  d: DailyFlowMatrices,
  ymd: string,
): EnergyFlowMatrix | null {
  const day = d.days.find((x) => x.day === ymd);
  if (!day) return null;
  return matrixWithTotals(d.sources, d.loads, day.matrix);
}

/** One source's contribution to a load over the window (for the solar/battery/grid split). */
export interface LoadSourceSplit {
  path: string;
  label: string;
  energyKwh: number;
}

/**
 * The per-load provenance summary over a `source=modern` window — the reduction behind
 * "over &lt;period&gt;: $X, Y% renewable, Z g/kWh, N% estimated". Client-side so it needs no second fetch
 * when the Sankey is already loaded.
 *
 * Averages use FILTERED denominators (the "known-intensity" kWh — energy on edges whose metric was
 * non-null), so estimated/unknown edges don't bias g/kWh or %renewable. `pctEstimated` is the confidence
 * chip: energy attributed with an estimated/unknown input over total energy.
 */
export interface LoadProvenanceSummary {
  loadPath: string;
  loadLabel: string;
  energyKwh: number;
  costC: number; // signed cents
  avgCentsPerKwh: number | null;
  pctRenewable: number | null; // 0..100
  avgGramsPerKwh: number | null;
  kgCo2: number;
  pctEstimated: number; // 0..100
  sources: LoadSourceSplit[]; // descending by energy, zero-energy sources dropped
}

/**
 * Reduce a `source=modern` {@link DailyFlowMatrices} to one load's provenance summary (summing across all
 * days and all sources). Returns null when the load isn't in the payload or the metric legs are absent
 * (i.e. a legacy payload). Additive over days by construction — same as the energy reducers.
 */
export function reduceLoadProvenance(
  d: DailyFlowMatrices,
  loadId: string,
): LoadProvenanceSummary | null {
  const loadIdx = d.loads.findIndex((l) => l.id === loadId);
  if (loadIdx < 0) return null;
  // Metric legs ride only on modern payloads; bail if the first day lacks them.
  if (d.days.length > 0 && d.days[0].emissionsG === undefined) return null;

  let energyKwh = 0;
  let emissionsG = 0;
  let emissionsKnownKwh = 0;
  let renewableKwh = 0;
  let renewableKnownKwh = 0;
  let costC = 0;
  let costKnownKwh = 0;
  let estimatedKwh = 0;
  const sourceEnergy = d.sources.map(() => 0);

  for (const day of d.days) {
    for (let s = 0; s < d.sources.length; s++) {
      const e = day.matrix[s]?.[loadIdx] ?? 0;
      if (e === 0) continue;
      energyKwh += e;
      sourceEnergy[s] += e;
      const eg = day.emissionsG?.[s]?.[loadIdx];
      if (eg != null) {
        emissionsG += eg;
        emissionsKnownKwh += e;
      }
      const rk = day.renewableKwh?.[s]?.[loadIdx];
      if (rk != null) {
        renewableKwh += rk;
        renewableKnownKwh += e;
      }
      const cc = day.costC?.[s]?.[loadIdx];
      if (cc != null) {
        costC += cc;
        costKnownKwh += e;
      }
      estimatedKwh += day.estimatedKwh?.[s]?.[loadIdx] ?? 0;
    }
  }

  const sources: LoadSourceSplit[] = d.sources
    .map((src, s) => ({
      path: src.id,
      label: src.label,
      energyKwh: sourceEnergy[s],
    }))
    .filter((x) => x.energyKwh > 0)
    .sort((a, b) => b.energyKwh - a.energyKwh);

  return {
    loadPath: loadId,
    loadLabel: d.loads[loadIdx].label,
    energyKwh,
    costC,
    avgCentsPerKwh: costKnownKwh > 0 ? costC / costKnownKwh : null,
    pctRenewable:
      renewableKnownKwh > 0 ? (100 * renewableKwh) / renewableKnownKwh : null,
    avgGramsPerKwh:
      emissionsKnownKwh > 0 ? emissionsG / emissionsKnownKwh : null,
    kgCo2: emissionsG / 1000,
    pctEstimated: energyKwh > 0 ? (100 * estimatedKwh) / energyKwh : 0,
    sources,
  };
}

/** A source node is solar iff its id is the bare parent or a `source.solar.<leaf>` (incl. `.residual`). */
function isSolarSourceId(id: string): boolean {
  return id === "source.solar" || id.startsWith("source.solar.");
}

/**
 * Collapse every solar source node (`source.solar`, per-array `source.solar.<leaf>`, and the synthetic
 * `source.solar.residual`) into a single "Solar" source — the "combine solar arrays" Sankey option.
 *
 * Pure `EnergyFlowMatrix → EnergyFlowMatrix`, applied client-side after matrix selection, so it works
 * uniformly for the 30D (summed/hovered) and 1D/7D (window/instant) matrices. The combined row is the
 * element-wise sum of the solar rows across loads, placed at the FIRST solar node's position; non-solar
 * sources keep their order; loads are untouched (column sums are invariant under summing rows, so every
 * load total is unchanged). No-op (returns the input) when there are 0 or 1 solar sources. `matrixWithTotals`
 * recomputes all totals, so they can't drift. Leaves `source.battery`/`load.battery` alone → composes with
 * the battery-middle layout (combine first, layout after).
 */
export function combineSolarSources(
  matrix: EnergyFlowMatrix,
): EnergyFlowMatrix {
  const solarIdx = matrix.sources
    .map((s, i) => (isSolarSourceId(s.id) ? i : -1))
    .filter((i) => i >= 0);
  if (solarIdx.length <= 1) return matrix; // nothing to combine

  const firstSolar = solarIdx[0];
  const solarSet = new Set(solarIdx);
  const loadCount = matrix.loads.length;

  const combined: EnergyFlowNode = {
    id: "source.solar",
    label: "Solar",
    // `getColorForPath` splits on "/" then ".", so a bare stem yields gray — pass the `/power` form to
    // get the canonical solar-primary yellow (mirrors colorForFlowPath, without the import cycle).
    color: getColorForPath("source.solar/power"),
  };

  const newSources: EnergyFlowNode[] = [];
  const newMatrix: number[][] = [];
  matrix.sources.forEach((src, i) => {
    if (i === firstSolar) {
      newSources.push(combined);
      const row = new Array<number>(loadCount).fill(0);
      for (const si of solarIdx) {
        for (let l = 0; l < loadCount; l++) row[l] += matrix.matrix[si][l] ?? 0;
      }
      newMatrix.push(row);
    } else if (!solarSet.has(i)) {
      newSources.push(src);
      newMatrix.push([...matrix.matrix[i]]);
    }
    // else: a non-first solar row — folded into `combined`
  });

  return matrixWithTotals(newSources, matrix.loads, newMatrix);
}

/** Node metadata + pure power/energy series ready for the flow-matrix core, plus the shared timestamps. */
interface PreparedFlowInputs {
  sources: EnergyFlowNode[];
  loads: EnergyFlowNode[];
  sourceSeries: FlowSeries[];
  loadSeries: FlowSeries[];
  timestamps: number[];
}

/**
 * Shared preparation for both the cumulative {@link calculateEnergyFlowMatrix} and the focused-point
 * {@link calculateInstantFlowMatrix}: validate, drop SoC series, resolve solar sources (per-array
 * leaves + synthetic residual, no double counting), and build node metadata + the pure `FlowSeries`
 * the core consumes. Returns null when there's nothing to diagram (missing generation OR load).
 */
function prepareFlowInputs(data: ProcessedSiteData): PreparedFlowInputs | null {
  // Validate input
  if (!data.generation || !data.load) {
    console.warn("Missing generation or load data");
    return null;
  }

  const { generation, load } = data;

  // Filter out SoC series (only use power/energy series)
  const generationPowerSeries = generation.series.filter(
    (s) => !s.seriesType || s.seriesType === "power",
  );
  const loadPowerSeries = load.series.filter(
    (s) => !s.seriesType || s.seriesType === "power",
  );

  if (
    generationPowerSeries.length === 0 ||
    loadPowerSeries.length === 0 ||
    generation.timestamps.length === 0
  ) {
    console.warn("Empty series or timestamps");
    return null;
  }

  // Resolve solar sources: prefer per-array leaves (source.solar.local/.remote/…) over the
  // bare total to avoid double counting, adding a synthetic `source.solar.residual` for any
  // unmetered shortfall (see lib/aggregation/flow-series.ts). Non-solar generation (battery
  // discharge, grid import) passes through unchanged, keeping its original order.
  const stemOfId = (id: string): string => id.split("/")[1] ?? id;

  const solarOriginalByStem = new Map<
    string,
    { id: string; description: string; color: string; data: (number | null)[] }
  >();
  const solarInput: FlowSeries[] = [];
  for (const series of generationPowerSeries) {
    if (!series.id.includes("source.solar")) continue;
    const stem = stemOfId(series.id);
    if (!solarOriginalByStem.has(stem)) solarOriginalByStem.set(stem, series);
    solarInput.push({ path: stem, power: series.data });
  }
  const resolvedSolar = resolveSolarSources(solarInput);

  // Rebuild the generation series list: non-solar in place; the resolved solar nodes inserted
  // where the first solar series appeared.
  const aggregatedGeneration: {
    id: string;
    description: string;
    color: string;
    data: (number | null)[];
  }[] = [];
  let solarInserted = false;
  for (const series of generationPowerSeries) {
    if (series.id.includes("source.solar")) {
      if (solarInserted) continue;
      solarInserted = true;
      for (const solar of resolvedSolar) {
        const original = solarOriginalByStem.get(solar.path);
        aggregatedGeneration.push({
          id: solar.path,
          description: original?.description ?? solarLabel(solar.path),
          color: original?.color ?? getColorForPath(solar.path),
          data: solar.power,
        });
      }
    } else {
      aggregatedGeneration.push({
        id: series.id,
        description: series.description,
        color: series.color,
        data: series.data,
      });
    }
  }

  // Extract source and load metadata (using filtered power series only).
  // The browser owns node identity/labels/colors; the pure core owns only the math.
  const sources: EnergyFlowNode[] = aggregatedGeneration.map((s) => ({
    id: s.id,
    label: s.description,
    color: s.color,
  }));

  const loads: EnergyFlowNode[] = loadPowerSeries.map((s) => ({
    id: s.id,
    label: s.description,
    color: s.color,
  }));

  // Identity is carried as `path`; results map back by index.
  const sourceSeries: FlowSeries[] = aggregatedGeneration.map((s) => ({
    path: s.id,
    power: s.data,
  }));
  const loadSeries: FlowSeries[] = loadPowerSeries.map((s) => ({
    path: s.id,
    power: s.data,
  }));

  return {
    sources,
    loads,
    sourceSeries,
    loadSeries,
    timestamps: generation.timestamps.map((t) => t.getTime()),
  };
}

/**
 * Calculate energy flow matrix from processed Mondo data
 *
 * For each time interval:
 * 1. Calculate the energy consumed by each load (trapezoidal integration)
 * 2. Distribute that energy proportionally across sources based on their
 *    instantaneous power contribution at that moment
 *
 * @param data Processed Mondo data containing both generation and load series
 * @returns Energy flow matrix with cumulative energy from each source to each load
 */
export function calculateEnergyFlowMatrix(
  data: ProcessedSiteData,
): EnergyFlowMatrix | null {
  const prepared = prepareFlowInputs(data);
  if (!prepared) return null;

  // Delegate the integration to the shared, pure core so this live path and the engine's daily
  // flow_attr rollup (lib/db/planetscale/battery-provenance-pg.ts) compute identical values by
  // construction.
  const result = computeFlowMatrix({
    timestamps: prepared.timestamps,
    sources: prepared.sourceSeries,
    loads: prepared.loadSeries,
  });

  return {
    sources: prepared.sources,
    loads: prepared.loads,
    matrix: result.matrix,
    sourceTotals: result.sourceTotals,
    loadTotals: result.loadTotals,
    totalEnergy: result.totalEnergy,
  };
}

/**
 * Flow matrix for a SINGLE focused sample (the hovered point) on the SUB-DAILY (1D/7D) charts —
 * the instantaneous POWER (kW) at that 5m/30m sample. Reuses the same node preparation as
 * {@link calculateEnergyFlowMatrix}, then snapshots the flow at `index` via
 * {@link computeInstantFlowMatrix}. Returns null when there's no complete flow or the index is out
 * of range. The 30D hover instead indexes a real per-day energy matrix from `flow_attr_1d` (see
 * {@link pickDailyFlowMatrix}); it does NOT use this power snapshot.
 */
export function calculateInstantFlowMatrix(
  data: ProcessedSiteData,
  index: number,
): EnergyFlowMatrix | null {
  const prepared = prepareFlowInputs(data);
  if (!prepared) return null;
  if (index < 0 || index >= prepared.timestamps.length) return null;

  const result = computeInstantFlowMatrix({
    sources: prepared.sourceSeries,
    loads: prepared.loadSeries,
    index,
  });

  return {
    sources: prepared.sources,
    loads: prepared.loads,
    matrix: result.matrix,
    sourceTotals: result.sourceTotals,
    loadTotals: result.loadTotals,
    totalEnergy: result.totalEnergy,
  };
}

/**
 * Pick the window energy-flow matrix for a sankey from the NON-materialized sources: the history
 * response's bundled matrix (1D/7D), else computed client-side from generation + load. The 30D
 * Sankey is served from the per-day flow_attr_1d matrices instead (see {@link sumDailyFlowMatrices} /
 * {@link pickDailyFlowMatrix}); this is its fallback when those aren't materialized.
 * Returns null when there is no complete flow to diagram (missing generation OR load) — the data-driven
 * gate for "this area has loads + sources". Extracted so every sankey site shares one precedence.
 */
export function selectFlowMatrix(
  processed: ProcessedSiteData,
): EnergyFlowMatrix | null {
  const { generation, load, flowMatrix } = processed;
  if (!generation || !load) return null;
  if (flowMatrix) return flowMatrix;
  return calculateEnergyFlowMatrix(processed);
}

/**
 * Log the energy flow matrix to console in a readable table format
 */
export function logEnergyFlowMatrix(matrix: EnergyFlowMatrix): void {
  console.log("\n" + "=".repeat(80));
  console.log("ENERGY FLOW MATRIX (kWh)");
  console.log("=".repeat(80) + "\n");

  // Calculate column widths
  const labelWidth = Math.max(...matrix.sources.map((s) => s.label.length), 12);
  const valueWidth = 10;

  // Header row
  const header = " ".repeat(labelWidth) + " │";
  matrix.loads.forEach((load) => {
    const label = load.label.substring(0, valueWidth - 1);
    header.concat(` ${label.padEnd(valueWidth - 1)}`);
  });
  console.log(
    header +
      matrix.loads
        .map((l) => l.label.substring(0, valueWidth - 1).padEnd(valueWidth))
        .join("") +
      "│ TOTAL",
  );

  console.log(
    "─".repeat(labelWidth) +
      "─┼" +
      "─".repeat(valueWidth * (matrix.loads.length + 1)),
  );

  // Data rows
  matrix.sources.forEach((source, s) => {
    const row = source.label.padEnd(labelWidth) + " │";
    const values = matrix.matrix[s]
      .map((val) => val.toFixed(2).padStart(valueWidth))
      .join("");
    const total = matrix.sourceTotals[s].toFixed(2).padStart(valueWidth);
    console.log(row + values + "│" + total);
  });

  // Separator
  console.log(
    "─".repeat(labelWidth) +
      "─┼" +
      "─".repeat(valueWidth * (matrix.loads.length + 1)),
  );

  // Total row
  const totalRow = "TOTAL".padEnd(labelWidth) + " │";
  const totalValues = matrix.loadTotals
    .map((val) => val.toFixed(2).padStart(valueWidth))
    .join("");
  const grandTotal = matrix.totalEnergy.toFixed(2).padStart(valueWidth);
  console.log(totalRow + totalValues + "│" + grandTotal);

  console.log("\n" + "=".repeat(80) + "\n");

  // Validation check
  // Note: With master load (path="load"), source totals may not equal load totals
  // due to system losses (inverter efficiency, battery roundtrip, etc.)
  // This is expected and not an error.
  const sourceSum = matrix.sourceTotals.reduce((a, b) => a + b, 0);
  const loadSum = matrix.loadTotals.reduce((a, b) => a + b, 0);
  const diff = Math.abs(sourceSum - loadSum);

  console.log(
    `📊 Energy flow: ${sourceSum.toFixed(2)} kWh generated → ${loadSum.toFixed(2)} kWh consumed`,
  );
  if (diff > 0.01) {
    const diffPercent = (diff / Math.max(sourceSum, loadSum)) * 100;
    console.log(
      `   Difference: ${diff.toFixed(2)} kWh (${diffPercent.toFixed(1)}%) - may include system losses`,
    );
  } else {
    console.log(`   ✓ Perfectly balanced (no apparent losses)`);
  }
}
