import { ProcessedSiteData } from "./site-data-processor";
import { computeFlowMatrix, FlowSeries } from "./aggregation/flow-matrix-core";
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

  // Delegate the integration to the shared, pure core so this live path and the engine's
  // daily recompute (lib/db/planetscale/flow-matrix-pg.ts) compute identical values by
  // construction. Identity is carried as `path`; results map back by index.
  const sourceSeries: FlowSeries[] = aggregatedGeneration.map((s) => ({
    path: s.id,
    power: s.data,
  }));
  const loadSeries: FlowSeries[] = loadPowerSeries.map((s) => ({
    path: s.id,
    power: s.data,
  }));

  const result = computeFlowMatrix({
    timestamps: generation.timestamps.map((t) => t.getTime()),
    sources: sourceSeries,
    loads: loadSeries,
  });

  return {
    sources,
    loads,
    matrix: result.matrix,
    sourceTotals: result.sourceTotals,
    loadTotals: result.loadTotals,
    totalEnergy: result.totalEnergy,
  };
}

/**
 * Pick the energy-flow matrix for a sankey from the available sources, in priority order:
 *   1. the materialized PG flow_1d matrix (30D only, when FLOW_MATRIX_SERVE_FROM_PG is on),
 *   2. the history response's bundled matrix (1D/7D),
 *   3. compute it client-side from generation + load.
 * Returns null when there is no complete flow to diagram (missing generation OR load) — the data-driven
 * gate for "this area has loads + sources". Extracted so every sankey site shares one precedence.
 */
export function selectFlowMatrix(opts: {
  processed: ProcessedSiteData;
  pgFlowMatrix: EnergyFlowMatrix | null;
  serveFlowFromPg: boolean;
  period: "1D" | "7D" | "30D";
}): EnergyFlowMatrix | null {
  const { generation, load, flowMatrix } = opts.processed;
  if (!generation || !load) return null;
  const usePg = opts.serveFlowFromPg && opts.period === "30D";
  if (usePg && opts.pgFlowMatrix) return opts.pgFlowMatrix;
  if (flowMatrix) return flowMatrix;
  return calculateEnergyFlowMatrix(opts.processed);
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
