import { describe, it, expect } from "@jest/globals";
import { foldBatteryProvenance, type FoldInterval } from "../fold";
import { computeBatteryProvenance } from "../compute";
import type { ProvenanceInputs } from "../types";
import type { FlowSeries } from "../../aggregation/flow-matrix-core";

const HOUR = 60 * 60 * 1000;

/**
 * These guard the reproducibility fix: η is LEARNED ONCE in the shell (persisted) and READ by the fold as a
 * per-interval input — never re-learned per recompute window. That restores repair-convergence, which the
 * old in-window learning broke (the same day got a different η depending on which window last touched it).
 */
describe("η reproducibility (learn-in-shell / read-in-fold)", () => {
  it("fold is composable under a per-interval η(t): fold(a++b) == fold(b | state=fold(a))", () => {
    const cfg = { reserveFloorPct: 5 };
    // A per-interval η(t) that drifts (as a persisted, slowly-changing η would).
    const eta = [0.9, 0.9, 0.88, 0.88, 0.86, 0.86, 0.85, 0.85];
    const mk = (
      i: number,
      charge: number,
      discharge: number,
    ): FoldInterval => ({
      solarChargeKwh: charge,
      gridChargeKwh: 0,
      otherChargeKwh: 0,
      dischargeKwh: discharge,
      gridEmissionsIntensity: 500,
      gridRenewableFraction: 0.3,
      gridPrice: 25,
      solarCost: 0,
      socPct: null,
      gridEstimated: false,
      efficiency: eta[i], // the persisted η for this interval
    });
    const ivs = [
      mk(0, 5, 0),
      mk(1, 5, 0),
      mk(2, 0, 3),
      mk(3, 0, 3),
      mk(4, 4, 0),
      mk(5, 4, 0),
      mk(6, 0, 2),
      mk(7, 0, 2),
    ];
    const full = foldBatteryProvenance(ivs, cfg);
    const split = 4;
    const a = foldBatteryProvenance(ivs.slice(0, split), cfg);
    const b = foldBatteryProvenance(ivs.slice(split), cfg, a.finalState);

    const near = (x: number | null, y: number | null) =>
      x === null || y === null
        ? expect(x).toBe(y)
        : expect(x).toBeCloseTo(y, 9);
    for (let i = 0; i < b.steps.length; i++) {
      const f = full.steps[split + i];
      expect(b.steps[i].storedKwh).toBeCloseTo(f.storedKwh, 9);
      near(b.steps[i].batteryEmissionsIntensity, f.batteryEmissionsIntensity);
      near(b.steps[i].batteryPrice, f.batteryPrice);
      near(b.steps[i].batteryRenewableFraction, f.batteryRenewableFraction);
    }
  });

  it("compute uses inputs.etaSeries verbatim and does not re-learn η in-window", () => {
    const n = 5;
    const base = Date.parse("2026-01-01T00:00:00Z");
    const timeline = Array.from({ length: n }, (_, i) => base + i * HOUR);
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [8, 8, 0, 0, 0] },
      { path: "source.grid", power: [2, 2, 0, 0, 0] },
      { path: "source.battery", power: [0, 0, 3, 3, 0] },
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: [6, 6, 0, 0, 0] },
      { path: "load.battery", power: [4, 4, 0, 0, 0] },
      { path: "load.ev", power: [0, 0, 3, 3, 0] },
    ];
    const arr = (v: number | null) => new Array<number | null>(n).fill(v);
    const inputs: ProvenanceInputs = {
      handle: 1,
      areaId: "test",
      region: "VIC1",
      batterySystemId: 6,
      timezoneOffsetMin: 600,
      timeline,
      sources,
      loads,
      gridEmissions: arr(600),
      gridEmissionsEstimated: new Array<boolean>(n).fill(false),
      gridRenewable: arr(0.25),
      gridPrice: arr(30),
      gridPriceEstimated: new Array<boolean>(n).fill(false),
      gridExportPrice: arr(5),
      soc: [50, 80, 60, 20, 8],
      estReservePct: 10,
      etaSeries: new Array<number | null>(n).fill(0.8),
      coverage: { soc: 1, emissions: 1, price: 1 },
    };
    const withEta = computeBatteryProvenance(inputs);
    // etaUsed is the throughput-weighted mean of the PROVIDED series (0.8) — not a re-learned value.
    expect(withEta.etaUsed).toBeCloseTo(0.8, 6);
    // the in-window learn diagnostic is absent on the persisted path.
    expect(withEta.etaByDay).toBeUndefined();

    // Without the persisted series, compute falls back to in-window learning → a different η + a byDay trend.
    const noEta = computeBatteryProvenance({ ...inputs, etaSeries: undefined });
    expect(noEta.etaByDay).toBeDefined();
    expect(Math.abs(noEta.etaUsed - withEta.etaUsed)).toBeGreaterThan(1e-6);
  });
});
