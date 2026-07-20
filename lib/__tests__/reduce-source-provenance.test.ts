import { describe, it, expect } from "@jest/globals";
import {
  reduceSourceProvenance,
  reduceLoadProvenance,
  combineSolarSources,
  sumDailyFlowMatrices,
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

// Same fixture as lib/__tests__/load-provenance-reduce.test.ts (transpose parity target).
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

describe("reduceSourceProvenance", () => {
  it("summarises one source across loads with filtered-denominator averages (grid row)", () => {
    const r = reduceSourceProvenance(matrices([day()]), "source.grid");
    expect(r).not.toBeNull();
    expect(r!.energyKwh).toBeCloseTo(5, 6); // 1 + 4
    expect(r!.costC).toBeCloseTo(100, 6); // 20 + 80
    expect(r!.avgCentsPerKwh).toBeCloseTo(100 / 5, 6);
    expect(r!.avgGramsPerKwh).toBeCloseTo(4000 / 5, 6); // (800+3200)/5
    expect(r!.kgCo2).toBeCloseTo(4.0, 6);
    expect(r!.pctRenewable).toBeCloseTo((100 * 1.5) / 5, 6); // (0.3+1.2)/5
    expect(r!.pctEstimated).toBeCloseTo(100, 6); // both grid cells estimated
    // load split: descending by energy (house 4 > ev 1)
    expect(r!.loads.map((l) => l.path)).toEqual(["load.house", "load.ev"]);
    expect(r!.loads[0].energyKwh).toBeCloseTo(4, 6);
  });

  it("is additive over days (two identical days → doubled totals, same averages)", () => {
    const one = reduceSourceProvenance(matrices([day()]), "source.battery")!;
    const two = reduceSourceProvenance(
      matrices([day(), day()]),
      "source.battery",
    )!;
    expect(two.energyKwh).toBeCloseTo(2 * one.energyKwh, 6);
    expect(two.costC).toBeCloseTo(2 * one.costC, 6);
    expect(two.avgGramsPerKwh!).toBeCloseTo(one.avgGramsPerKwh!, 6);
    expect(two.pctRenewable!).toBeCloseTo(one.pctRenewable!, 6);
  });

  it("excludes unknown-intensity edges from an average's denominator but not from energy", () => {
    // Null out grid→house emissions (unknown intensity for that 4 kWh edge).
    const d = day();
    d.emissionsG![2][1] = null;
    const r = reduceSourceProvenance(matrices([d]), "source.grid")!;
    expect(r.energyKwh).toBeCloseTo(5, 6); // energy unchanged
    // numerator drops the 4 kWh edge (3200), denominator drops its 4 kWh → 800/1
    expect(r.avgGramsPerKwh).toBeCloseTo(800 / 1, 6);
  });

  it("returns null for a legacy (energy-only) payload", () => {
    const d = day();
    delete d.emissionsG;
    delete d.renewableKwh;
    delete d.costC;
    delete d.estimatedKwh;
    expect(reduceSourceProvenance(matrices([d]), "source.grid")).toBeNull();
  });

  it("returns null when the source is absent", () => {
    expect(
      reduceSourceProvenance(matrices([day()]), "source.generator"),
    ).toBeNull();
  });

  describe("transpose parity with reduceLoadProvenance", () => {
    it("a source's total equals the sum of its per-load split from reduceLoadProvenance", () => {
      const d = matrices([day()]);
      for (const src of SOURCES) {
        const bySource = reduceSourceProvenance(d, src.id)!;
        let summed = 0;
        for (const ld of LOADS) {
          const byLoad = reduceLoadProvenance(d, ld.id)!;
          summed +=
            byLoad.sources.find((s) => s.path === src.id)?.energyKwh ?? 0;
        }
        expect(bySource.energyKwh).toBeCloseTo(summed, 6);
      }
    });

    it("the sum of every source's total equals the sum of every load's total (both cover the same grid)", () => {
      const d = matrices([day()]);
      const sourceTotal = SOURCES.reduce(
        (sum, s) => sum + reduceSourceProvenance(d, s.id)!.energyKwh,
        0,
      );
      const loadTotal = LOADS.reduce(
        (sum, l) => sum + reduceLoadProvenance(d, l.id)!.energyKwh,
        0,
      );
      expect(sourceTotal).toBeCloseTo(loadTotal, 6);
    });
  });

  describe("combineSolar", () => {
    const solarSources = [
      node("source.solar", "Solar"),
      node("source.solar.local", "Solar Local"),
      node("source.solar.remote", "Solar Remote"),
    ];
    const solarDay: DailyFlowMatrix = {
      day: "2026-07-01",
      matrix: [
        [3, 1],
        [4, 2],
        [1, 1],
      ],
      emissionsG: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      renewableKwh: [
        [3, 1],
        [4, 2],
        [1, 1],
      ],
      costC: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      estimatedKwh: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    };
    const dm: DailyFlowMatrices = {
      sources: solarSources,
      loads: LOADS,
      days: [solarDay],
    };

    it("folds every solar source index into one combined reduction when combineSolar is set", () => {
      const combined = reduceSourceProvenance(dm, "source.solar", {
        combineSolar: true,
      })!;
      expect(combined.energyKwh).toBeCloseTo(3 + 1 + 4 + 2 + 1 + 1, 6);
      expect(combined.sourcePath).toBe("source.solar");
      expect(combined.sourceLabel).toBe("Solar");
    });

    it("without combineSolar, only the exact node's own row is reduced", () => {
      const r = reduceSourceProvenance(dm, "source.solar.local")!;
      expect(r.energyKwh).toBeCloseTo(4 + 2, 6); // only its own row
      expect(r.sourcePath).toBe("source.solar.local");
    });

    it("the combined index-set equals combineSolarSources' combined row total", () => {
      const combinedReduction = reduceSourceProvenance(dm, "source.solar", {
        combineSolar: true,
      })!;
      const em = sumDailyFlowMatrices(dm)!;
      const combinedMatrix = combineSolarSources(em);
      const idx = combinedMatrix.sources.findIndex(
        (s) => s.id === "source.solar",
      );
      expect(combinedReduction.energyKwh).toBeCloseTo(
        combinedMatrix.sourceTotals[idx],
        6,
      );
    });
  });
});
