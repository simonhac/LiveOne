/**
 * Tesla Point Metadata Configuration
 *
 * Defines all monitoring points collected from Tesla vehicles.
 * Each entry maps a field from the Tesla API to point_info metadata.
 */

import type { PointMetadata } from "@/lib/point/point-manager";
import type { TeslaChargeState, TeslaVehicleData } from "./types";

export interface TeslaPointConfig {
  // Path to extract value from TeslaVehicleData
  extract: (data: TeslaVehicleData) => number | string | boolean | null;
  // Metadata for point_info table
  metadata: PointMetadata;
}

// charging_state values that mean "energy is (about to be) flowing". "Starting" is real and
// observed in the archive (e.g. 2026-07-09 22:15 on rid 10); treating it as inactive would make
// the switch read OFF for the first seconds after charge_start. Everything else
// (Disconnected | NoPower | Stopped | Complete — and any future unknown state) reads false.
const ACTIVE_CHARGE_STATES = new Set<TeslaChargeState["charging_state"]>([
  "Starting",
  "Charging",
]);

/**
 * Monitoring points for Tesla vehicles
 */
export const TESLA_POINTS: TeslaPointConfig[] = [
  // ============================================================================
  // BATTERY
  // ============================================================================
  {
    extract: (data) => data.charge_state.battery_level,
    metadata: {
      physicalPathTail: "battery_soc",
      logicalPathStem: "ev.battery",
      metricType: "soc",
      metricUnit: "%",
      defaultName: "Battery SoC",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    extract: (data) => data.charge_state.charge_limit_soc,
    metadata: {
      physicalPathTail: "charge_limit_soc",
      logicalPathStem: "ev.charge.limit",
      metricType: "soc",
      metricUnit: "%",
      defaultName: "Charge Limit SoC",
      subsystem: "ev",
      transform: null,
      // Writable: Tesla accepts 50–100 for set_charge_limit (TeslaClient clamps + rounds).
      control: { kind: "number", min: 50, max: 100, step: 1 },
    },
  },

  // ============================================================================
  // CHARGE STATUS
  // ============================================================================
  {
    extract: (data) => data.charge_state.charge_port_latch === "Engaged",
    metadata: {
      physicalPathTail: "plugged_in",
      logicalPathStem: "ev.charge",
      metricType: "engaged",
      metricUnit: "boolean",
      defaultName: "Plugged In",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    extract: (data) => data.charge_state.charging_state,
    metadata: {
      physicalPathTail: "charging_state",
      logicalPathStem: "ev.charge",
      metricType: "state",
      metricUnit: "text",
      defaultName: "Charging State",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    // A NEW boolean rather than a control on the text point `ev.charge/state`: text points
    // persist as NULL in point_readings (the raw observation payload carries only the numeric
    // value — see point-manager.ts insertPointReadingsRaw), and the charge switch needs a clean
    // 1/0 readback with real history. Booleans store as 1/0 (convertValueByMetadata).
    extract: (data) =>
      ACTIVE_CHARGE_STATES.has(data.charge_state.charging_state),
    metadata: {
      physicalPathTail: "charging_active",
      logicalPathStem: "ev.charge",
      metricType: "active",
      metricUnit: "boolean",
      defaultName: "Charging",
      subsystem: "ev",
      transform: null,
      // Writable: turn_on → charge_start, turn_off → charge_stop.
      control: { kind: "switch" },
    },
  },

  // ============================================================================
  // CHARGE METRICS
  // ============================================================================
  {
    extract: (data) => data.charge_state.charge_amps,
    metadata: {
      physicalPathTail: "charge_amps",
      logicalPathStem: "ev.charge.limit",
      metricType: "current",
      metricUnit: "A",
      defaultName: "Charge Limit Current",
      subsystem: "ev",
      transform: null,
      // Writable: set_charging_amps. 48 A is the Model X on-board-charger ceiling and matches
      // the dialog's own cap; TeslaClient clamps at >= 0 regardless.
      control: { kind: "number", min: 0, max: 48, step: 1 },
    },
  },
  {
    extract: (data) => data.charge_state.charger_actual_current,
    metadata: {
      physicalPathTail: "charger_actual_current",
      logicalPathStem: "ev.charge",
      metricType: "current",
      metricUnit: "A",
      defaultName: "Charge Current",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    extract: (data) => data.charge_state.charger_power,
    metadata: {
      physicalPathTail: "charge_power_kw",
      logicalPathStem: "ev.charge",
      metricType: "power",
      metricUnit: "kW",
      defaultName: "Charge Power",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    extract: (data) => data.charge_state.charge_rate,
    metadata: {
      physicalPathTail: "charge_rate",
      logicalPathStem: "ev.charge",
      metricType: "rate",
      metricUnit: "mi/hr",
      defaultName: "Charge Rate",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    extract: (data) => data.charge_state.time_to_full_charge,
    metadata: {
      physicalPathTail: "time_to_full",
      logicalPathStem: "ev.charge",
      metricType: "remaining",
      metricUnit: "hours",
      defaultName: "Time to Full",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    // charge_state.charge_energy_added — kWh added this charge session. Measured behaviour
    // (30 days of archived payloads, device rid 10, 2026-07-04..08-03):
    //   - present in every payload (3871/3871), never null; observed range 0..46.01;
    //   - strictly non-decreasing WHILE charging_state == "Charging" (0 decreases in 583
    //     consecutive-charging pairs);
    //   - DECAYS while plugged in and idle (Complete/Stopped): 1148 decreases across 2041
    //     idle pairs, worst -0.42 kWh in one 5-12 min step — it behaves like "energy above
    //     the plug-in baseline", sagging with vampire drain and re-rising on top-ups;
    //   - does NOT reset on a top-up restart within one cable session (Complete→Starting at
    //     42.6 kWh observed);
    //   - resets to ~0 at the first charge start after a replug (45.02→0.66, 18.24→0.33,
    //     26.56→0, 10.27→0.87); usually retains its final value while Disconnected, though
    //     one reset-at-unplug was observed (31.47→0).
    // Hence transform: null (a gauge), NOT 'd': aggregate5mForPoint computes 'd' deltas as
    // last − previousLast with no clamp, so the idle decay and the per-plug-in reset would
    // emit a stream of negative deltas.
    extract: (data) => data.charge_state.charge_energy_added,
    metadata: {
      physicalPathTail: "charge_energy_added",
      logicalPathStem: "ev.charge",
      metricType: "added",
      metricUnit: "kWh",
      defaultName: "Energy Added",
      subsystem: "ev",
      transform: null,
    },
  },

  // ============================================================================
  // DRIVE STATE
  // ============================================================================
  {
    extract: (data) => data.drive_state.speed ?? 0,
    metadata: {
      physicalPathTail: "speed",
      logicalPathStem: "ev",
      metricType: "speed",
      metricUnit: "mph",
      defaultName: "Speed",
      subsystem: "ev",
      transform: null,
    },
  },
  {
    // `?? "P"` matters: the adapter skips null extracts, so a bare null would
    // leave a stale "D" in the KV latest map forever after a drive ends.
    extract: (data) => data.drive_state.shift_state ?? "P",
    metadata: {
      physicalPathTail: "shift_state",
      logicalPathStem: "ev",
      metricType: "shift",
      metricUnit: "text",
      defaultName: "Shift State",
      subsystem: "ev",
      transform: null,
    },
  },

  // ============================================================================
  // VEHICLE STATE
  // ============================================================================
  {
    extract: (data) => data.vehicle_state.odometer,
    metadata: {
      physicalPathTail: "odometer",
      logicalPathStem: "ev",
      metricType: "odometer",
      metricUnit: "miles",
      defaultName: "Odometer",
      subsystem: "ev",
      transform: null,
    },
  },
];

/**
 * Helper to get metadata for a specific physical path
 */
export function getPointMetadata(
  physicalPathTail: string,
): PointMetadata | undefined {
  return TESLA_POINTS.find(
    (p) => p.metadata.physicalPathTail === physicalPathTail,
  )?.metadata;
}
