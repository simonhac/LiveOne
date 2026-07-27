import { describe, it, expect } from "@jest/globals";
import { avgPowerWFromEnergy, planRunPeriodColumns } from "../run-period-view";

describe("avgPowerWFromEnergy", () => {
  it("derives average power from energy over duration", () => {
    // 3.3 kWh across exactly one hour = 3.3 kW.
    expect(avgPowerWFromEnergy(3.3, 3600)).toBeCloseTo(3300, 6);
    // Same energy in half the time = double the power.
    expect(avgPowerWFromEnergy(3.3, 1800)).toBeCloseTo(6600, 6);
  });

  it("reproduces the Daylesford 22 Jul run (~3.29 kW, not the 1.5 kW rpm÷1000 figure)", () => {
    // The regression this whole change exists for: the run showed 1.5 kW (1551 rpm ÷ 1000).
    expect(avgPowerWFromEnergy(3.29, 3600)).toBeCloseTo(3290, 6);
  });

  it("is null for an open run (no duration yet)", () => {
    expect(avgPowerWFromEnergy(1.5, null)).toBeNull();
    expect(avgPowerWFromEnergy(1.5, undefined)).toBeNull();
  });

  it("is null for an unmetered run (no energy)", () => {
    expect(avgPowerWFromEnergy(null, 3600)).toBeNull();
    expect(avgPowerWFromEnergy(undefined, 3600)).toBeNull();
  });

  it("is null — never Infinity — for a non-positive duration", () => {
    expect(avgPowerWFromEnergy(1.5, 0)).toBeNull();
    expect(avgPowerWFromEnergy(1.5, -60)).toBeNull();
  });

  it("keeps zero energy as zero power, not null", () => {
    expect(avgPowerWFromEnergy(0, 3600)).toBe(0);
  });
});

describe("planRunPeriodColumns", () => {
  it("collapses to one avg-power column when the signal IS power", () => {
    // A power-threshold site sees exactly today's table: one Avg Power column, no signal column.
    expect(
      planRunPeriodColumns({
        signalMetricType: "power",
        signalMetricUnit: "W",
        hasEnergyPoint: true,
      }),
    ).toEqual({ signal: false, avgPower: true, avgPowerBasis: "energy" });
  });

  it("falls back to the signal statistic for a power signal with no energy point", () => {
    // Pre-existing behaviour, now gated so it can only happen when the signal really is power.
    expect(
      planRunPeriodColumns({
        signalMetricType: "power",
        signalMetricUnit: "W",
        hasEnergyPoint: false,
      }),
    ).toEqual({ signal: false, avgPower: true, avgPowerBasis: "signal" });
  });

  it("shows both columns for a non-power signal with an energy point (Daylesford/rpm)", () => {
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        hasEnergyPoint: true,
      }),
    ).toEqual({ signal: true, avgPower: true, avgPowerBasis: "energy" });
  });

  it("shows only the signal column for a non-power signal with no energy point", () => {
    // No energy point and a non-power signal means no honest power figure exists at all — show the
    // signal, and omit the power column rather than filling it with dashes.
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        hasEnergyPoint: false,
      }),
    ).toEqual({ signal: true, avgPower: false, avgPowerBasis: "signal" });
  });

  it("fences out non-numeric signals whose mean would be meaningless", () => {
    for (const metricUnit of ["boolean", "text", "json", "epochMs"]) {
      expect(
        planRunPeriodColumns({
          signalMetricType: "status",
          signalMetricUnit: metricUnit,
          hasEnergyPoint: true,
        }).signal,
      ).toBe(false);
    }
  });

  it("degrades safely when the signal point has no point_info row", () => {
    expect(
      planRunPeriodColumns({
        signalMetricType: null,
        signalMetricUnit: null,
        hasEnergyPoint: true,
      }),
    ).toEqual({ signal: false, avgPower: true, avgPowerBasis: "energy" });
  });

  it("never advertises two power columns, over the whole input space", () => {
    const metricTypes = [null, "power", "speed", "temperature", "status"];
    const metricUnits = [null, "W", "rpm", "°C", "boolean", "text"];
    for (const signalMetricType of metricTypes) {
      for (const signalMetricUnit of metricUnits) {
        for (const hasEnergyPoint of [true, false]) {
          const c = planRunPeriodColumns({
            signalMetricType,
            signalMetricUnit,
            hasEnergyPoint,
          });
          // The invariant: a power signal is never rendered as both a signal column and a power column.
          const twoPowerColumns =
            c.signal && c.avgPower && signalMetricType === "power";
          expect(twoPowerColumns).toBe(false);
          // And a signal-basis avg power is only ever claimed for a real power signal.
          if (c.avgPower && c.avgPowerBasis === "signal") {
            expect(signalMetricType).toBe("power");
          }
        }
      }
    }
  });
});
