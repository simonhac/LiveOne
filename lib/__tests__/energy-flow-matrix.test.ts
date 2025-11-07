import { describe, it, expect } from "@jest/globals";
import {
  calculateEnergyFlowMatrix,
  EnergyFlowMatrix,
} from "../energy-flow-matrix";
import { ProcessedMondoData } from "../mondo-data-processor";
import { ChartData } from "@/components/MondoPowerChart";

describe("calculateEnergyFlowMatrix", () => {
  it("should return null for missing generation or load data", () => {
    const data: ProcessedMondoData = {
      generation: null,
      load: null,
    };

    const result = calculateEnergyFlowMatrix(data);
    expect(result).toBeNull();
  });

  it("should return null for empty series", () => {
    const data: ProcessedMondoData = {
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

    const data: ProcessedMondoData = {
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

    const data: ProcessedMondoData = {
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

    const data: ProcessedMondoData = {
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

    const data: ProcessedMondoData = {
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

    const data: ProcessedMondoData = {
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

    const data: ProcessedMondoData = {
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

    const data: ProcessedMondoData = {
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
});
