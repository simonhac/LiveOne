import { describe, it, expect } from "@jest/globals";
import {
  computeFlowMatrix,
  FlowSeries,
} from "../../aggregation/flow-matrix-core";
import { computeBatteryProvenance } from "../compute";
import type { ProvenanceInputs } from "../types";

const HOUR = 60 * 60 * 1000;

/** A small charge-then-discharge scenario: solar+grid charge the battery, then it discharges to the EV. */
function scenario(): ProvenanceInputs {
  const base = Date.parse("2026-01-01T00:00:00Z");
  const n = 5;
  const timeline = Array.from({ length: n }, (_, i) => base + i * HOUR);
  const sources: FlowSeries[] = [
    { path: "source.solar", power: [8, 8, 0, 0, 0] },
    { path: "source.grid", power: [2, 2, 0, 0, 0] }, // import
    { path: "source.battery", power: [0, 0, 3, 3, 0] }, // discharge later
  ];
  const loads: FlowSeries[] = [
    { path: "load", power: [6, 6, 0, 0, 0] },
    { path: "load.battery", power: [4, 4, 0, 0, 0] }, // charge 4 kW while solar+grid on
    { path: "load.ev", power: [0, 0, 3, 3, 0] }, // EV drawn from battery discharge
  ];
  const arr = (v: number | null) => new Array<number | null>(n).fill(v);
  return {
    handle: 1,
    areaId: "test",
    region: "VIC1",
    timeline,
    sources,
    loads,
    gridEmissions: arr(600), // g/kWh
    gridEmissionsEstimated: new Array<boolean>(n).fill(false),
    gridRenewable: arr(0.25),
    gridPrice: arr(30),
    gridPriceEstimated: new Array<boolean>(n).fill(false),
    gridExportPrice: arr(5),
    soc: [50, 80, 60, 20, 8],
    estReservePct: 10,
    coverage: { soc: 1, emissions: 1, price: 1 },
  };
}

describe("computeBatteryProvenance", () => {
  it("its energy leg equals computeFlowMatrix (intensities don't change energy)", () => {
    const inputs = scenario();
    const result = computeBatteryProvenance(inputs, { efficiency: 0.9 });
    const energy = computeFlowMatrix({
      timestamps: inputs.timeline,
      sources: inputs.sources,
      loads: inputs.loads,
    });
    for (let s = 0; s < inputs.sources.length; s++)
      for (let l = 0; l < inputs.loads.length; l++)
        expect(result.accounting.energyKwh[s][l]).toBeCloseTo(
          energy.matrix[s][l],
          9,
        );
  });

  it("battery renewable fraction stays in [0,1] under η<1 (golden guard)", () => {
    const result = computeBatteryProvenance(scenario(), { efficiency: 0.9 });
    for (const s of result.steps) {
      if (s.batteryRenewableFraction !== null) {
        expect(s.batteryRenewableFraction).toBeGreaterThanOrEqual(0);
        expect(s.batteryRenewableFraction).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("carbon conservation identity holds (charged = vended + unattributed + stored)", () => {
    const result = computeBatteryProvenance(scenario(), { efficiency: 0.9 });
    let foldVendedG = 0;
    for (const s of result.steps)
      foldVendedG += s.dischargedKwh * (s.batteryEmissionsIntensity ?? 0);
    const residual =
      result.chargedG -
      (foldVendedG +
        result.finalState.unattribLossG +
        result.finalState.carbonG);
    expect(Math.abs(residual)).toBeLessThan(1e-6);
  });

  it("prefers an exact energy register over power integration when provided", () => {
    const inputs = scenario();
    // Force the battery-charge total via an energy register (exact); split ratio kept from the allocation.
    inputs.batteryChargeEnergyKwh = [10, 0, 0, 0, 0]; // 10 kWh charged in interval 0
    const result = computeBatteryProvenance(inputs, { efficiency: 1 });
    // With 10 kWh charged (η=1) and ~6 kWh discharged, the store never empties → capacity ~10.
    expect(result.chargeKwh).toBeGreaterThan(9);
  });
});
