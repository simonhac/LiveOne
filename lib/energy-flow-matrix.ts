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
}

/**
 * The 30D Sankey payload: per-day energy matrices from `point_readings_flow_1d`, served RAW (not
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

  // Delegate the integration to the shared, pure core so this live path and the engine's
  // daily recompute (lib/db/planetscale/flow-matrix-pg.ts) compute identical values by
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
 * of range. The 30D hover instead indexes a real per-day energy matrix from `flow_1d` (see
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
 * Pick the window energy-flow matrix for a sankey from the NON-flow_1d sources: the history
 * response's bundled matrix (1D/7D), else computed client-side from generation + load. The 30D
 * Sankey is served from the per-day flow_1d matrices instead (see {@link sumDailyFlowMatrices} /
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
