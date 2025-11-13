import { ProcessedSiteData } from "./site-data-processor";

/**
 * Represents a source or load in the energy flow matrix
 */
export interface EnergyFlowNode {
  id: string;
  label: string;
  color: string;
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

  // Aggregate solar series into a single "Solar" source
  const solarSeriesIndices: number[] = [];
  const nonSolarSeries: typeof generationPowerSeries = [];

  generationPowerSeries.forEach((series, index) => {
    if (series.id.includes("source.solar")) {
      solarSeriesIndices.push(index);
    } else {
      nonSolarSeries.push(series);
    }
  });

  // Create aggregated solar data if we have multiple solar series
  const aggregatedGeneration = [...generationPowerSeries];
  let aggregatedSolarIndex = -1;

  if (solarSeriesIndices.length > 0) {
    // Get the first solar series as the base
    const firstSolarSeries = generationPowerSeries[solarSeriesIndices[0]];

    // Create aggregated solar series
    const aggregatedSolarData = firstSolarSeries.data.map((_, i) => {
      let sum = 0;
      let hasNull = false;

      for (const solarIdx of solarSeriesIndices) {
        const value = generationPowerSeries[solarIdx].data[i];
        if (value === null) {
          hasNull = true;
          break;
        }
        sum += value;
      }

      return hasNull ? null : sum;
    });

    // Replace first solar series with aggregated data
    aggregatedGeneration[solarSeriesIndices[0]] = {
      id: "source.solar",
      description: "Solar",
      color: firstSolarSeries.color, // Use first solar's color
      data: aggregatedSolarData,
    };

    aggregatedSolarIndex = solarSeriesIndices[0];

    // Remove other solar series (in reverse order to maintain indices)
    for (let i = solarSeriesIndices.length - 1; i > 0; i--) {
      aggregatedGeneration.splice(solarSeriesIndices[i], 1);
      // Adjust aggregated index if needed
      if (solarSeriesIndices[i] < aggregatedSolarIndex) {
        aggregatedSolarIndex--;
      }
    }
  }

  // Extract source and load metadata (using filtered power series only)
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

  // Initialize matrix with zeros
  const matrix: number[][] = Array(sources.length)
    .fill(0)
    .map(() => Array(loads.length).fill(0));

  const timestamps = generation.timestamps;

  // For each time interval, calculate energy and distribute proportionally
  for (let i = 0; i < timestamps.length - 1; i++) {
    // Calculate time delta in hours
    const time1 = timestamps[i].getTime();
    const time2 = timestamps[i + 1].getTime();
    const deltaHours = (time2 - time1) / (1000 * 60 * 60);

    // Calculate total generation power at this instant (using aggregated data)
    // Only count sources with non-null values
    let totalGenPower = 0;

    for (const sourceSeries of aggregatedGeneration) {
      const power = sourceSeries.data[i];
      if (power !== null) {
        totalGenPower += power;
      }
    }

    // Skip this interval if no generation
    if (totalGenPower <= 0) {
      continue;
    }

    // For each source, calculate its proportion and distribute to loads
    for (let s = 0; s < sources.length; s++) {
      const sourceSeries = aggregatedGeneration[s];
      const power1 = sourceSeries.data[i];
      const power2 = sourceSeries.data[i + 1];

      // Skip if either power value is null
      if (power1 === null || power2 === null) {
        continue;
      }

      // This source's proportion of total generation at this instant
      const sourceProportion = power1 / totalGenPower;

      // For each load, calculate energy and distribute proportionally
      for (let l = 0; l < loads.length; l++) {
        const loadSeries = loadPowerSeries[l];
        const loadPower1 = loadSeries.data[i];
        const loadPower2 = loadSeries.data[i + 1];

        // Skip if either power value is null
        if (loadPower1 === null || loadPower2 === null) {
          continue;
        }

        // Calculate energy for this load in this interval (trapezoidal rule)
        const loadIntervalEnergy = ((loadPower1 + loadPower2) / 2) * deltaHours;

        // Distribute this load's energy proportionally to this source
        matrix[s][l] += loadIntervalEnergy * sourceProportion;
      }
    }
  }

  // Calculate row and column totals
  const sourceTotals = matrix.map((row) =>
    row.reduce((sum, val) => sum + val, 0),
  );
  const loadTotals = Array(loads.length).fill(0);
  for (let l = 0; l < loads.length; l++) {
    for (let s = 0; s < sources.length; s++) {
      loadTotals[l] += matrix[s][l];
    }
  }

  const totalEnergy = sourceTotals.reduce((sum, val) => sum + val, 0);

  return {
    sources,
    loads,
    matrix,
    sourceTotals,
    loadTotals,
    totalEnergy,
  };
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
