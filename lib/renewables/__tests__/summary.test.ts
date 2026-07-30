import { describe, it, expect } from "@jest/globals";
import {
  computeRenewablesMetrics,
  reduceRenewablesMetrics,
  type RenewablesEdgeAgg,
} from "../summary";
import type {
  DailyFlowMatrices,
  EnergyFlowNode,
} from "@/lib/energy-flow-matrix";

/** Build an edge with inert defaults (no metric leg, no null rows). */
function edge(p: Partial<RenewablesEdgeAgg>): RenewablesEdgeAgg {
  return {
    sourcePath: "source.solar",
    loadPath: "load",
    energyKwh: 0,
    renewableKwh: 0,
    selfRenewableKwh: 0,
    selfRenewableNullRows: 0,
    estimatedKwh: 0,
    emissionsG: 0,
    emissionsKnownKwh: 0,
    costC: 0,
    costKnownKwh: 0,
    ...p,
  };
}

describe("computeRenewablesMetrics", () => {
  it("no-battery solar+grid area: all three metrics compute (fold never invoked)", () => {
    // A day: solar serves 6 kWh of load + exports 2 kWh; grid serves 4 kWh of load (40% renewable grid).
    //   consumption      = 6 (solar→load) + 4 (grid→load) = 10
    //   selfRenewToLoads = 6 (solar) + 0 (grid) = 6
    //   renewToLoads     = 6 (solar·1) + 1.6 (grid 4·0.4) = 7.6
    //   selfRenewGenerated = solar edges' self_renewable = 6 (→load) + 2 (→grid) = 8
    //   selfRenewExported  = solar→grid self_renewable = 2
    const edges: RenewablesEdgeAgg[] = [
      edge({
        sourcePath: "source.solar",
        loadPath: "load",
        energyKwh: 6,
        renewableKwh: 6,
        selfRenewableKwh: 6,
      }),
      edge({
        sourcePath: "source.solar",
        loadPath: "load.grid",
        energyKwh: 2,
        renewableKwh: 2,
        selfRenewableKwh: 2,
      }),
      edge({
        sourcePath: "source.grid",
        loadPath: "load",
        energyKwh: 4,
        renewableKwh: 1.6, // 4 · 0.4
        selfRenewableKwh: 0, // grid is not behind-the-meter
      }),
    ];
    const r = computeRenewablesMetrics(edges);
    expect(r.consumptionKwh).toBeCloseTo(10, 9);
    expect(r.selfRenewGeneratedKwh).toBeCloseTo(8, 9);
    // 1. renewable autarky = 6 / 10 = 0.6
    expect(r.metrics.renewableAutarky).toBeCloseTo(0.6, 9);
    // 2. own-renewable self-consumption = 1 − 2/8 = 0.75
    expect(r.metrics.ownRenewableSelfConsumption).toBeCloseTo(0.75, 9);
    // 3. renewable share = 7.6 / 10 = 0.76
    expect(r.metrics.renewableShare).toBeCloseTo(0.76, 9);
  });

  it("worked example: battery blend discharged to loads (renewToLoads 2.8, selfRenewToLoads 2.0)", () => {
    // The battery charged 5 kWh solar + 5 kWh grid (40% renewable): blend renewable 0.7, self-renew 0.5.
    // An evening 4 kWh discharge to loads is materialised as a source.battery → load edge carrying
    // renewable_kwh = 4·0.7 = 2.8 and self_renewable_kwh = 4·0.5 = 2.0.
    const edges: RenewablesEdgeAgg[] = [
      edge({
        sourcePath: "source.battery",
        loadPath: "load",
        energyKwh: 4,
        renewableKwh: 2.8,
        selfRenewableKwh: 2.0,
      }),
    ];
    const r = computeRenewablesMetrics(edges);
    expect(r.consumptionKwh).toBeCloseTo(4, 9);
    // renewable autarky = selfRenewToLoads / consumption = 2.0 / 4 = 0.5
    expect(r.metrics.renewableAutarky).toBeCloseTo(0.5, 9);
    // renewable share = renewToLoads / consumption = 2.8 / 4 = 0.7
    expect(r.metrics.renewableShare).toBeCloseTo(0.7, 9);
    // No behind-the-meter generator edge in this slice → metric 2 unavailable (nothing generated here).
    expect(r.metrics.ownRenewableSelfConsumption).toBeNull();
  });

  it("distinct-metric guard: generator (source.grid) energy is excluded from autarky", () => {
    // Off-grid site: generator flows as source.grid (self_renewable 0). Plain autarky would count it as
    // self-origin; renewable autarky must NOT — only solar (behind-the-meter renewable) counts.
    const edges: RenewablesEdgeAgg[] = [
      edge({
        sourcePath: "source.solar",
        loadPath: "load",
        energyKwh: 3,
        renewableKwh: 3,
        selfRenewableKwh: 3,
      }),
      edge({
        sourcePath: "source.grid", // the generator
        loadPath: "load",
        energyKwh: 7,
        renewableKwh: 0,
        selfRenewableKwh: 0,
      }),
    ];
    const r = computeRenewablesMetrics(edges);
    // autarky = 3/10 = 0.3 (generator's 7 kWh excluded), NOT 10/10.
    expect(r.metrics.renewableAutarky).toBeCloseTo(0.3, 9);
    expect(r.metrics.renewableShare).toBeCloseTo(0.3, 9);
  });

  it("grid-only site: metric 3 still computes; 1 is 0 and 2 is null", () => {
    const edges: RenewablesEdgeAgg[] = [
      edge({
        sourcePath: "source.grid",
        loadPath: "load",
        energyKwh: 10,
        renewableKwh: 3.5, // 35% renewable grid
        selfRenewableKwh: 0,
      }),
    ];
    const r = computeRenewablesMetrics(edges);
    expect(r.metrics.renewableAutarky).toBeCloseTo(0, 9); // no own renewable
    expect(r.metrics.ownRenewableSelfConsumption).toBeNull(); // generated nothing
    expect(r.metrics.renewableShare).toBeCloseTo(0.35, 9);
  });

  it("partial data: a null self_renewable on a consumption edge makes metrics 1–2 unavailable, 3 fine", () => {
    const edges: RenewablesEdgeAgg[] = [
      edge({
        sourcePath: "source.battery",
        loadPath: "load",
        energyKwh: 5,
        renewableKwh: 3, // renewable leg still present
        selfRenewableKwh: 0,
        selfRenewableNullRows: 1, // an un-backfilled / unknown day
      }),
      edge({
        sourcePath: "source.solar",
        loadPath: "load",
        energyKwh: 5,
        renewableKwh: 5,
        selfRenewableKwh: 5,
      }),
    ];
    const r = computeRenewablesMetrics(edges);
    // The null is on a consumption edge → BOTH self-renewable metrics go unavailable together.
    expect(r.metrics.renewableAutarky).toBeNull();
    expect(r.metrics.ownRenewableSelfConsumption).toBeNull();
    // metric 3 unaffected: renewToLoads/consumption = (3+5)/10 = 0.8
    expect(r.metrics.renewableShare).toBeCloseTo(0.8, 9);
  });

  it("clamps to [0,1] and reports estimated confidence", () => {
    const edges: RenewablesEdgeAgg[] = [
      edge({
        sourcePath: "source.solar",
        loadPath: "load",
        energyKwh: 10,
        renewableKwh: 12, // pathological over-count → clamp
        selfRenewableKwh: 12,
        estimatedKwh: 2.5,
      }),
    ];
    const r = computeRenewablesMetrics(edges);
    expect(r.metrics.renewableAutarky).toBe(1);
    expect(r.metrics.renewableShare).toBe(1);
    expect(r.pctEstimated).toBeCloseTo(25, 9);
  });

  it("empty period: all metrics null", () => {
    const r = computeRenewablesMetrics([]);
    expect(r.metrics.renewableAutarky).toBeNull();
    expect(r.metrics.ownRenewableSelfConsumption).toBeNull();
    expect(r.metrics.renewableShare).toBeNull();
    expect(r.pctEstimated).toBe(0);
    expect(r.costC).toBe(0);
    expect(r.avgCentsPerKwh).toBeNull();
    expect(r.avgGramsPerKwh).toBeNull();
  });

  // ── consumption cost + emissions totals (the Home Energy stats) ──

  it("cost/emissions totals sum over consumption edges only — export and battery charge excluded", () => {
    const edges: RenewablesEdgeAgg[] = [
      // solar → load: free, zero-carbon.
      edge({
        sourcePath: "source.solar",
        loadPath: "load",
        energyKwh: 6,
        renewableKwh: 6,
        selfRenewableKwh: 6,
        emissionsG: 0,
        emissionsKnownKwh: 6,
        costC: 0,
        costKnownKwh: 6,
      }),
      // grid → load: 4 kWh @ 30c/kWh, 500 g/kWh.
      edge({
        sourcePath: "source.grid",
        loadPath: "load",
        energyKwh: 4,
        renewableKwh: 1.6,
        emissionsG: 2000,
        emissionsKnownKwh: 4,
        costC: 120,
        costKnownKwh: 4,
      }),
      // solar → grid (export revenue) and solar → battery (charge): NOT consumption.
      edge({
        sourcePath: "source.solar",
        loadPath: "load.grid",
        energyKwh: 2,
        renewableKwh: 2,
        selfRenewableKwh: 2,
        costC: -50,
        costKnownKwh: 2,
      }),
      edge({
        sourcePath: "source.solar",
        loadPath: "load.battery",
        energyKwh: 3,
        renewableKwh: 3,
        selfRenewableKwh: 3,
        emissionsG: 0,
        emissionsKnownKwh: 3,
        costC: 0,
        costKnownKwh: 3,
      }),
    ];
    const r = computeRenewablesMetrics(edges);
    expect(r.consumptionKwh).toBeCloseTo(10, 9);
    // Export's −50c and the charge edge never enter: 0 + 120 = 120c over 10 known kWh = 12.0 c/kWh.
    expect(r.costC).toBeCloseTo(120, 9);
    expect(r.avgCentsPerKwh).toBeCloseTo(12, 9);
    // 2000 g over 10 known kWh = 200 g/kWh.
    expect(r.emissionsG).toBeCloseTo(2000, 9);
    expect(r.kgCo2).toBeCloseTo(2, 9);
    expect(r.avgGramsPerKwh).toBeCloseTo(200, 9);
  });

  it("filtered denominators: an unknown-intensity edge doesn't drag the averages down", () => {
    const edges: RenewablesEdgeAgg[] = [
      edge({
        sourcePath: "source.grid",
        loadPath: "load",
        energyKwh: 5,
        emissionsG: 2500,
        emissionsKnownKwh: 5,
        costC: 150,
        costKnownKwh: 5,
      }),
      // 5 kWh with NO known cost/emissions (both known-kWh legs zero).
      edge({ sourcePath: "source.battery", loadPath: "load", energyKwh: 5 }),
    ];
    const r = computeRenewablesMetrics(edges);
    expect(r.consumptionKwh).toBeCloseTo(10, 9);
    // Averages use the 5 known kWh, not the 10 total: 30 c/kWh and 500 g/kWh (NOT 15 / 250).
    expect(r.avgCentsPerKwh).toBeCloseTo(30, 9);
    expect(r.avgGramsPerKwh).toBeCloseTo(500, 9);
  });
});

// ── The DailyFlowMatrices reducer (the tile's entry point over the shared attributed-flow payload) ──

const node = (id: string): EnergyFlowNode => ({ id, label: id, color: "#000" });

describe("reduceRenewablesMetrics", () => {
  it("sums the attributed payload across days and edges into the three metrics", () => {
    // sources: [solar, grid]; loads: [load, load.grid]. Two days, same shape.
    const sources = [node("source.solar"), node("source.grid")];
    const loads = [node("load"), node("load.grid")];
    // Per day: solar→load 3 (self-renew 3), solar→grid 1 (self-renew 1), grid→load 2 (self-renew 0, 40% renew).
    const mkDay = (day: string) => ({
      day,
      matrix: [
        [3, 1],
        [2, 0],
      ],
      emissionsG: [
        [0, 0],
        [null, null],
      ] as (number | null)[][],
      renewableKwh: [
        [3, 1],
        [0.8, null],
      ] as (number | null)[][],
      selfRenewableKwh: [
        [3, 1],
        [0, null],
      ] as (number | null)[][],
      estimatedKwh: [
        [0, 0],
        [0, 0],
      ],
    });
    const d: DailyFlowMatrices = {
      sources,
      loads,
      days: [mkDay("2026-07-01"), mkDay("2026-07-02")],
    };
    const r = reduceRenewablesMetrics(d)!;
    // consumption = (3 solar→load + 2 grid→load) × 2 days = 10
    expect(r.consumptionKwh).toBeCloseTo(10, 9);
    // selfRenewToLoads = 3×2 = 6 → autarky 6/10 = 0.6
    expect(r.metrics.renewableAutarky).toBeCloseTo(0.6, 9);
    // renewToLoads = (3 + 0.8)×2 = 7.6 → share 0.76
    expect(r.metrics.renewableShare).toBeCloseTo(0.76, 9);
    // selfRenewGenerated = solar edges (3+1)×2 = 8; exported = solar→grid 1×2 = 2 → 1 − 2/8 = 0.75
    expect(r.metrics.ownRenewableSelfConsumption).toBeCloseTo(0.75, 9);
  });

  it("carries the cost/emissions legs through, skipping the days a cell is null", () => {
    // One consumption edge (grid→load), 2 kWh/day for two days; day 2's cost is unknown.
    const d: DailyFlowMatrices = {
      sources: [node("source.grid")],
      loads: [node("load")],
      days: [
        {
          day: "2026-07-01",
          matrix: [[2]],
          emissionsG: [[900]],
          renewableKwh: [[0.5]],
          selfRenewableKwh: [[0]],
          costC: [[60]],
          estimatedKwh: [[0]],
        },
        {
          day: "2026-07-02",
          matrix: [[2]],
          emissionsG: [[700]],
          renewableKwh: [[0.5]],
          selfRenewableKwh: [[0]],
          costC: [[null]],
          estimatedKwh: [[0]],
        },
      ],
    };
    const r = reduceRenewablesMetrics(d)!;
    expect(r.consumptionKwh).toBeCloseTo(4, 9);
    // Cost: only day 1 counts, on both numerator and denominator → 60c / 2 kWh = 30 c/kWh.
    expect(r.costC).toBeCloseTo(60, 9);
    expect(r.avgCentsPerKwh).toBeCloseTo(30, 9);
    // Emissions: both days known → 1600 g / 4 kWh = 400 g/kWh.
    expect(r.emissionsG).toBeCloseTo(1600, 9);
    expect(r.kgCo2).toBeCloseTo(1.6, 9);
    expect(r.avgGramsPerKwh).toBeCloseTo(400, 9);
  });

  it("returns null for a legacy energy-only payload (no metric legs)", () => {
    const d: DailyFlowMatrices = {
      sources: [node("source.solar")],
      loads: [node("load")],
      days: [{ day: "2026-07-01", matrix: [[5]] }],
    };
    expect(reduceRenewablesMetrics(d)).toBeNull();
  });

  it("absent self_renewable leg → metrics 1-2 unavailable, metric 3 still computes", () => {
    // emissionsG present (modern payload) but selfRenewableKwh absent (older attributed payload).
    const d: DailyFlowMatrices = {
      sources: [node("source.solar")],
      loads: [node("load")],
      days: [
        {
          day: "2026-07-01",
          matrix: [[10]],
          emissionsG: [[0]],
          renewableKwh: [[10]],
          estimatedKwh: [[0]],
        },
      ],
    };
    const r = reduceRenewablesMetrics(d)!;
    expect(r.metrics.renewableAutarky).toBeNull();
    expect(r.metrics.ownRenewableSelfConsumption).toBeNull();
    expect(r.metrics.renewableShare).toBeCloseTo(1, 9); // 10/10
  });
});
