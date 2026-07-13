import { describe, it, expect } from "@jest/globals";
import {
  computeFlowMatrix,
  computeFlowAccounting,
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

/**
 * The per-day `window` slice (used by the flow_attr_1d rollup writer) must integrate a day EXACTLY like
 * the legacy flow_1d recompute integrates that day's own samples in isolation — so the modern metric
 * legs stay byte-identical to the energy Sankey. The regression these guard: a gap-/midnight-spanning
 * interval being attributed WHOLLY to the later day because only its END was checked (Bug B).
 */
describe("computeFlowAccounting per-day window == isolated per-day integration", () => {
  const D1 = Date.parse("2026-01-01T00:00:00Z");
  const DAY = 24 * HOUR;
  const FIVE_MIN = 5 * 60 * 1000;
  // The aggregation window for the local day starting at `midnightMs`: (00:05, next 00:00].
  const dayWindow = (midnightMs: number) => ({
    startMs: midnightMs + FIVE_MIN,
    endMs: midnightMs + DAY,
  });
  const grid = (ts: number[], kw: number): FlowSeries[] => [
    { path: "source.grid", power: ts.map(() => kw) },
  ];
  const load = (ts: number[], kw: number): FlowSeries[] => [
    { path: "load", power: ts.map(() => kw) },
  ];
  // Legacy flow_1d integrates ONLY the day's own samples (interval_end in [00:05, next 00:00]).
  const isolate = (ts: number[], w: { startMs: number; endMs: number }) =>
    ts.filter((t) => t >= w.startMs && t <= w.endMs);

  it("drops a gap/midnight-spanning interval from the later day (Bug B)", () => {
    const win2 = dayWindow(D1 + DAY); // 2026-01-02
    // Day-1 tail 21:00, 22:00; a GAP across midnight; day-2 first samples 08:00, 09:00.
    const fullTs = [
      D1 + 21 * HOUR,
      D1 + 22 * HOUR,
      D1 + DAY + 8 * HOUR,
      D1 + DAY + 9 * HOUR,
    ];
    const modern = computeFlowAccounting({
      timestamps: fullTs,
      sources: grid(fullTs, 2),
      loads: load(fullTs, 2),
      window: win2,
    });
    const isoTs = isolate(fullTs, win2); // [08:00, 09:00]
    const legacy = computeFlowMatrix({
      timestamps: isoTs,
      sources: grid(isoTs, 2),
      loads: load(isoTs, 2),
    });
    // Only the 08:00→09:00 interval (2 kW × 1 h = 2 kWh) belongs to day 2. The 22:00→08:00 gap interval
    // (2 kW × 10 h = 20 kWh) spans midnight and belongs to NEITHER isolated day — it must not appear.
    expect(modern.energyKwh[0][0]).toBeCloseTo(2, 6);
    expect(legacy.matrix[0][0]).toBeCloseTo(2, 6);
    expect(modern.energyKwh[0][0]).toBeCloseTo(legacy.matrix[0][0], 6);
  });

  it("dense day: windowed slice equals isolated integration (no regression)", () => {
    const win2 = dayWindow(D1 + DAY);
    const fullTs: number[] = [];
    for (let h = 22; h <= 24; h++) fullTs.push(D1 + h * HOUR); // day1 22:00,23:00, 00:00 day2
    for (let h = 1; h <= 24; h++) fullTs.push(D1 + DAY + h * HOUR); // day2 01:00 .. 00:00 day3
    const modern = computeFlowAccounting({
      timestamps: fullTs,
      sources: grid(fullTs, 3),
      loads: load(fullTs, 2),
      window: win2,
    });
    const isoTs = isolate(fullTs, win2);
    const legacy = computeFlowMatrix({
      timestamps: isoTs,
      sources: grid(isoTs, 3),
      loads: load(isoTs, 2),
    });
    expect(modern.energyKwh[0][0]).toBeGreaterThan(0);
    expect(modern.energyKwh[0][0]).toBeCloseTo(legacy.matrix[0][0], 6);
  });
});
