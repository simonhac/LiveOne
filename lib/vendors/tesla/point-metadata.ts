/**
 * Tesla Point Metadata Configuration
 *
 * Defines all monitoring points collected from Tesla vehicles.
 * Each entry maps a field from the Tesla API to point_info metadata.
 */

import type { PointMetadata } from "@/lib/point/point-manager";
import type { TeslaVehicleData } from "./types";

export interface TeslaPointConfig {
  // Path to extract value from TeslaVehicleData
  extract: (data: TeslaVehicleData) => number | string | boolean | null;
  // Metadata for point_info table
  metadata: PointMetadata;
}

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

  // ============================================================================
  // CHARGE METRICS
  // ============================================================================
  {
    extract: (data) => data.charge_state.charge_amps,
    metadata: {
      physicalPathTail: "charge_amps",
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
