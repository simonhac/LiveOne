import { describe, it, expect } from "@jest/globals";
import {
  calculateEnergyFlowMatrix,
  combineSolarSources,
  EnergyFlowMatrix,
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

  it("should skip intervals with null values", () => {
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

    // First interval has null at end, second interval has null at start
    // Both should be skipped, so total should be 0
    expect(result!.matrix[0][0]).toBeCloseTo(0.0, 2);
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
    // System exposes a bare total source.solar (= local + remote) AND the two leaves, plus a
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
