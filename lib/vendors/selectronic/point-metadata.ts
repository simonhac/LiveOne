/**
 * Selectronic Point Metadata Configuration
 *
 * This defines all metadata for the key monitoring points from Selectronic/Select.Live systems.
 * Each entry maps a field from the SelectronicData interface to point_info metadata.
 *
 * Based on system ID 1 (Daylesford) - Selectronic SP PRO
 */

import type { PointMetadata } from "@/lib/point/point-manager";

export interface SelectronicPointConfig {
  // Field name from SelectronicData interface
  field: keyof import("./selectronic-client").SelectronicData;
  // Metadata for point_info table
  metadata: PointMetadata;
}

/**
 * Monitoring points for Selectronic systems
 */
export const SELECTRONIC_POINTS: SelectronicPointConfig[] = [
  // ============================================================================
  // POWER METRICS (W)
  // ============================================================================

  // Solar Power - Total
  {
    field: "solarW",
    metadata: {
      physicalPathTail: "solar_w",
      logicalPathStem: "source.solar",
      defaultName: "Solar",
      subsystem: "solar",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Solar Power - Remote (Inverter)
  {
    field: "solarInverterW",
    metadata: {
      physicalPathTail: "solarinverter_w",
      logicalPathStem: "source.solar.remote",
      defaultName: "Solar Remote",
      subsystem: "solar",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Solar Power - Local (Shunt)
  {
    field: "shuntW",
    metadata: {
      physicalPathTail: "shunt_w",
      logicalPathStem: "source.solar.local",
      defaultName: "Solar Local",
      subsystem: "solar",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Load Power
  {
    field: "loadW",
    metadata: {
      physicalPathTail: "load_w",
      logicalPathStem: "load",
      defaultName: "Load",
      subsystem: "load",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Battery Power
  {
    field: "batteryW",
    metadata: {
      physicalPathTail: "battery_w",
      logicalPathStem: "bidi.battery",
      defaultName: "Battery",
      subsystem: "battery",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Grid Power
  {
    field: "gridW",
    metadata: {
      physicalPathTail: "grid_w",
      logicalPathStem: "bidi.grid",
      defaultName: "Grid",
      subsystem: "grid",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // ============================================================================
  // STATE METRICS
  // ============================================================================

  // Battery State of Charge
  {
    field: "batterySOC",
    metadata: {
      physicalPathTail: "battery_soc",
      logicalPathStem: "bidi.battery",
      defaultName: "Battery",
      subsystem: "battery",
      metricType: "soc",
      metricUnit: "%",
      transform: null,
    },
  },

  // Fault Code
  {
    field: "faultCode",
    metadata: {
      physicalPathTail: "fault_code",
      logicalPathStem: null,
      defaultName: "Fault Code",
      subsystem: "system",
      metricType: "code",
      metricUnit: "number",
      transform: null,
    },
  },

  // Fault Timestamp (stored as milliseconds since epoch)
  {
    field: "faultTimestamp",
    metadata: {
      physicalPathTail: "fault_ts",
      logicalPathStem: null,
      defaultName: "Fault Time",
      subsystem: "system",
      metricType: "time",
      metricUnit: "epochMs",
      transform: null,
    },
  },

  // Generator Status
  {
    field: "generatorStatus",
    metadata: {
      physicalPathTail: "gen_status",
      logicalPathStem: null,
      defaultName: "Generator Status",
      subsystem: "generator",
      metricType: "active",
      metricUnit: "bool",
      transform: null,
    },
  },

  // ============================================================================
  // LIFETIME ENERGY TOTALS (Wh) - Source data is kWh, converted to Wh in adapter
  // These are monotonically increasing lifetime totals - deltas are calculated for derived points
  // ============================================================================

  {
    field: "solarKwhTotal",
    metadata: {
      physicalPathTail: "solar_wh_total",
      logicalPathStem: "source.solar",
      defaultName: "Solar",
      subsystem: "solar",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "loadKwhTotal",
    metadata: {
      physicalPathTail: "load_wh_total",
      logicalPathStem: "load",
      defaultName: "Load",
      subsystem: "load",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "batteryInKwhTotal",
    metadata: {
      physicalPathTail: "battery_in_wh_total",
      logicalPathStem: "bidi.battery.charge",
      defaultName: "Battery Charge",
      subsystem: "battery",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "batteryOutKwhTotal",
    metadata: {
      physicalPathTail: "battery_out_wh_total",
      logicalPathStem: "bidi.battery.discharge",
      defaultName: "Battery Discharge",
      subsystem: "battery",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "gridInKwhTotal",
    metadata: {
      physicalPathTail: "grid_in_wh_total",
      logicalPathStem: "bidi.grid.import",
      defaultName: "Import",
      subsystem: "grid",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "gridOutKwhTotal",
    metadata: {
      physicalPathTail: "grid_out_wh_total",
      logicalPathStem: "bidi.grid.export",
      defaultName: "Export",
      subsystem: "grid",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
];

/**
 * Helper to get metadata for a specific field
 */
export function getPointMetadata(
  field: keyof import("./selectronic-client").SelectronicData,
): PointMetadata | undefined {
  return SELECTRONIC_POINTS.find((p) => p.field === field)?.metadata;
}
