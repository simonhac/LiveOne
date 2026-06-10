import { describe, it, expect } from "@jest/globals";
import {
  computeFlowMatrix,
  FlowSeries,
  FlowMatrixResult,
} from "../flow-matrix-core";

const HOUR = 60 * 60 * 1000;

/** Build ascending epoch-ms timestamps `count` hours apart from an arbitrary base. */
function hours(count: number): number[] {
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: count }, (_, i) => base + i * HOUR);
}

function idx(
  result: FlowMatrixResult,
  path: string,
  axis: "sources" | "loads",
) {
  return result[axis].indexOf(path);
}

function cell(result: FlowMatrixResult, sourcePath: string, loadPath: string) {
  return result.matrix[idx(result, sourcePath, "sources")][
    idx(result, loadPath, "loads")
  ];
}

describe("computeFlowMatrix", () => {
  it("integrates a single source feeding a single load (1 kW, 1 h → 1 kWh)", () => {
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [{ path: "source.solar", power: [1, 1] }],
      loads: [{ path: "load", power: [1, 1] }],
    });
    expect(cell(result, "source.solar", "load")).toBeCloseTo(1, 6);
    expect(result.totalEnergy).toBeCloseTo(1, 6);
    expect(result.intervalsUsed).toBe(1);
  });

  it("represents a bidirectional battery as BOTH a charge-load and a discharge-source", () => {
    // Charge phase: solar 10 kW serves 6 kW house AND charges the battery at 4 kW for 1 h.
    const charge = computeFlowMatrix({
      timestamps: hours(2),
      sources: [
        { path: "source.solar", power: [10, 10] },
        { path: "source.battery", power: [0, 0] }, // discharge (>=0)
      ],
      loads: [
        { path: "load", power: [6, 6] },
        { path: "load.battery", power: [4, 4] }, // charge (>=0)
      ],
    });
    // Charging lands as solar -> load.battery (battery acting as a LOAD).
    expect(cell(charge, "source.solar", "load.battery")).toBeCloseTo(4, 6);
    expect(cell(charge, "source.solar", "load")).toBeCloseTo(6, 6);
    expect(cell(charge, "source.battery", "load.battery")).toBeCloseTo(0, 6);

    // Discharge phase: no solar; battery discharges 3 kW to serve a 3 kW house for 1 h.
    const discharge = computeFlowMatrix({
      timestamps: hours(2),
      sources: [
        { path: "source.solar", power: [0, 0] },
        { path: "source.battery", power: [3, 3] },
      ],
      loads: [
        { path: "load", power: [3, 3] },
        { path: "load.battery", power: [0, 0] },
      ],
    });
    // Discharging lands as source.battery -> load (battery acting as a SOURCE).
    expect(cell(discharge, "source.battery", "load")).toBeCloseTo(3, 6);
    expect(cell(discharge, "source.solar", "load")).toBeCloseTo(0, 6);

    // The naive 30D bug averages the day's signed battery power to ~net-zero, so the
    // split would yield 0 charge AND 0 discharge. Integrating per-interval keeps both:
    // charge 4 kWh (as a load) and discharge 3 kWh (as a source) are each preserved.
    expect(
      cell(charge, "source.solar", "load.battery") +
        cell(discharge, "source.battery", "load"),
    ).toBeGreaterThan(0);
  });

  it("is additive: Σ(sub-window matrices) == full-window matrix (monthly = Σ daily)", () => {
    // A varying day; split the interval set at an interior timestamp and assert the
    // element-wise sum of the two sub-window matrices equals the whole-window matrix.
    const ts = hours(5);
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [2, 4, 6, 3, 1] },
      { path: "source.battery", power: [1, 0, 2, 4, 5] },
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: [2, 3, 5, 6, 4] },
      { path: "load.battery", power: [1, 1, 0, 0, 2] },
    ];

    const full = computeFlowMatrix({ timestamps: ts, sources, loads });

    const split = 2; // boundary index shared by both windows
    const sliceTo = (s: FlowSeries) => ({
      path: s.path,
      power: s.power.slice(0, split + 1),
    });
    const sliceFrom = (s: FlowSeries) => ({
      path: s.path,
      power: s.power.slice(split),
    });
    const a = computeFlowMatrix({
      timestamps: ts.slice(0, split + 1),
      sources: sources.map(sliceTo),
      loads: loads.map(sliceTo),
    });
    const b = computeFlowMatrix({
      timestamps: ts.slice(split),
      sources: sources.map(sliceFrom),
      loads: loads.map(sliceFrom),
    });

    for (let s = 0; s < sources.length; s++) {
      for (let l = 0; l < loads.length; l++) {
        expect(a.matrix[s][l] + b.matrix[s][l]).toBeCloseTo(
          full.matrix[s][l],
          9,
        );
      }
    }
    expect(a.totalEnergy + b.totalEnergy).toBeCloseTo(full.totalEnergy, 9);
  });

  it("drops intervals with no generation (totalGen<=0) — documents the night/grid-only edge", () => {
    // No source power in the only interval → load energy is not allocated anywhere.
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [{ path: "source.solar", power: [0, 0] }],
      loads: [{ path: "load", power: [1, 1] }],
    });
    expect(result.totalEnergy).toBeCloseTo(0, 6);
    expect(result.intervalsUsed).toBe(0);
  });

  it("skips an interval when a series endpoint is null (no integration across a gap)", () => {
    const result = computeFlowMatrix({
      timestamps: hours(3),
      sources: [{ path: "source.solar", power: [1, null, 1] }],
      loads: [{ path: "load", power: [1, 1, 1] }],
    });
    // Interval 0 has a null right endpoint; interval 1 has a null left endpoint → both skip.
    expect(result.totalEnergy).toBeCloseTo(0, 6);
  });
});
