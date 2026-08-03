import { describe, it, expect } from "@jest/globals";
import {
  computeFlowMatrix,
  FlowSeries,
} from "../../aggregation/flow-matrix-core";
import { extractBatteryFlows } from "../battery-flows";

const HOUR = 60 * 60 * 1000;
const ts = (n: number) => {
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => base + i * HOUR);
};

/** The (source→load.battery) cell from computeFlowMatrix, for cross-checking the split. */
function chargeCell(
  timestamps: number[],
  sources: FlowSeries[],
  loads: FlowSeries[],
  sourcePath: string,
) {
  const m = computeFlowMatrix({ timestamps, sources, loads });
  const s = m.sources.indexOf(sourcePath);
  const l = m.loads.indexOf("load.battery");
  return s < 0 || l < 0 ? 0 : m.matrix[s][l];
}

describe("extractBatteryFlows", () => {
  it("splits battery charge across solar/grid exactly like computeFlowMatrix", () => {
    const timestamps = ts(2);
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [6, 6] },
      { path: "source.grid", power: [2, 2] }, // import
      { path: "source.battery", power: [0, 0] },
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: [4, 4] },
      { path: "load.battery", power: [4, 4] }, // charging 4 kW
    ];
    const [bf] = extractBatteryFlows(timestamps, sources, loads);
    // total gen 8 → solar share 6/8, grid 2/8, of the 4 kWh charge.
    expect(bf.solarChargeKwh).toBeCloseTo(3, 9);
    expect(bf.gridChargeKwh).toBeCloseTo(1, 9);
    expect(bf.otherChargeKwh).toBeCloseTo(0, 9);
    expect(bf.dischargeKwh).toBeCloseTo(0, 9);
    // ...and matches the flow-matrix cells.
    expect(bf.solarChargeKwh).toBeCloseTo(
      chargeCell(timestamps, sources, loads, "source.solar"),
      9,
    );
    expect(bf.gridChargeKwh).toBeCloseTo(
      chargeCell(timestamps, sources, loads, "source.grid"),
      9,
    );
  });

  it("takes discharge straight from source.battery (integrated energy)", () => {
    const timestamps = ts(2);
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [0, 0] },
      { path: "source.battery", power: [3, 3] }, // discharging 3 kW
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: [3, 3] },
      { path: "load.battery", power: [0, 0] },
    ];
    const [bf] = extractBatteryFlows(timestamps, sources, loads);
    expect(bf.dischargeKwh).toBeCloseTo(3, 9);
    expect(
      bf.solarChargeKwh + bf.gridChargeKwh + bf.otherChargeKwh,
    ).toBeCloseTo(0, 9);
  });

  it("credits solar's LEFT-endpoint share into the battery when its right endpoint is missing, in step with the matrix", () => {
    const timestamps = ts(2);
    // Solar reads at t0 but its t1 sample is missing. Its left endpoint is the datum that puts it in
    // the pool, so it is also the datum that earns it the edge — the same rule the core applies.
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [4, null] },
      { path: "source.grid", power: [4, 4] },
      { path: "source.battery", power: [0, 0] },
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: [0, 0] },
      { path: "load.battery", power: [2, 2] },
    ];
    const [bf] = extractBatteryFlows(timestamps, sources, loads);
    // An even 4/4 kW pool → the 2 kWh of charge splits in half.
    expect(bf.solarChargeKwh).toBeCloseTo(1, 9);
    expect(bf.gridChargeKwh).toBeCloseTo(1, 9);
    // The claim that matters: this fold and the Sankey agree edge-for-edge. Previously both dropped
    // solar here — the matrix deleted the share outright, the fold relabelled it `otherChargeKwh`.
    expect(bf.solarChargeKwh).toBeCloseTo(
      chargeCell(timestamps, sources, loads, "source.solar"),
      9,
    );
    expect(bf.gridChargeKwh).toBeCloseTo(
      chargeCell(timestamps, sources, loads, "source.grid"),
      9,
    );
    // Every source is accounted for, so nothing falls through to unknown provenance...
    expect(bf.otherChargeKwh).toBeCloseTo(0, 9);
    // ...and the fold's inventory E stays whole either way.
    expect(
      bf.solarChargeKwh + bf.gridChargeKwh + bf.otherChargeKwh,
    ).toBeCloseTo(2, 9);
  });
});
