import { describe, it, expect } from "@jest/globals";
import {
  foldBatteryProvenance,
  foldStep,
  FoldInterval,
  FoldConfig,
  INITIAL_FOLD_STATE,
} from "../fold";

const CONFIG: FoldConfig = { reserveFloorPct: 10 };

/** Build a FoldInterval with inert defaults (no charge/discharge, mid SoC, no grid inputs). */
function iv(partial: Partial<FoldInterval>): FoldInterval {
  return {
    solarChargeKwh: 0,
    gridChargeKwh: 0,
    otherChargeKwh: 0,
    dischargeKwh: 0,
    gridEmissionsIntensity: null,
    gridRenewableFraction: null,
    gridPrice: null,
    solarCost: 0,
    socPct: 50,
    gridEstimated: false,
    ...partial,
  };
}

const vendedCarbon = (
  steps: ReturnType<typeof foldBatteryProvenance>["steps"],
) =>
  steps.reduce(
    (sum, s) => sum + s.dischargedKwh * (s.batteryEmissionsIntensity ?? 0),
    0,
  );
const vendedRenewable = (
  steps: ReturnType<typeof foldBatteryProvenance>["steps"],
) =>
  steps.reduce(
    (sum, s) => sum + s.dischargedKwh * (s.batteryRenewableFraction ?? 0),
    0,
  );
const vendedCost = (steps: ReturnType<typeof foldBatteryProvenance>["steps"]) =>
  steps.reduce((sum, s) => sum + s.dischargedKwh * (s.batteryPrice ?? 0), 0);

describe("foldBatteryProvenance", () => {
  describe("basic mixing", () => {
    it("solar-only charge vends 0 emissions, 100% renewable, solarCost price", () => {
      const { steps } = foldBatteryProvenance(
        [
          iv({ solarChargeKwh: 5, solarCost: 0, socPct: 80 }),
          iv({ dischargeKwh: 2, socPct: 60 }),
        ],
        CONFIG,
      );
      expect(steps[1].batteryEmissionsIntensity).toBeCloseTo(0, 9);
      expect(steps[1].batteryRenewableFraction).toBeCloseTo(1, 9);
      expect(steps[1].batteryPrice).toBeCloseTo(0, 9);
      expect(steps[1].estimatedFraction).toBe(0);
    });

    it("blends two charge sources by energy weight", () => {
      // 5 kWh solar (0 g) + 5 kWh grid (600 g/kWh) → 300 g/kWh blend.
      const { steps } = foldBatteryProvenance(
        [
          iv({ solarChargeKwh: 5, socPct: 50 }),
          iv({
            gridChargeKwh: 5,
            gridEmissionsIntensity: 600,
            gridRenewableFraction: 0.5,
            gridPrice: 40,
            socPct: 70,
          }),
          iv({ dischargeKwh: 1, socPct: 65 }),
        ],
        CONFIG,
      );
      // blend = (5*0 + 5*600)/10 = 300; renewable = (5*1 + 5*0.5)/10 = 0.75; price = (5*0 + 5*40)/10 = 20
      expect(steps[2].batteryEmissionsIntensity).toBeCloseTo(300, 6);
      expect(steps[2].batteryRenewableFraction).toBeCloseTo(0.75, 6);
      expect(steps[2].batteryPrice).toBeCloseTo(20, 6);
    });
  });

  describe("conservation (fully-discharged segment)", () => {
    it("vends exactly the carbon / renewable / cost that was charged in", () => {
      const intervals = [
        iv({
          gridChargeKwh: 10,
          gridEmissionsIntensity: 500,
          gridRenewableFraction: 0.2,
          gridPrice: 30,
          socPct: 80,
        }),
        iv({ dischargeKwh: 3, socPct: 60 }),
        iv({ dischargeKwh: 3, socPct: 40 }),
        iv({ dischargeKwh: 3, socPct: 25 }),
        iv({ dischargeKwh: 3, socPct: 15 }), // 1 kWh left → dEff = 1
      ];
      const { steps, finalState } = foldBatteryProvenance(intervals, CONFIG);
      expect(vendedCarbon(steps)).toBeCloseTo(10 * 500, 4); // 5000 g charged
      expect(vendedRenewable(steps)).toBeCloseTo(10 * 0.2, 6); // 2 kWh
      expect(vendedCost(steps)).toBeCloseTo(10 * 30, 5); // 300 c
      expect(finalState.storedKwh).toBeCloseTo(0, 9);
    });
  });

  describe("composability = bounded re-fold correctness", () => {
    it("folding in one pass == folding a prefix then continuing from carried state", () => {
      const intervals = [
        iv({
          gridChargeKwh: 4,
          gridEmissionsIntensity: 700,
          gridRenewableFraction: 0.1,
          gridPrice: 50,
          socPct: 40,
        }),
        iv({ solarChargeKwh: 3, socPct: 70 }),
        iv({ dischargeKwh: 2, socPct: 60 }),
        iv({
          gridChargeKwh: 2,
          gridEmissionsIntensity: 200,
          gridRenewableFraction: 0.8,
          gridPrice: 5,
          socPct: 75,
        }),
        iv({ dischargeKwh: 5, socPct: 30 }),
      ];
      const all = foldBatteryProvenance(intervals, CONFIG);
      for (let k = 1; k < intervals.length; k++) {
        const first = foldBatteryProvenance(intervals.slice(0, k), CONFIG);
        const second = foldBatteryProvenance(
          intervals.slice(k),
          CONFIG,
          first.finalState,
        );
        expect([...first.steps, ...second.steps]).toEqual(all.steps);
        expect(second.finalState).toEqual(all.finalState);
      }
    });
  });

  describe("repair convergence", () => {
    it("re-folding a segment with healed (known) inputs matches folding known inputs from the start", () => {
      const known = [
        iv({
          gridChargeKwh: 6,
          gridEmissionsIntensity: 450,
          gridRenewableFraction: 0.3,
          gridPrice: 25,
          socPct: 60,
        }),
        iv({ dischargeKwh: 2, socPct: 50 }),
        iv({ dischargeKwh: 2, socPct: 40 }),
      ];
      // Provisional version: same energies, but the grid inputs arrived `estimated`.
      const provisional = known.map((x, i) =>
        i === 0 ? { ...x, gridEstimated: true } : x,
      );
      const groundTruth = foldBatteryProvenance(known, CONFIG);
      const provisionalRun = foldBatteryProvenance(provisional, CONFIG);
      // Provisional flags the blend as estimated...
      expect(provisionalRun.steps[1].estimatedFraction).toBeGreaterThan(0);
      // ...but the PHYSICAL blend values are identical (same energies + intensities)...
      for (let i = 0; i < known.length; i++) {
        expect(provisionalRun.steps[i].batteryEmissionsIntensity).toBe(
          groundTruth.steps[i].batteryEmissionsIntensity,
        );
      }
      // ...and re-folding with healed inputs reproduces ground truth exactly (incl. estimatedFraction 0).
      const healed = foldBatteryProvenance(known, CONFIG);
      expect(healed.steps).toEqual(groundTruth.steps);
      expect(healed.steps.every((s) => s.estimatedFraction === 0)).toBe(true);
    });
  });

  describe("provenance stickiness", () => {
    it("an estimated charge taints only downstream-in-segment intervals, cleared by a reset", () => {
      const intervals = [
        iv({ solarChargeKwh: 5, socPct: 50 }), // clean
        iv({ dischargeKwh: 1, socPct: 45 }), // before taint → 0
        iv({
          gridChargeKwh: 5,
          gridEstimated: true,
          gridEmissionsIntensity: 400,
          gridRenewableFraction: 0.1,
          gridPrice: 20,
          socPct: 60,
        }),
        iv({ dischargeKwh: 1, socPct: 55 }), // after taint → > 0
        iv({ dischargeKwh: 20, socPct: 8 }), // drains, SoC hits floor (8 <= 10) → latch reset
        iv({ solarChargeKwh: 5, socPct: 40 }), // reset applied here → clean again
        iv({ dischargeKwh: 1, socPct: 35 }), // after reset → 0
      ];
      const { steps } = foldBatteryProvenance(intervals, CONFIG);
      expect(steps[1].estimatedFraction).toBe(0); // pre-taint
      expect(steps[3].estimatedFraction).toBeGreaterThan(0); // post-taint
      expect(steps[4].resetHere).toBe(true); // battery emptied → reset at the bottom-out
      expect(steps[4].resetTrigger).toBe("empty");
      expect(steps[6].estimatedFraction).toBe(0); // post-reset clean
    });
  });

  describe("best-effort monotonic improvement", () => {
    it("estimatedFraction is non-increasing as inputs finalize (estimated → known)", () => {
      const build = (estimated: boolean) =>
        foldBatteryProvenance(
          [
            iv({
              gridChargeKwh: 5,
              gridEstimated: estimated,
              gridEmissionsIntensity: 300,
              gridRenewableFraction: 0.4,
              gridPrice: 15,
              socPct: 60,
            }),
            iv({ dischargeKwh: 2, socPct: 50 }),
            iv({ dischargeKwh: 2, socPct: 40 }),
          ],
          CONFIG,
        );
      const provisional = build(true);
      const finalized = build(false);
      for (let i = 0; i < provisional.steps.length; i++) {
        expect(finalized.steps[i].estimatedFraction).toBeLessThanOrEqual(
          provisional.steps[i].estimatedFraction + 1e-12,
        );
      }
    });
  });

  describe("guards & edge cases", () => {
    it("never discharges more than is stored (E floored at 0)", () => {
      const { steps, finalState } = foldBatteryProvenance(
        [
          iv({ solarChargeKwh: 3, socPct: 50 }),
          iv({ dischargeKwh: 10, socPct: 20 }), // asks for 10, only 3 available
          iv({ dischargeKwh: 5, socPct: 15 }), // empty → vends nothing
        ],
        CONFIG,
      );
      expect(steps[1].dischargedKwh).toBeCloseTo(3, 9);
      expect(steps[2].dischargedKwh).toBe(0);
      expect(steps[2].batteryEmissionsIntensity).toBeNull(); // empty store
      expect(finalState.storedKwh).toBeCloseTo(0, 9);
    });

    it("carries a negative charge price through to a negative vended price", () => {
      const { steps } = foldBatteryProvenance(
        [
          iv({
            gridChargeKwh: 4,
            gridEmissionsIntensity: 100,
            gridRenewableFraction: 0.9,
            gridPrice: -8,
            socPct: 60,
          }),
          iv({ dischargeKwh: 2, socPct: 50 }),
        ],
        CONFIG,
      );
      expect(steps[1].batteryPrice).toBeCloseTo(-8, 9);
    });

    it("otherCharge (unknown provenance) grows the store but taints it and adds no carbon", () => {
      const { steps, finalState } = foldBatteryProvenance(
        [
          iv({ otherChargeKwh: 5, socPct: 50 }),
          iv({ dischargeKwh: 2, socPct: 40 }),
        ],
        CONFIG,
      );
      expect(finalState.storedKwh).toBeGreaterThan(0);
      expect(steps[1].estimatedFraction).toBeCloseTo(1, 9);
      expect(steps[1].batteryEmissionsIntensity).toBeCloseTo(0, 9);
    });

    it("lazy reset: reserve discharge below the floor still vends the real blend", () => {
      const { steps } = foldBatteryProvenance(
        [
          iv({
            gridChargeKwh: 10,
            gridEmissionsIntensity: 500,
            gridRenewableFraction: 0.2,
            gridPrice: 30,
            socPct: 80,
          }),
          iv({ dischargeKwh: 2, socPct: 8 }), // SoC hit floor, but still discharging reserve
        ],
        CONFIG,
      );
      // The reserve discharge vends the accumulated 500 g/kWh, NOT a fabricated null.
      expect(steps[1].batteryEmissionsIntensity).toBeCloseTo(500, 6);
      expect(steps[1].resetHere).toBe(false); // reset is deferred to the next charge
    });
  });

  describe("determinism", () => {
    it("is a pure function of its inputs", () => {
      const intervals = [
        iv({
          gridChargeKwh: 3,
          gridEmissionsIntensity: 350,
          gridRenewableFraction: 0.5,
          gridPrice: 12,
          socPct: 55,
        }),
        iv({ dischargeKwh: 1, socPct: 48 }),
      ];
      const a = foldBatteryProvenance(intervals, CONFIG);
      const b = foldBatteryProvenance(intervals, CONFIG);
      expect(a.steps).toEqual(b.steps);
      // foldStep leaves the frozen INITIAL_FOLD_STATE untouched.
      const before = { ...INITIAL_FOLD_STATE };
      foldStep(INITIAL_FOLD_STATE, intervals[0], CONFIG);
      expect(INITIAL_FOLD_STATE).toEqual(before);
    });
  });

  describe("efficiency & loss accounting", () => {
    it("with η<1, loads still bear the FULL charge footprint (conservation) + loss is decomposed", () => {
      const cfg: FoldConfig = { reserveFloorPct: 10, efficiency: 0.9 };
      const intervals = [
        iv({
          gridChargeKwh: 10,
          gridEmissionsIntensity: 500,
          gridRenewableFraction: 0.2,
          gridPrice: 30,
          socPct: 80,
        }),
        iv({ dischargeKwh: 3, socPct: 60 }),
        iv({ dischargeKwh: 3, socPct: 45 }),
        iv({ dischargeKwh: 3, socPct: 30 }), // 9 kWh delivered (= η·10) → empties
      ];
      const { steps, finalState } = foldBatteryProvenance(intervals, cfg);
      // All 5000 gCO2 charged is vended to loads (delivered carries the loss → intensity inflated 1/η).
      expect(vendedCarbon(steps)).toBeCloseTo(10 * 500, 3);
      expect(vendedCost(steps)).toBeCloseTo(10 * 30, 4);
      expect(steps[1].batteryEmissionsIntensity).toBeCloseTo(500 / 0.9, 4); // 555.6 g/kWh
      // Loss decomposition: (1−η) of throughput + footprint (a lens on delivered, not subtracted).
      expect(finalState.roundtripLossKwh).toBeCloseTo(1.0, 6);
      expect(finalState.roundtripLossG).toBeCloseTo(500, 4);
      expect(finalState.totalChargeKwh).toBeCloseTo(10, 6);
      expect(finalState.totalDischargeKwh).toBeCloseTo(9, 6);
      // Round-trip efficiency recoverable from the totals.
      expect(
        finalState.totalDischargeKwh / finalState.totalChargeKwh,
      ).toBeCloseTo(0.9, 6);
    });

    it("renewable FRACTION stays in [0,1] under η<1 (bounded proportion, not an intensity)", () => {
      const cfg: FoldConfig = { reserveFloorPct: 10, efficiency: 0.9 };
      // 100% solar charge must vend 100% renewable even with losses — NOT 1/η = 111%.
      const solar = foldBatteryProvenance(
        [
          iv({ solarChargeKwh: 10, socPct: 80 }),
          iv({ dischargeKwh: 2, socPct: 60 }),
        ],
        cfg,
      );
      expect(solar.steps[1].batteryRenewableFraction).toBeCloseTo(1, 9);
      // A mixed charge is bounded and equals the true (η-invariant) renewable share.
      const mixed = foldBatteryProvenance(
        [
          iv({
            solarChargeKwh: 6,
            gridChargeKwh: 4,
            gridEmissionsIntensity: 400,
            gridRenewableFraction: 0.25,
            gridPrice: 20,
            socPct: 70,
          }),
          iv({ dischargeKwh: 2, socPct: 55 }),
        ],
        cfg,
      );
      // (6*1 + 4*0.25) / 10 = 0.7 regardless of η
      expect(mixed.steps[1].batteryRenewableFraction).toBeCloseTo(0.7, 9);
      expect(mixed.steps[1].batteryRenewableFraction).toBeLessThanOrEqual(1);
    });

    it("conservation identity holds: Σcharged == Σvended + Σunattributed (audit)", () => {
      const cfg: FoldConfig = { reserveFloorPct: 10 };
      const intervals = [
        iv({
          gridChargeKwh: 8,
          gridEmissionsIntensity: 400,
          gridRenewableFraction: 0.3,
          gridPrice: 20,
          socPct: 70,
        }),
        iv({ dischargeKwh: 3, socPct: 55 }),
        // SoC-floor reset while E=5 still stored → residual becomes unattributed loss.
        iv({ dischargeKwh: 0, socPct: 8 }),
        iv({ solarChargeKwh: 4, socPct: 30 }), // reset applied here (discards E=5 → unattributed)
        iv({ dischargeKwh: 4, socPct: 20 }),
      ];
      const { steps, finalState } = foldBatteryProvenance(intervals, cfg);
      const vended = vendedCarbon(steps);
      const chargedCarbon = 8 * 400; // only grid charge carries carbon
      expect(vended + finalState.unattribLossG).toBeCloseTo(chargedCarbon, 3);
      expect(finalState.unattribLossG).toBeGreaterThan(0); // the discarded residual
      expect(finalState.resetsSocFloor).toBe(1);
    });
  });

  describe("drift backstop", () => {
    it("forces a reset after maxSegmentIntervals without one (staleness cap)", () => {
      const cfg: FoldConfig = { reserveFloorPct: 10, maxSegmentIntervals: 3 };
      // Charge a trickle every interval, never discharging → segment would run forever without a cap.
      const intervals = Array.from({ length: 6 }, () =>
        iv({
          gridChargeKwh: 1,
          gridEmissionsIntensity: 300,
          gridRenewableFraction: 0.4,
          gridPrice: 10,
          socPct: 60,
        }),
      );
      const { steps, finalState } = foldBatteryProvenance(intervals, cfg);
      expect(steps.some((s) => s.resetTrigger === "backstop")).toBe(true);
      expect(finalState.resetsBackstop).toBeGreaterThanOrEqual(1);
      // No segment ever exceeds the cap length.
      expect(
        Math.max(...steps.map((s) => s.segmentIntervals)),
      ).toBeLessThanOrEqual(3);
    });

    it("empty re-anchor with eps cleans a tiny residual and captures it as unattributed loss", () => {
      const cfg: FoldConfig = { reserveFloorPct: 10, reanchorEpsKwh: 0.5 };
      const intervals = [
        iv({
          gridChargeKwh: 5,
          gridEmissionsIntensity: 500,
          gridRenewableFraction: 0.2,
          gridPrice: 30,
          socPct: 60,
        }),
        iv({ dischargeKwh: 4.7, socPct: 20 }), // leaves 0.3 kWh ≤ eps → bottom-out reset
      ];
      const { steps, finalState } = foldBatteryProvenance(intervals, cfg);
      expect(steps[1].resetHere).toBe(true);
      expect(steps[1].resetTrigger).toBe("empty");
      expect(finalState.unattribLossKwh).toBeCloseTo(0.3, 6);
      expect(finalState.storedKwh).toBe(0);
    });
  });
});
