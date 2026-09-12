import { describe, it, expect } from "@jest/globals";
import {
  computeFlowMatrix,
  FlowSeries,
} from "../../aggregation/flow-matrix-core";
import { computeBatteryProvenance } from "../compute";
import type { ProvenanceInputs } from "../types";

import { certifyWarmInputs } from "../types";
/** Fixtures are hand-built to start at a fold anchor; the brand asks that we say so. */
const warm = (i: ProvenanceInputs) => certifyWarmInputs(i, "test fixture");

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
    batterySystemId: 6,
    timezoneOffsetMin: 600,
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
    const result = computeBatteryProvenance(warm(inputs), { efficiency: 0.9 });
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

  it("self-renewable leg: solar full, grid zero, battery ≤ renewable (joint attribute wired)", () => {
    const inputs = scenario();
    const result = computeBatteryProvenance(warm(inputs), { efficiency: 1 });
    const acc = result.accounting;
    const si = (p: string) => inputs.sources.findIndex((s) => s.path === p);
    const solar = si("source.solar");
    const grid = si("source.grid");
    const battery = si("source.battery");
    for (let l = 0; l < inputs.loads.length; l++) {
      // Grid is never behind-the-meter → self-renewable is exactly 0 on every grid edge.
      expect(acc.selfRenewableKwh[grid][l]).toBeCloseTo(0, 9);
      // Solar is fully self-renewable (== its renewable leg, since renewable fraction is 1).
      expect(acc.selfRenewableKwh[solar][l]).toBeCloseTo(
        acc.renewableKwh[solar][l],
        9,
      );
      // The battery blend's self-renewable can never exceed its renewable leg (Qsr ≤ Qr).
      expect(acc.selfRenewableKwh[battery][l]).toBeLessThanOrEqual(
        acc.renewableKwh[battery][l] + 1e-9,
      );
    }
    // The battery charged from solar+grid, so its discharge to the EV carries SOME (but not all) of its
    // energy as self-renewable — the solar share only.
    const evL = inputs.loads.findIndex((x) => x.path === "load.ev");
    expect(acc.selfRenewableKwh[battery][evL]).toBeGreaterThan(0);
    expect(acc.selfRenewableKwh[battery][evL]).toBeLessThan(
      acc.energyKwh[battery][evL],
    );
  });

  it("battery renewable fraction stays in [0,1] under η<1 (golden guard)", () => {
    const result = computeBatteryProvenance(warm(scenario()), {
      efficiency: 0.9,
    });
    for (const s of result.steps) {
      if (s.batteryRenewableFraction !== null) {
        expect(s.batteryRenewableFraction).toBeGreaterThanOrEqual(0);
        expect(s.batteryRenewableFraction).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("carbon conservation identity holds (charged + sync = vended + unattributed + stored)", () => {
    const result = computeBatteryProvenance(warm(scenario()), {
      efficiency: 0.9,
    });
    let foldVendedG = 0;
    for (const s of result.steps)
      foldVendedG += s.dischargedKwh * (s.batteryEmissionsIntensity ?? 0);
    // The SoC-anchor sync is a distinct, signed, auditable category (see fold.ts): the identity is
    // `chargedG + syncG == vendedG + unattribLossG + carbonG`.
    const residual =
      result.chargedG +
      result.finalState.syncG -
      (foldVendedG +
        result.finalState.unattribLossG +
        result.finalState.carbonG);
    expect(Math.abs(residual)).toBeLessThan(1e-6);
  });

  /**
   * 🛑 `gridExportPrice` is the MEASURED series in the RAW convention — Amber's feedIn `perKwh`, which
   * is NEGATIVE when money comes IN. These two tests pin the sign down in the only way that cannot be
   * misread: they assert on which direction the money was actually flowing, not on the sign of a
   * number. Their expectations were the exact opposite of this until 2026-09, which is how
   * `price-opportunity` stayed inverted for two years with a green suite.
   */
  it("accrues forgone export revenue when you WOULD HAVE BEEN PAID to export (raw negative)", () => {
    // raw −3 ⇒ a receipt of +3 c/kWh: storing this solar gave up 3 c/kWh of real income, so the
    // forgone pool must grow. Negative IMPORT prices are real money too and must NOT clamp — the
    // actual cost basis goes negative from the grid-charge share, independently.
    const inputs = scenario();
    const n = inputs.timeline.length;
    inputs.gridExportPrice = new Array<number | null>(n).fill(-3);
    inputs.gridPrice = new Array<number | null>(n).fill(-10);
    const result = computeBatteryProvenance(warm(inputs), { efficiency: 1 });
    expect(result.finalState.forgoneC).toBeGreaterThan(0);
    expect(result.finalState.costC).toBeLessThan(0);
  });

  it("clamps the forgone term at 0 when exporting would have COST you money (raw positive)", () => {
    // scenario() sets raw +5 ⇒ a receipt of −5 c/kWh: you would have PAID 5 c/kWh to export, so the
    // counterfactual to storing solar is curtailment and nothing was forgone.
    const inputs = scenario();
    const result = computeBatteryProvenance(warm(inputs), { efficiency: 1 });
    expect(result.finalState.forgoneC).toBeCloseTo(0, 9);
  });

  it("keeps forgone at 0 where no export rate is bound at all (null series)", () => {
    // No feed-in tariff is not a zero-revenue tariff, but for THIS accumulator they coincide: there
    // is no knowable income to have forgone. `?? 0` in solarCostOpp is what makes it explicit.
    const inputs = scenario();
    const n = inputs.timeline.length;
    inputs.gridExportPrice = new Array<number | null>(n).fill(null);
    const result = computeBatteryProvenance(warm(inputs), { efficiency: 1 });
    expect(result.finalState.forgoneC).toBeCloseTo(0, 9);
  });

  it("prefers an exact energy register over power integration when provided", () => {
    const inputs = scenario();
    // Force the battery-charge magnitude via the exact-energy overlay (`FlowSeries.energyKwh`,
    // per-interval: energyKwh[i] covers (t[i], t[i+1]]) — 10 kWh charged in interval 0, exact
    // zeros elsewhere. extractBatteryFlows must take these over the trapezoid.
    const batteryLoad = inputs.loads.find((l) => l.path === "load.battery")!;
    batteryLoad.energyKwh = [10, 0, 0, 0];
    const result = computeBatteryProvenance(warm(inputs), { efficiency: 1 });
    // With 10 kWh charged (η=1) and ~6 kWh discharged, the store never empties → capacity ~10.
    expect(result.chargeKwh).toBeGreaterThan(9);
  });
});
