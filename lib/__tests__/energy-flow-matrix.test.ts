import { describe, it, expect } from "@jest/globals";
import {
  calculateEnergyFlowMatrix,
  combineSolarSources,
  reduceEdgeProvenance,
  reduceLoadProvenance,
  sumDailyFlowMatrices,
  sumDailyFlowMatricesWithMetrics,
  EnergyFlowMatrix,
  DailyFlowMatrices,
} from "../energy-flow-matrix";
import { ProcessedSiteData } from "../site-data-processor";
import { ChartData } from "@/lib/charts/types";

describe("calculateEnergyFlowMatrix", () => {
  it("should return null for missing generation or load data", () => {
    const data: ProcessedSiteData = {
      generation: null,
      load: null,
    };

    const result = calculateEnergyFlowMatrix(data);
    expect(result).toBeNull();
  });

  it("should return null for empty series", () => {
    const data: ProcessedSiteData = {
      generation: {
        timestamps: [],
        series: [],
        mode: "power",
      },
      load: {
        timestamps: [],
        series: [],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);
    expect(result).toBeNull();
  });

  it("should calculate energy for single source and single load", () => {
    // Simple case: 1 kW solar, 1 kW load, for 1 hour
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T13:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "solar",
            description: "Solar",
            data: [1.0, 1.0], // 1 kW constant
            color: "yellow",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "load",
            description: "Load",
            data: [1.0, 1.0], // 1 kW constant
            color: "purple",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);

    expect(result).not.toBeNull();
    expect(result!.sources).toHaveLength(1);
    expect(result!.loads).toHaveLength(1);
    expect(result!.matrix[0][0]).toBeCloseTo(1.0, 2); // 1 kWh
    expect(result!.sourceTotals[0]).toBeCloseTo(1.0, 2);
    expect(result!.loadTotals[0]).toBeCloseTo(1.0, 2);
    expect(result!.totalEnergy).toBeCloseTo(1.0, 2);
  });

  it("should distribute energy proportionally with multiple sources", () => {
    // 2 sources: 60% solar (3kW), 40% battery (2kW), for 1 hour
    // 1 load: 5kW
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T13:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "solar",
            description: "Solar",
            data: [3.0, 3.0], // 60% of generation
            color: "yellow",
          },
          {
            id: "battery",
            description: "Battery",
            data: [2.0, 2.0], // 40% of generation
            color: "blue",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "load",
            description: "Load",
            data: [5.0, 5.0],
            color: "purple",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);

    expect(result).not.toBeNull();

    // Solar provides 60% of load's 5 kWh = 3 kWh
    expect(result!.matrix[0][0]).toBeCloseTo(3.0, 2);

    // Battery provides 40% of load's 5 kWh = 2 kWh
    expect(result!.matrix[1][0]).toBeCloseTo(2.0, 2);

    // Totals should match
    expect(result!.sourceTotals[0]).toBeCloseTo(3.0, 2);
    expect(result!.sourceTotals[1]).toBeCloseTo(2.0, 2);
    expect(result!.loadTotals[0]).toBeCloseTo(5.0, 2);
    expect(result!.totalEnergy).toBeCloseTo(5.0, 2);
  });

  it("should handle multiple loads correctly", () => {
    // 1 source: 10kW solar for 1 hour
    // 2 loads: 6kW and 4kW
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T13:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "solar",
            description: "Solar",
            data: [10.0, 10.0],
            color: "yellow",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "load1",
            description: "Load 1",
            data: [6.0, 6.0],
            color: "purple",
          },
          {
            id: "load2",
            description: "Load 2",
            data: [4.0, 4.0],
            color: "red",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);

    expect(result).not.toBeNull();

    // Solar provides all energy to both loads
    expect(result!.matrix[0][0]).toBeCloseTo(6.0, 2); // to load1
    expect(result!.matrix[0][1]).toBeCloseTo(4.0, 2); // to load2

    expect(result!.sourceTotals[0]).toBeCloseTo(10.0, 2);
    expect(result!.loadTotals[0]).toBeCloseTo(6.0, 2);
    expect(result!.loadTotals[1]).toBeCloseTo(4.0, 2);
    expect(result!.totalEnergy).toBeCloseTo(10.0, 2);
  });

  it("should handle varying power over time", () => {
    // Solar ramps up: 0kW -> 2kW over 1 hour
    // Load constant: 1kW
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T13:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "solar",
            description: "Solar",
            data: [0.0, 2.0], // Average 1kW over interval
            color: "yellow",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "load",
            description: "Load",
            data: [1.0, 1.0],
            color: "purple",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);

    expect(result).not.toBeNull();

    // Trapezoidal: ((0 + 2) / 2) * 1h = 1 kWh from solar
    // But solar at t=0 is 0, so proportion is undefined
    // This interval should be skipped due to zero generation
    expect(result!.matrix[0][0]).toBeCloseTo(0.0, 2);
  });

  it("should allocate on a source's left endpoint and skip only where it has no datum", () => {
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T13:00:00Z"),
      new Date("2025-01-01T14:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "solar",
            description: "Solar",
            data: [1.0, null, 1.0], // Null in middle
            color: "yellow",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "load",
            description: "Load",
            data: [1.0, 1.0, 1.0],
            color: "purple",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);

    expect(result).not.toBeNull();

    // First interval: solar's right endpoint is null but its LEFT one is not, so the load's 1 kWh is
    // attributed to it in full — the same datum that puts solar in the denominator earns it the edge.
    // Second interval: solar has no datum at the left endpoint, so there is nothing to attribute to
    // and it is skipped.
    expect(result!.matrix[0][0]).toBeCloseTo(1.0, 2);
  });

  it("should handle complex multi-source multi-load scenario", () => {
    // 30 minute intervals (0.5 hours each)
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T12:30:00Z"),
      new Date("2025-01-01T13:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "solar",
            description: "Solar",
            data: [4.0, 6.0, 8.0], // Increasing
            color: "yellow",
          },
          {
            id: "battery",
            description: "Battery Discharge",
            data: [1.0, 2.0, 2.0], // Increasing then constant
            color: "blue",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "hvac",
            description: "HVAC",
            data: [2.0, 3.0, 4.0],
            color: "purple",
          },
          {
            id: "ev",
            description: "EV",
            data: [3.0, 5.0, 6.0],
            color: "red",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);

    expect(result).not.toBeNull();

    // Interval 1 (12:00-12:30, 0.5h):
    //   Total gen: 4 + 1 = 5 kW (80% solar, 20% battery)
    //   HVAC: ((2+3)/2) * 0.5 = 1.25 kWh -> 1.0 from solar, 0.25 from battery
    //   EV: ((3+5)/2) * 0.5 = 2.0 kWh -> 1.6 from solar, 0.4 from battery

    // Interval 2 (12:30-13:00, 0.5h):
    //   Total gen: 6 + 2 = 8 kW (75% solar, 25% battery)
    //   HVAC: ((3+4)/2) * 0.5 = 1.75 kWh -> 1.3125 from solar, 0.4375 from battery
    //   EV: ((5+6)/2) * 0.5 = 2.75 kWh -> 2.0625 from solar, 0.6875 from battery

    // Solar total: 1.0 + 1.6 + 1.3125 + 2.0625 = 5.975 kWh
    // Battery total: 0.25 + 0.4 + 0.4375 + 0.6875 = 1.775 kWh

    expect(result!.sourceTotals[0]).toBeCloseTo(5.975, 2); // Solar
    expect(result!.sourceTotals[1]).toBeCloseTo(1.775, 2); // Battery
    expect(result!.loadTotals[0]).toBeCloseTo(3.0, 2); // HVAC
    expect(result!.loadTotals[1]).toBeCloseTo(4.75, 2); // EV
    expect(result!.totalEnergy).toBeCloseTo(7.75, 2);
  });

  it("should preserve source and load metadata", () => {
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T13:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "test.solar.id",
            description: "Solar Panel Array",
            data: [1.0, 1.0],
            color: "rgb(255, 255, 0)",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "test.load.id",
            description: "Main Load",
            data: [1.0, 1.0],
            color: "rgb(128, 0, 128)",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data);

    expect(result).not.toBeNull();
    expect(result!.sources[0]).toEqual({
      id: "test.solar.id",
      label: "Solar Panel Array",
      color: "rgb(255, 255, 0)",
    });
    expect(result!.loads[0]).toEqual({
      id: "test.load.id",
      label: "Main Load",
      color: "rgb(128, 0, 128)",
    });
  });

  it("does not double-count solar: uses leaves over the bare total, attributing correctly", () => {
    // Device exposes a bare total source.solar (= local + remote) AND the two leaves, plus a
    // discharging battery. Summing bare+leaves would inflate solar's share and starve the
    // battery; using the leaves attributes the load truthfully.
    const timestamps = [
      new Date("2025-01-01T12:00:00Z"),
      new Date("2025-01-01T13:00:00Z"),
    ];

    const data: ProcessedSiteData = {
      generation: {
        timestamps,
        series: [
          {
            id: "1/source.solar/power.avg",
            description: "Solar",
            data: [8, 8],
            color: "y",
          },
          {
            id: "1/source.solar.local/power.avg",
            description: "Solar Local",
            data: [5, 5],
            color: "y1",
          },
          {
            id: "1/source.solar.remote/power.avg",
            description: "Solar Remote",
            data: [3, 3],
            color: "y2",
          },
          {
            id: "1/bidi.battery.discharge/power.avg",
            description: "Battery Discharge",
            data: [2, 2],
            color: "g",
          },
        ],
        mode: "power",
      },
      load: {
        timestamps,
        series: [
          {
            id: "1/load/power.avg",
            description: "Load",
            data: [10, 10],
            color: "p",
          },
        ],
        mode: "power",
      },
    };

    const result = calculateEnergyFlowMatrix(data)!;
    expect(result).not.toBeNull();

    // The bare total is dropped; the two leaves stand in for solar (5 + 3 == 8 → no residual).
    const solarIds = result.sources
      .map((s) => s.id)
      .filter((id) => id.includes("solar"));
    expect(solarIds).toEqual(["source.solar.local", "source.solar.remote"]);

    const localIdx = result.sources.findIndex(
      (s) => s.id === "source.solar.local",
    );
    const remoteIdx = result.sources.findIndex(
      (s) => s.id === "source.solar.remote",
    );
    const batteryIdx = result.sources.findIndex((s) =>
      s.id.includes("battery"),
    );

    // True 8 kW solar (5+3) and 2 kW battery shares of the 10 kWh load — not inflated.
    expect(result.sourceTotals[localIdx]).toBeCloseTo(5, 6);
    expect(result.sourceTotals[remoteIdx]).toBeCloseTo(3, 6);
    expect(result.sourceTotals[batteryIdx]).toBeCloseTo(2, 6);
    expect(result.totalEnergy).toBeCloseTo(10, 6);
  });
});

describe("combineSolarSources", () => {
  // Build a minimal matrix from source/load ids + a dense [src][load] grid, deriving the totals the
  // same way matrixWithTotals does so the fixtures are internally consistent.
  const build = (
    sourceIds: string[],
    loadIds: string[],
    matrix: number[][],
  ): EnergyFlowMatrix => {
    const sources = sourceIds.map((id) => ({ id, label: id, color: "#000" }));
    const loads = loadIds.map((id) => ({ id, label: id, color: "#000" }));
    const sourceTotals = matrix.map((row) => row.reduce((a, b) => a + b, 0));
    const loadTotals = loads.map((_, l) =>
      matrix.reduce((a, row) => a + (row[l] ?? 0), 0),
    );
    const totalEnergy = sourceTotals.reduce((a, b) => a + b, 0);
    return { sources, loads, matrix, sourceTotals, loadTotals, totalEnergy };
  };

  it("collapses solar leaves + residual into one Solar source, summing the rows", () => {
    // sources: solar.local, battery(discharge), solar.remote, solar.residual; loads: load, load.battery
    const m = build(
      [
        "source.solar.local",
        "source.battery",
        "source.solar.remote",
        "source.solar.residual",
      ],
      ["load", "load.battery"],
      [
        [4, 1], // solar.local
        [2, 0], // battery
        [3, 0], // solar.remote
        [1, 0], // solar.residual
      ],
    );

    const out = combineSolarSources(m);

    // One combined Solar node at the FIRST solar position; battery follows.
    expect(out.sources.map((s) => s.id)).toEqual([
      "source.solar",
      "source.battery",
    ]);
    expect(out.sources[0].label).toBe("Solar");
    expect(out.sources[0].color).toBeTruthy(); // canonical solar color, not empty/gray fallback

    // Combined row = local + remote + residual, element-wise across loads.
    expect(out.matrix).toEqual([
      [8, 1],
      [2, 0],
    ]);
    expect(out.sourceTotals).toEqual([9, 2]);

    // Loads are untouched: column sums (and grand total) are invariant under summing rows.
    expect(out.loadTotals).toEqual([10, 1]);
    expect(out.loads).toEqual(m.loads);
    expect(out.totalEnergy).toBe(11);
  });

  it("places the combined node at the first solar index, preserving non-solar order", () => {
    const m = build(
      ["source.grid", "source.solar.local", "source.solar.remote"],
      ["load"],
      [[1], [2], [3]],
    );

    const out = combineSolarSources(m);

    expect(out.sources.map((s) => s.id)).toEqual([
      "source.grid",
      "source.solar",
    ]);
    expect(out.matrix).toEqual([[1], [5]]);
    expect(out.sourceTotals).toEqual([1, 5]);
  });

  it("is a no-op (returns the same matrix) with one solar source", () => {
    const m = build(
      ["source.solar.local", "source.battery"],
      ["load"],
      [[5], [2]],
    );
    expect(combineSolarSources(m)).toBe(m);
  });

  it("is a no-op with the bare source.solar total only", () => {
    const m = build(["source.solar", "source.grid"], ["load"], [[5], [2]]);
    expect(combineSolarSources(m)).toBe(m);
  });

  it("is a no-op with no solar sources", () => {
    const m = build(["source.grid", "source.battery"], ["load"], [[5], [2]]);
    expect(combineSolarSources(m)).toBe(m);
  });
});

describe("reduceEdgeProvenance", () => {
  // Two-day attributed payload. Sources: solar.local, grid, solar.remote; loads: house, battery.
  // Grid→battery on day 1 carries energy but NULL metric legs (unknown intensity) + estimated kWh —
  // the null-averaging / confidence path.
  const fixture = (): DailyFlowMatrices => ({
    sources: [
      { id: "source.solar.local", label: "Solar Local", color: "#000" },
      { id: "source.grid", label: "Grid", color: "#000" },
      { id: "source.solar.remote", label: "Solar Remote", color: "#000" },
    ],
    loads: [
      { id: "load.house", label: "House", color: "#000" },
      { id: "load.battery", label: "Battery", color: "#000" },
    ],
    days: [
      {
        day: "2025-01-01",
        matrix: [
          [2, 1], // solar.local
          [3, 2], // grid
          [1, 0], // solar.remote
        ],
        emissionsG: [
          [0, 0],
          [300, null], // grid→battery: intensity unknown
          [0, 0],
        ],
        renewableKwh: [
          [2, 1],
          [0, null],
          [1, 0],
        ],
        costC: [
          [0, 0],
          [90, null],
          [0, 0],
        ],
        estimatedKwh: [
          [0, 0],
          [0, 1], // grid→battery attributed with an estimated intensity
          [0, 0],
        ],
      },
      {
        day: "2025-01-02",
        matrix: [
          [1, 0],
          [4, 0],
          [2, 0],
        ],
        emissionsG: [
          [0, 0],
          [500, 0],
          [0, 0],
        ],
        renewableKwh: [
          [1, 0],
          [0, 0],
          [2, 0],
        ],
        costC: [
          [0, 0],
          [120, 0],
          [0, 0],
        ],
        estimatedKwh: [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      },
    ],
  });

  it("sums one edge's legs across days (grid → house)", () => {
    const edge = reduceEdgeProvenance(fixture(), "source.grid", "load.house")!;
    expect(edge).not.toBeNull();
    expect(edge.energyKwh).toBeCloseTo(7, 6); // 3 + 4
    expect(edge.kgCo2).toBeCloseTo(0.8, 6); // (300 + 500) / 1000
    expect(edge.avgGramsPerKwh).toBeCloseTo(800 / 7, 6);
    expect(edge.costC).toBeCloseTo(210, 6); // 90 + 120 (cents)
    expect(edge.avgCentsPerKwh).toBeCloseTo(30, 6); // 210 / 7
    expect(edge.pctRenewable).toBeCloseTo(0, 6); // no renewable kWh on the grid edge
    expect(edge.pctEstimated).toBeCloseTo(0, 6);
  });

  it("expands to every solar row when combineSolar folds them (solar → house)", () => {
    const edge = reduceEdgeProvenance(fixture(), "source.solar", "load.house", {
      combineSolar: true,
    })!;
    expect(edge.energyKwh).toBeCloseTo(6, 6); // local (2+1) + remote (1+2)
    expect(edge.pctRenewable).toBeCloseTo(100, 6); // fully renewable
    expect(edge.avgGramsPerKwh).toBeCloseTo(0, 6); // clean cells present → 0, not null
    expect(edge.kgCo2).toBeCloseTo(0, 6);
  });

  it("does NOT expand non-solar ids even when combineSolar is set", () => {
    const edge = reduceEdgeProvenance(fixture(), "source.grid", "load.house", {
      combineSolar: true,
    })!;
    expect(edge.energyKwh).toBeCloseTo(7, 6); // just the grid row
  });

  it("null intensity legs → null averages, and estimated kWh drives pctEstimated (grid → battery)", () => {
    const edge = reduceEdgeProvenance(
      fixture(),
      "source.grid",
      "load.battery",
    )!;
    expect(edge.energyKwh).toBeCloseTo(2, 6); // day-1 only (day-2 cell is 0)
    expect(edge.avgGramsPerKwh).toBeNull();
    expect(edge.kgCo2).toBeCloseTo(0, 6);
    expect(edge.avgCentsPerKwh).toBeNull();
    expect(edge.pctRenewable).toBeNull();
    expect(edge.pctEstimated).toBeCloseTo(50, 6); // 1 estimated / 2 total
  });

  it("returns null for an unknown source or load, or a legacy (leg-less) payload", () => {
    expect(
      reduceEdgeProvenance(fixture(), "source.nope", "load.house"),
    ).toBeNull();
    expect(
      reduceEdgeProvenance(fixture(), "source.grid", "load.nope"),
    ).toBeNull();
    const legacy: DailyFlowMatrices = {
      sources: [{ id: "source.grid", label: "Grid", color: "#000" }],
      loads: [{ id: "load.house", label: "House", color: "#000" }],
      days: [{ day: "2025-01-01", matrix: [[5]] }], // no metric legs
    };
    expect(
      reduceEdgeProvenance(legacy, "source.grid", "load.house"),
    ).toBeNull();
  });
});

describe("sumDailyFlowMatricesWithMetrics", () => {
  const nodes = () => ({
    sources: [
      { id: "source.solar", label: "Solar", color: "#000" },
      { id: "source.grid", label: "Grid", color: "#000" },
    ],
    loads: [
      { id: "load.house", label: "House", color: "#000" },
      { id: "load.grid", label: "Export", color: "#000" },
    ],
  });

  // Two days, every leg present, no nulls, every cell carrying energy — the pure-additivity case.
  const cleanFixture = (): DailyFlowMatrices => ({
    ...nodes(),
    days: [
      {
        day: "2025-01-01",
        matrix: [
          [2, 1], // solar
          [3, 2], // grid
        ],
        emissionsG: [
          [0, 10],
          [300, 200],
        ],
        renewableKwh: [
          [2, 1],
          [0, 0],
        ],
        selfRenewableKwh: [
          [2, 0],
          [0, 0],
        ],
        costC: [
          [0, 0],
          [90, 60],
        ],
        revenueC: [
          [0, 5],
          [0, 10],
        ],
        estimatedKwh: [
          [0, 0],
          [1, 0],
        ],
      },
      {
        day: "2025-01-02",
        matrix: [
          [1, 2],
          [4, 1],
        ],
        emissionsG: [
          [0, 20],
          [500, 100],
        ],
        renewableKwh: [
          [1, 2],
          [0, 0],
        ],
        selfRenewableKwh: [
          [1, 0],
          [0, 0],
        ],
        costC: [
          [0, 0],
          [120, 30],
        ],
        revenueC: [
          [0, 8],
          [0, 4],
        ],
        estimatedKwh: [
          [0, 0],
          [0.5, 0],
        ],
      },
    ],
  });

  // Three days: null cells on days 1/2 (unknown intensity), day 3 a LEGACY day (matrix only) — the
  // null-exclusion + whole-leg-missing paths.
  const mixedFixture = (): DailyFlowMatrices => ({
    ...nodes(),
    days: [
      {
        day: "2025-01-01",
        matrix: [
          [2, 1],
          [3, 2],
        ],
        emissionsG: [
          [0, null],
          [300, 200],
        ],
        renewableKwh: [
          [2, 1],
          [0, null],
        ],
        selfRenewableKwh: [
          [2, 0],
          [0, 0],
        ],
        costC: [
          [0, 0],
          [90, null],
        ],
        revenueC: [
          [null, 5],
          [null, 10],
        ],
        estimatedKwh: [
          [0, 0],
          [1, 0],
        ],
      },
      {
        day: "2025-01-02",
        matrix: [
          [1, 2],
          [4, 1],
        ],
        emissionsG: [
          [0, 20],
          [500, 100],
        ],
        renewableKwh: [
          [1, 2],
          [0, 0],
        ],
        selfRenewableKwh: [
          [1, 0],
          [0, 0],
        ],
        costC: [
          [0, 0],
          [null, 30],
        ],
        revenueC: [
          [null, 8],
          [null, 4],
        ],
        estimatedKwh: [
          [0, 0],
          [0, 0.5],
        ],
      },
      {
        day: "2025-01-03", // legacy day: no metric legs at all
        matrix: [
          [1, 1],
          [1, 1],
        ],
      },
    ],
  });

  it("adds every leg per cell across days when nothing is null (hand-computed)", () => {
    const out = sumDailyFlowMatricesWithMetrics(cleanFixture())!;
    expect(out).not.toBeNull();

    // Energy fold (2+1=3, 1+2=3, 3+4=7, 2+1=3).
    expect(out.matrix).toEqual([
      [3, 3],
      [7, 3],
    ]);
    expect(out.sourceTotals).toEqual([6, 10]);
    expect(out.loadTotals).toEqual([10, 6]);
    expect(out.totalEnergy).toBe(16);

    const m = out.metrics!;
    expect(m).toBeDefined();
    expect(m.emissionsG.matrix).toEqual([
      [0, 30],
      [800, 300],
    ]);
    expect(m.renewableKwh.matrix).toEqual([
      [3, 3],
      [0, 0],
    ]);
    expect(m.selfRenewableKwh.matrix).toEqual([
      [3, 0],
      [0, 0],
    ]);
    expect(m.costC.matrix).toEqual([
      [0, 0],
      [210, 90],
    ]);
    expect(m.revenueC.matrix).toEqual([
      [0, 13],
      [0, 14],
    ]);
    expect(m.estimatedKwh).toEqual([
      [0, 0],
      [1.5, 0],
    ]);

    // Nothing was null, so every metric's known-energy denominator IS the energy matrix.
    for (const leg of [
      m.emissionsG,
      m.renewableKwh,
      m.selfRenewableKwh,
      m.costC,
      m.revenueC,
    ]) {
      expect(leg.knownKwh).toEqual(out.matrix);
    }
  });

  it("excludes a null cell from the metric sum AND its energy from that metric's knownKwh", () => {
    const out = sumDailyFlowMatricesWithMetrics(mixedFixture())!;
    const m = out.metrics!;

    // grid→house cost: day 1 = 90 (3 kWh known), day 2 null (4 kWh excluded), day 3 legacy (1 kWh
    // excluded) — but the ENERGY matrix still includes all three days.
    expect(m.costC.matrix[1][0]).toBe(90);
    expect(m.costC.knownKwh[1][0]).toBe(3);
    expect(out.matrix[1][0]).toBe(8);

    // grid→export cost is the mirror: day 1 null, day 2 = 30 over 1 kWh.
    expect(m.costC.matrix[1][1]).toBe(30);
    expect(m.costC.knownKwh[1][1]).toBe(1);

    // A non-null ZERO still counts as known (grid→export renewable: day 1 null, day 2 zero).
    expect(m.renewableKwh.matrix[1][1]).toBe(0);
    expect(m.renewableKwh.knownKwh[1][1]).toBe(1);

    // A cell null on EVERY day stays null with a zero denominator (solar rows earn no revenue... on
    // load.house at least).
    expect(m.revenueC.matrix[0][0]).toBeNull();
    expect(m.revenueC.knownKwh[0][0]).toBe(0);

    // estimatedKwh is a plain sum; the legacy day contributes 0 (leg absent = nothing estimated).
    expect(m.estimatedKwh).toEqual([
      [0, 0],
      [1, 0.5],
    ]);
  });

  it("treats a whole-leg-missing day as all-null for the metrics", () => {
    const out = sumDailyFlowMatricesWithMetrics(mixedFixture())!;
    const m = out.metrics!;

    // grid→house emissions: days 1+2 known (300+500 over 3+4 kWh); the legacy day 3 (1 kWh) is
    // excluded from the metric AND its denominator, but present in the energy fold.
    expect(m.emissionsG.matrix[1][0]).toBe(800);
    expect(m.emissionsG.knownKwh[1][0]).toBe(7);
    expect(out.matrix[1][0]).toBe(8);
  });

  it("returns no metrics member for a fully legacy payload", () => {
    const legacy: DailyFlowMatrices = {
      ...nodes(),
      days: [
        {
          day: "2025-01-01",
          matrix: [
            [2, 1],
            [3, 2],
          ],
        },
        {
          day: "2025-01-02",
          matrix: [
            [1, 2],
            [4, 1],
          ],
        },
      ],
    };
    const out = sumDailyFlowMatricesWithMetrics(legacy)!;
    expect(out).not.toBeNull();
    expect(out.metrics).toBeUndefined();
    expect(out.matrix).toEqual([
      [3, 3],
      [7, 3],
    ]);
  });

  it("agrees exactly with sumDailyFlowMatrices on the energy fields", () => {
    for (const fixture of [cleanFixture(), mixedFixture()]) {
      const plain = sumDailyFlowMatrices(fixture)!;
      const withMetrics = sumDailyFlowMatricesWithMetrics(fixture)!;
      expect({
        sources: withMetrics.sources,
        loads: withMetrics.loads,
        matrix: withMetrics.matrix,
        sourceTotals: withMetrics.sourceTotals,
        loadTotals: withMetrics.loadTotals,
        totalEnergy: withMetrics.totalEnergy,
      }).toEqual(plain);
    }
  });

  it("column totals agree with reduceLoadProvenance for every load", () => {
    const fixture = mixedFixture();
    const out = sumDailyFlowMatricesWithMetrics(fixture)!;
    const m = out.metrics!;

    const colSum = (grid: (number | null)[][], l: number) =>
      grid.reduce((sum, row) => sum + (row[l] ?? 0), 0);

    fixture.loads.forEach((load, l) => {
      const summary = reduceLoadProvenance(fixture, load.id)!;
      expect(summary).not.toBeNull();

      expect(out.loadTotals[l]).toBeCloseTo(summary.energyKwh, 9);

      expect(colSum(m.costC.matrix, l)).toBeCloseTo(summary.costC, 9);
      expect(colSum(m.costC.knownKwh, l)).toBeCloseTo(summary.costKnownKwh, 9);

      expect(colSum(m.emissionsG.matrix, l) / 1000).toBeCloseTo(
        summary.kgCo2,
        9,
      );
      expect(colSum(m.emissionsG.knownKwh, l)).toBeCloseTo(
        summary.emissionsKnownKwh,
        9,
      );

      // Revenue: the reducer nulls the total when nothing was sold; the fold's column mirrors that
      // with an all-null column and a zero denominator.
      expect(colSum(m.revenueC.knownKwh, l)).toBeCloseTo(
        summary.revenueKnownKwh,
        9,
      );
      if (summary.revenueC === null) {
        expect(m.revenueC.matrix.every((row) => row[l] === null)).toBe(true);
      } else {
        expect(colSum(m.revenueC.matrix, l)).toBeCloseTo(summary.revenueC, 9);
      }

      // The reducer only exposes renewable/estimated as percentages — reconstruct them from the
      // fold's column sums and compare.
      const renewKnown = colSum(m.renewableKwh.knownKwh, l);
      if (summary.pctRenewable !== null) {
        expect(
          (100 * colSum(m.renewableKwh.matrix, l)) / renewKnown,
        ).toBeCloseTo(summary.pctRenewable, 9);
      } else {
        expect(renewKnown).toBe(0);
      }
      const estCol = m.estimatedKwh.reduce((sum, row) => sum + row[l], 0);
      expect((100 * estCol) / out.loadTotals[l]).toBeCloseTo(
        summary.pctEstimated,
        9,
      );
    });
  });

  it("returns null for an empty window", () => {
    const empty: DailyFlowMatrices = { ...nodes(), days: [] };
    expect(sumDailyFlowMatricesWithMetrics(empty)).toBeNull();
  });
});
