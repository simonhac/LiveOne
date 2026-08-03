import { describe, it, expect } from "@jest/globals";
import { TESLA_POINTS, getPointMetadata } from "../point-metadata";
import type { TeslaChargeState, TeslaVehicleData } from "../types";

/**
 * Realistic snapshot of a vehicle_data payload for device rid 10 ("Tez"), values taken from
 * the archived `sessions.response` records (2026-07-04..08-03): plugged in, charge complete,
 * 43.59 kWh added this cable session.
 */
const vehicleData: TeslaVehicleData = {
  id: 1492931718143539,
  vehicle_id: 1689123456,
  vin: "5YJSA1E26HF000000",
  display_name: "Tez",
  state: "online",
  charge_state: {
    battery_level: 82,
    charging_state: "Complete",
    charge_port_latch: "Engaged",
    charge_amps: 32,
    charger_actual_current: 0,
    charger_power: 0,
    charge_rate: 0,
    time_to_full_charge: 0,
    charger_voltage: 241,
    charge_limit_soc: 90,
    charge_energy_added: 43.59,
  },
  drive_state: {
    latitude: -37.8,
    longitude: 144.9,
    speed: null,
    heading: 0,
    shift_state: null,
  },
  vehicle_state: {
    odometer: 51234.7,
    locked: true,
    car_version: "2025.20.9",
  },
};

function withChargeState(
  overrides: Partial<TeslaChargeState>,
): TeslaVehicleData {
  return {
    ...vehicleData,
    charge_state: { ...vehicleData.charge_state, ...overrides },
  };
}

function pointFor(physicalPathTail: string) {
  const point = TESLA_POINTS.find(
    (p) => p.metadata.physicalPathTail === physicalPathTail,
  );
  if (!point) throw new Error(`no TESLA_POINTS entry for ${physicalPathTail}`);
  return point;
}

describe("ev.charge/active (charging_active)", () => {
  const point = pointFor("charging_active");

  // "Starting" counts as active: it is observed in the wild and treating it as inactive
  // would make the charge switch read OFF for the first seconds after charge_start.
  const cases: Array<[TeslaChargeState["charging_state"], boolean]> = [
    ["Starting", true],
    ["Charging", true],
    ["Disconnected", false],
    ["NoPower", false],
    ["Stopped", false],
    ["Complete", false],
  ];

  it.each(cases)("charging_state %s -> %s", (chargingState, expected) => {
    const value = point.extract(
      withChargeState({ charging_state: chargingState }),
    );
    // Must be an actual boolean: it persists as 1/0 via Number(rawValue) in
    // convertValueByMetadata, and `false` must still emit a reading (the adapter skips
    // only null/undefined).
    expect(typeof value).toBe("boolean");
    expect(value).toBe(expected);
  });

  it("pins the metadata", () => {
    expect(point.metadata).toMatchObject({
      physicalPathTail: "charging_active",
      logicalPathStem: "ev.charge",
      metricType: "active",
      metricUnit: "boolean",
      subsystem: "ev",
      transform: null,
    });
  });

  it("is reachable via getPointMetadata", () => {
    expect(getPointMetadata("charging_active")).toBe(point.metadata);
  });
});

describe("ev.charge/added (charge_energy_added)", () => {
  const point = pointFor("charge_energy_added");

  it("passes the counter through numerically", () => {
    expect(point.extract(vehicleData)).toBe(43.59);
  });

  it("emits 0 as 0, not null (0 must survive the adapter's null-skip)", () => {
    const value = point.extract(withChargeState({ charge_energy_added: 0 }));
    expect(value).toBe(0);
    expect(value).not.toBeNull();
  });

  it("pins the metadata", () => {
    // transform stays null (a gauge). 'd' would null avg/min/max and emit unclamped
    // negative deltas: the counter decays with vampire drain while plugged in and idle
    // (1148 decreases over 2041 idle pairs) and resets to ~0 on each new cable session.
    expect(point.metadata).toMatchObject({
      physicalPathTail: "charge_energy_added",
      logicalPathStem: "ev.charge",
      metricType: "added",
      metricUnit: "kWh",
      subsystem: "ev",
      transform: null,
    });
  });
});

describe("TESLA_POINTS identity", () => {
  // physicalPathTail feeds derivePointUid, so a rename orphans the point's history.
  // logicalPathStem/metricType/metricUnit are frozen at mint and never refreshed.
  it("has exactly the expected physical path tails", () => {
    expect(
      new Set(TESLA_POINTS.map((p) => p.metadata.physicalPathTail)),
    ).toEqual(
      new Set([
        "battery_soc",
        "charge_limit_soc",
        "plugged_in",
        "charging_state",
        "charging_active",
        "charge_amps",
        "charger_actual_current",
        "charge_power_kw",
        "charge_rate",
        "time_to_full",
        "charge_energy_added",
        "speed",
        "shift_state",
        "odometer",
      ]),
    );
  });

  it("has unique physical path tails", () => {
    const tails = TESLA_POINTS.map((p) => p.metadata.physicalPathTail);
    expect(new Set(tails).size).toBe(tails.length);
  });

  it("has unique (logicalPathStem, metricType) pairs", () => {
    // Mirrors the DB constraint points_device_logical_metric_unique.
    const pairs = TESLA_POINTS.map(
      (p) => `${p.metadata.logicalPathStem}/${p.metadata.metricType}`,
    );
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
