/**
 * Pure energy-flow matrix integrator — NO database, NO UI, NO domain knowledge.
 *
 * Given source and load POWER series sampled at shared timestamps, it integrates each
 * load's energy per interval (trapezoidal rule) and allocates that energy across sources
 * in proportion to each source's instantaneous share of total generation, accumulating
 * into cumulative kWh.
 *
 * Two properties this module is built around:
 *  1. Energy is ADDITIVE across intervals — so the matrix of a concatenated window equals
 *     the element-wise SUM of the matrices of its sub-windows. This is what makes a monthly
 *     flow matrix a plain sum of daily flow matrices.
 *  2. Direction must already be resolved in the INPUTS — battery charge / grid export are
 *     supplied as separate non-negative LOAD series, discharge / import as non-negative
 *     SOURCE series. Splitting a signed bidirectional series and computing rest-of-house are
 *     domain concerns owned by the callers, not this integrator.
 *
 * Shared by the browser adapter (`lib/energy-flow-matrix.ts`) and the engine's daily
 * recompute (`lib/db/planetscale/flow-matrix-pg.ts`) so both compute identical values by
 * construction — the same discipline as `lib/aggregation/point-aggregates.ts`.
 */

export interface FlowSeries {
  /** Stable canonical identity, e.g. "source.solar" | "load.rest-of-house". */
  path: string;
  /** Power at each timestamp (same length/order as `timestamps`); null = no datum. */
  power: (number | null)[];
}

export interface FlowMatrixResult {
  sources: string[]; // source paths, in input order
  loads: string[]; // load paths, in input order
  matrix: number[][]; // [sourceIdx][loadIdx] = cumulative energy (kWh), always >= 0
  sourceTotals: number[]; // row sums
  loadTotals: number[]; // column sums
  totalEnergy: number; // grand total
  intervalsUsed: number; // # of intervals that contributed energy (coverage signal)
}

/**
 * Integrate a source→load energy-flow matrix from instantaneous power series.
 *
 * Requires at least one source and one load. With fewer than two timestamps the integration
 * loop simply doesn't run and a zero matrix is returned (matching the previous behaviour).
 *
 * The allocation deliberately uses the LEFT endpoint power for the source proportion while
 * integrating the load energy trapezoidally — this is the long-standing behaviour and is kept
 * byte-identical here; at 5-minute resolution the difference is negligible. (Tracked as a
 * latent inconsistency to revisit with its own behaviour-changing test.)
 */
export function computeFlowMatrix(input: {
  timestamps: number[]; // epoch ms, ascending; one per power sample
  sources: FlowSeries[];
  loads: FlowSeries[];
}): FlowMatrixResult {
  const { timestamps, sources, loads } = input;

  const matrix: number[][] = Array.from({ length: sources.length }, () =>
    new Array<number>(loads.length).fill(0),
  );
  let intervalsUsed = 0;

  for (let i = 0; i < timestamps.length - 1; i++) {
    const deltaHours = (timestamps[i + 1] - timestamps[i]) / (1000 * 60 * 60);

    // Total instantaneous generation at the interval's left endpoint (non-null sources only).
    let totalGenPower = 0;
    for (const source of sources) {
      const power = source.power[i];
      if (power !== null) totalGenPower += power;
    }

    // No generation in this interval → nothing to allocate.
    if (totalGenPower <= 0) continue;

    let contributed = false;
    for (let s = 0; s < sources.length; s++) {
      const power1 = sources[s].power[i];
      const power2 = sources[s].power[i + 1];
      if (power1 === null || power2 === null) continue;

      const sourceProportion = power1 / totalGenPower;

      for (let l = 0; l < loads.length; l++) {
        const loadPower1 = loads[l].power[i];
        const loadPower2 = loads[l].power[i + 1];
        if (loadPower1 === null || loadPower2 === null) continue;

        const loadIntervalEnergy = ((loadPower1 + loadPower2) / 2) * deltaHours;
        const contribution = loadIntervalEnergy * sourceProportion;
        matrix[s][l] += contribution;
        if (contribution !== 0) contributed = true;
      }
    }
    if (contributed) intervalsUsed++;
  }

  const sourceTotals = matrix.map((row) => row.reduce((sum, v) => sum + v, 0));
  const loadTotals = new Array<number>(loads.length).fill(0);
  for (let l = 0; l < loads.length; l++) {
    for (let s = 0; s < sources.length; s++) {
      loadTotals[l] += matrix[s][l];
    }
  }
  const totalEnergy = sourceTotals.reduce((sum, v) => sum + v, 0);

  return {
    sources: sources.map((s) => s.path),
    loads: loads.map((l) => l.path),
    matrix,
    sourceTotals,
    loadTotals,
    totalEnergy,
    intervalsUsed,
  };
}

/**
 * Snapshot of the source→load flow at a SINGLE sample (no integration). At the given `index` it
 * allocates each load's instantaneous value across sources in proportion to each source's share of
 * total generation at that same sample — the same proportional rule {@link computeFlowMatrix} uses
 * per interval, but on the raw sample value rather than trapezoidal energy.
 *
 * The unit of the result is the unit of the input series at that sample: POWER (kW) for the 5m/30m
 * charts, or that day's ENERGY (kWh) for the 1d (30D) chart. Same `FlowMatrixResult` shape, with
 * row/column sums for the node totals, so it drops straight into the same sankey renderer.
 */
export function computeInstantFlowMatrix(input: {
  sources: FlowSeries[];
  loads: FlowSeries[];
  index: number;
}): FlowMatrixResult {
  const { sources, loads, index } = input;

  const matrix: number[][] = Array.from({ length: sources.length }, () =>
    new Array<number>(loads.length).fill(0),
  );
  let intervalsUsed = 0;

  let totalGenPower = 0;
  for (const source of sources) {
    const power = source.power[index];
    if (power !== null && power !== undefined) totalGenPower += power;
  }

  if (totalGenPower > 0) {
    let contributed = false;
    for (let s = 0; s < sources.length; s++) {
      const sourcePower = sources[s].power[index];
      if (sourcePower === null || sourcePower === undefined) continue;
      const sourceProportion = sourcePower / totalGenPower;

      for (let l = 0; l < loads.length; l++) {
        const loadPower = loads[l].power[index];
        if (loadPower === null || loadPower === undefined) continue;
        const contribution = loadPower * sourceProportion;
        matrix[s][l] += contribution;
        if (contribution !== 0) contributed = true;
      }
    }
    if (contributed) intervalsUsed = 1;
  }

  const sourceTotals = matrix.map((row) => row.reduce((sum, v) => sum + v, 0));
  const loadTotals = new Array<number>(loads.length).fill(0);
  for (let l = 0; l < loads.length; l++) {
    for (let s = 0; s < sources.length; s++) {
      loadTotals[l] += matrix[s][l];
    }
  }
  const totalEnergy = sourceTotals.reduce((sum, v) => sum + v, 0);

  return {
    sources: sources.map((s) => s.path),
    loads: loads.map((l) => l.path),
    matrix,
    sourceTotals,
    loadTotals,
    totalEnergy,
    intervalsUsed,
  };
}
