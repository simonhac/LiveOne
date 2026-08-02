/**
 * The run blend and the flow accounting must price the same kWh identically.
 *
 * 🛑 These are two implementations of one definition, and the only thing keeping them together is a
 * test that runs both. They drifted once already: the blend renormalised over the sources whose
 * intensity was KNOWN, then multiplied by the slice's whole energy — extrapolating the known prices
 * onto energy those sources never supplied. On prod that re-priced a flat-but-discharging battery's
 * share at the grid rate and made every affected run more expensive than the Sankey (measured
 * 2026-08-02: −$2.32 across 9 days).
 *
 * So the assertion here is not "the blend returns a plausible number" — it is the exact identity
 * against `computeFlowAccounting`, with a fixture that has an unpriceable source in it. The
 * `it("would catch the regression")` case exists to keep the fixture from going vacuous.
 */
import { describe, expect, it } from "@jest/globals";
import {
  computeFlowAccounting,
  type FlowSeries,
  type SourceIntensity,
} from "@/lib/aggregation/flow-matrix-core";
import { blendLoadIntensities } from "../intensity";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-06-04T10:00:00Z");
/** Four boundaries = three 5-minute intervals. */
const TIMELINE = [T0, T0 + 5 * MIN, T0 + 10 * MIN, T0 + 15 * MIN];

/** 2 kW of grid and 6 kW of battery, steady. */
const SOURCES: FlowSeries[] = [
  { path: "source.grid", power: [2, 2, 2, 2] },
  { path: "source.battery", power: [6, 6, 6, 6] },
];

/** The EV draws a metered 0.5 kWh per interval; the rest of the house is power-only. */
const EV_KWH = [0.5, 0.5, 0.5];
const LOADS: FlowSeries[] = [
  { path: "load.ev", power: [6, 6, 6, 6], energyKwh: EV_KWH },
  { path: "load.rest-of-house", power: [1, 1, 1, 1] },
];
const EV = 0;

/**
 * The battery is priced in interval 0 and UNPRICEABLE in intervals 1–2 — the empty-but-discharging
 * condition: real energy flowing, no blend to report.
 */
const INTENSITIES: (SourceIntensity | null)[] = [
  {
    price: [30, 30, 30],
    emissions: [700, 700, 700],
    renewable: [0.2, 0.2, 0.2],
    selfRenewable: [0, 0, 0],
    estimated: [false, false, false],
  },
  {
    price: [5, null, null],
    emissions: [100, null, null],
    renewable: [0.9, null, null],
    selfRenewable: [0.9, null, null],
    estimated: [false, false, false],
  },
];

/** What the accounting attributes to `load.ev`, summed over its source edges. */
function matrixTotals() {
  const acc = computeFlowAccounting({
    timestamps: TIMELINE,
    sources: SOURCES,
    loads: LOADS,
    sourceIntensities: INTENSITIES,
  });
  const col = (m: number[][]) => m.reduce((sum, row) => sum + row[EV], 0);
  return {
    energyKwh: col(acc.energyKwh),
    costC: col(acc.costC),
    emissionsG: col(acc.emissionsG),
    renewableKwh: col(acc.renewableKwh),
  };
}

/** What the run would accumulate: Σ sliceKwh × factor(interval), as `provenanceFromAllocation` does. */
function runTotals() {
  const steps = blendLoadIntensities(TIMELINE, SOURCES, LOADS, INTENSITIES);
  let costC = 0;
  let emissionsG = 0;
  let renewableKwh = 0;
  steps.forEach((f, i) => {
    if (f.priceC !== null) costC += EV_KWH[i] * f.priceC;
    if (f.gPerKwh !== null) emissionsG += EV_KWH[i] * f.gPerKwh;
    if (f.renewable !== null) renewableKwh += EV_KWH[i] * f.renewable;
  });
  return { costC, emissionsG, renewableKwh };
}

describe("run blend ↔ flow accounting parity", () => {
  it("prices a run's energy exactly as the Sankey prices the same kWh", () => {
    const matrix = matrixTotals();
    const run = runTotals();

    // The whole point: absolute totals, not per-kWh averages.
    expect(run.costC).toBeCloseTo(matrix.costC, 10);
    expect(run.emissionsG).toBeCloseTo(matrix.emissionsG, 10);
    expect(run.renewableKwh).toBeCloseTo(matrix.renewableKwh, 10);

    // And the accounting really did see all 1.5 kWh of it — the parity above is not two matching
    // zeroes, and the battery's unpriceable energy IS in the energy leg.
    expect(matrix.energyKwh).toBeCloseTo(1.5, 10);
  });

  it("would catch the regression it was written for", () => {
    // Guard against a vacuous fixture: the OLD arithmetic (renormalise over known sources only, then
    // multiply by the whole slice) must give a materially DIFFERENT — and higher — answer here. If
    // this ever stops differing, the fixture no longer contains an unpriceable source and the parity
    // assertion above has quietly stopped testing anything.
    const steps = blendLoadIntensities(TIMELINE, SOURCES, LOADS, INTENSITIES);
    const deltaHours = 5 / 60;
    let knownOnly = 0;
    for (let i = 0; i < 3; i++) {
      let num = 0;
      let den = 0;
      for (let s = 0; s < SOURCES.length; s++) {
        const w = SOURCES[s].power[i]! * deltaHours;
        const p = INTENSITIES[s]!.price[i];
        if (p !== null) {
          num += w * p;
          den += w;
        }
      }
      knownOnly += EV_KWH[i] * (num / den);
    }
    const aligned = steps.reduce(
      (sum, f, i) => sum + EV_KWH[i] * (f.priceC ?? 0),
      0,
    );
    expect(knownOnly).toBeGreaterThan(aligned * 1.5);
    expect(aligned).toBeCloseTo(matrixTotals().costC, 10);
  });

  it("is unchanged when every source has a known intensity", () => {
    // The common case must not move: with nothing unknown, the known-only denominator IS the whole
    // pool, so the aligned arithmetic and the old one coincide exactly.
    const allKnown: SourceIntensity[] = [
      INTENSITIES[0]!,
      {
        price: [5, 5, 5],
        emissions: [100, 100, 100],
        renewable: [0.9, 0.9, 0.9],
        selfRenewable: [0.9, 0.9, 0.9],
        estimated: [false, false, false],
      },
    ];
    const steps = blendLoadIntensities(TIMELINE, SOURCES, LOADS, allKnown);
    // 2 kW grid @30c + 6 kW battery @5c over an 8 kW pool = 11.25 c/kWh, every interval.
    for (const f of steps) {
      expect(f.priceC).toBeCloseTo(11.25, 10);
      expect(f.gPerKwh).toBeCloseTo(250, 10);
      expect(f.renewable).toBeCloseTo(0.725, 10);
    }
  });

  it("still reports absent, not zero, when no source can be priced", () => {
    const noneKnown: (SourceIntensity | null)[] = [null, null];
    const steps = blendLoadIntensities(TIMELINE, SOURCES, LOADS, noneKnown);
    for (const f of steps) {
      expect(f.priceC).toBeNull();
      expect(f.gPerKwh).toBeNull();
      expect(f.renewable).toBeNull();
    }
  });
});
