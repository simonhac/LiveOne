/**
 * Pure metric-attribution integrator — NO database, NO UI, NO domain knowledge.
 *
 * Companion to `computeFlowMatrix` (lib/aggregation/flow-matrix-core.ts): it runs the IDENTICAL
 * proportional allocation loop, but for each source→load contribution it also multiplies the energy
 * by that SOURCE's per-interval intensity (emissions gCO2/kWh, renewable fraction 0..1, price c/kWh)
 * and accumulates attributed emissions (g), renewable energy (kWh) and cost (c) per edge. Because the
 * energy loop is byte-identical, `energyKwh` here always equals `computeFlowMatrix`'s `matrix`.
 *
 * `sourceIntensities` is index-aligned to `sources`. Solar sources carry {0, 1, solarCost}; grid
 * carries the OE/Amber series; the battery carries the fold's blended output. A null intensity means
 * "unknown for this interval" — that contribution is left OUT of the attributed sum but its energy is
 * counted in `estimatedKwh` so the caller can report coverage/confidence and never present a biased
 * average as fact. The matching `*KnownKwh` denominators let a caller compute an unbiased average
 * intensity over only the energy whose intensity was known: avg = emissionsG / emissionsKnownKwh.
 */

import type { FlowSeries } from "@/lib/aggregation/flow-matrix-core";

/** Per-source, per-interval intensity series (index-aligned to `timestamps`; null = unknown). */
export interface SourceIntensity {
  /** gCO2 per kWh. */
  emissions: (number | null)[];
  /** Renewable fraction 0..1. */
  renewable: (number | null)[];
  /** Price in cents per kWh (may be negative). */
  price: (number | null)[];
  /** True where this source's intensity is provisional/estimated for the interval. */
  estimated: boolean[];
}

export interface FlowAttributionResult {
  sources: string[];
  loads: string[];
  /** [s][l] energy (kWh) — identical to computeFlowMatrix.matrix. */
  energyKwh: number[][];
  /** [s][l] attributed emissions (gCO2), summed over intervals with known emissions intensity. */
  emissionsG: number[][];
  /** [s][l] attributed renewable energy (kWh), over intervals with known renewable fraction. */
  renewableKwh: number[][];
  /** [s][l] attributed cost (cents), over intervals with known price. */
  costC: number[][];
  /** [s][l] energy (kWh) whose source intensity was estimated OR unknown (confidence denominator). */
  estimatedKwh: number[][];
  /** [s][l] energy (kWh) that had a known emissions intensity (avg-intensity denominator). */
  emissionsKnownKwh: number[][];
  /** [s][l] energy (kWh) that had a known renewable fraction. */
  renewableKnownKwh: number[][];
  /** [s][l] energy (kWh) that had a known price. */
  priceKnownKwh: number[][];
}

function zeros(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

/**
 * Integrate attributed metrics alongside the energy-flow matrix. Same left-endpoint source proportion
 * and trapezoidal load energy as `computeFlowMatrix`; intensities are read at the interval's LEFT
 * endpoint (index i), matching the proportion endpoint (a ≤5-minute alignment approximation for
 * slowly-varying grid signals).
 */
export function computeFlowAttribution(input: {
  timestamps: number[];
  sources: FlowSeries[];
  loads: FlowSeries[];
  /** Index-aligned to `sources`; null entry = a source with no intensity data (all contributions estimated). */
  sourceIntensities: (SourceIntensity | null)[];
}): FlowAttributionResult {
  const { timestamps, sources, loads, sourceIntensities } = input;
  const S = sources.length;
  const L = loads.length;

  const energyKwh = zeros(S, L);
  const emissionsG = zeros(S, L);
  const renewableKwh = zeros(S, L);
  const costC = zeros(S, L);
  const estimatedKwh = zeros(S, L);
  const emissionsKnownKwh = zeros(S, L);
  const renewableKnownKwh = zeros(S, L);
  const priceKnownKwh = zeros(S, L);

  for (let i = 0; i < timestamps.length - 1; i++) {
    const deltaHours = (timestamps[i + 1] - timestamps[i]) / (1000 * 60 * 60);

    let totalGenPower = 0;
    for (const source of sources) {
      const power = source.power[i];
      if (power !== null) totalGenPower += power;
    }
    if (totalGenPower <= 0) continue;

    for (let s = 0; s < S; s++) {
      const power1 = sources[s].power[i];
      const power2 = sources[s].power[i + 1];
      if (power1 === null || power2 === null) continue;

      const sourceProportion = power1 / totalGenPower;
      const si = sourceIntensities[s] ?? null;
      const ei = si ? si.emissions[i] : null;
      const rf = si ? si.renewable[i] : null;
      const pr = si ? si.price[i] : null;
      const est = si ? si.estimated[i] === true : true;

      for (let l = 0; l < L; l++) {
        const loadPower1 = loads[l].power[i];
        const loadPower2 = loads[l].power[i + 1];
        if (loadPower1 === null || loadPower2 === null) continue;

        const loadIntervalEnergy = ((loadPower1 + loadPower2) / 2) * deltaHours;
        const contribution = loadIntervalEnergy * sourceProportion;
        if (contribution === 0) continue;

        energyKwh[s][l] += contribution;

        if (ei !== null) {
          emissionsG[s][l] += contribution * ei;
          emissionsKnownKwh[s][l] += contribution;
        }
        if (rf !== null) {
          renewableKwh[s][l] += contribution * rf;
          renewableKnownKwh[s][l] += contribution;
        }
        if (pr !== null) {
          costC[s][l] += contribution * pr;
          priceKnownKwh[s][l] += contribution;
        }
        if (est || ei === null || rf === null || pr === null) {
          estimatedKwh[s][l] += contribution;
        }
      }
    }
  }

  return {
    sources: sources.map((s) => s.path),
    loads: loads.map((l) => l.path),
    energyKwh,
    emissionsG,
    renewableKwh,
    costC,
    estimatedKwh,
    emissionsKnownKwh,
    renewableKnownKwh,
    priceKnownKwh,
  };
}
