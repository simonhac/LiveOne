import { describe, it, expect } from "@jest/globals";
import {
  reduceLoadProvenance,
  type DailyFlowMatrices,
  type DailyFlowMatrix,
  type EnergyFlowNode,
} from "@/lib/energy-flow-matrix";

const node = (id: string, label: string): EnergyFlowNode => ({
  id,
  label,
  color: "#000",
});
const SOURCES = [
  node("source.solar", "Solar"),
  node("source.battery", "Battery"),
  node("source.grid", "Grid"),
];
const LOADS = [node("load.ev", "EV"), node("load.house", "House")];

// One day feeding load.ev (col 0): solar 10 / battery 2 / grid 1 kWh.
function day(overrides: Partial<DailyFlowMatrix> = {}): DailyFlowMatrix {
  return {
    day: "2026-07-01",
    // [src][load]
    matrix: [
      [10, 5],
      [2, 3],
      [1, 4],
    ],
    emissionsG: [
      [0, 0],
      [200, 300],
      [800, 3200],
    ],
    renewableKwh: [
      [10, 5],
      [1.8, 2.7],
      [0.3, 1.2],
    ],
    costC: [
      [0, 0],
      [5, 7],
      [20, 80],
    ],
    estimatedKwh: [
      [0, 0],
      [0, 0],
      [1, 4],
    ],
    ...overrides,
  };
}

const matrices = (days: DailyFlowMatrix[]): DailyFlowMatrices => ({
  sources: SOURCES,
  loads: LOADS,
  days,
});

describe("reduceLoadProvenance", () => {
  it("summarises one load across sources with filtered-denominator averages", () => {
    const r = reduceLoadProvenance(matrices([day()]), "load.ev");
    expect(r).not.toBeNull();
    expect(r!.energyKwh).toBeCloseTo(13, 6); // 10 + 2 + 1
    expect(r!.costC).toBeCloseTo(25, 6); // 0 + 5 + 20
    expect(r!.avgCentsPerKwh).toBeCloseTo(25 / 13, 6);
    expect(r!.avgGramsPerKwh).toBeCloseTo(1000 / 13, 6); // (0+200+800)/13
    expect(r!.kgCo2).toBeCloseTo(1.0, 6);
    expect(r!.pctRenewable).toBeCloseTo((100 * 12.1) / 13, 6); // (10+1.8+0.3)/13
    expect(r!.pctEstimated).toBeCloseTo((100 * 1) / 13, 6); // grid's 1 kWh
    // source split: descending, house-only energy excluded
    expect(r!.sources.map((s) => s.path)).toEqual([
      "source.solar",
      "source.battery",
      "source.grid",
    ]);
    expect(r!.sources[0].energyKwh).toBeCloseTo(10, 6);
  });

  it("is additive over days (two identical days → doubled totals, same averages)", () => {
    const one = reduceLoadProvenance(matrices([day()]), "load.ev")!;
    const two = reduceLoadProvenance(matrices([day(), day()]), "load.ev")!;
    expect(two.energyKwh).toBeCloseTo(2 * one.energyKwh, 6);
    expect(two.costC).toBeCloseTo(2 * one.costC, 6);
    expect(two.avgGramsPerKwh!).toBeCloseTo(one.avgGramsPerKwh!, 6);
    expect(two.pctRenewable!).toBeCloseTo(one.pctRenewable!, 6);
    expect(two.pctEstimated).toBeCloseTo(one.pctEstimated, 6);
  });

  it("excludes unknown-intensity edges from an average's denominator but not from energy", () => {
    // Null out grid→ev emissions (unknown intensity for that 1 kWh edge).
    const d = day();
    d.emissionsG![2][0] = null;
    const r = reduceLoadProvenance(matrices([d]), "load.ev")!;
    expect(r.energyKwh).toBeCloseTo(13, 6); // energy unchanged
    // emissions numerator drops grid (800), denominator drops grid's 1 kWh → 200 / 12
    expect(r.avgGramsPerKwh).toBeCloseTo(200 / 12, 6);
  });

  it("returns null for a legacy (energy-only) payload", () => {
    const d = day();
    delete d.emissionsG;
    delete d.renewableKwh;
    delete d.costC;
    delete d.estimatedKwh;
    expect(reduceLoadProvenance(matrices([d]), "load.ev")).toBeNull();
  });

  it("returns null when the load is absent", () => {
    expect(reduceLoadProvenance(matrices([day()]), "load.spa")).toBeNull();
  });
});
