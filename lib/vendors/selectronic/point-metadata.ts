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
      physicalPath: "selectronic/solar_w",
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
      physicalPath: "selectronic/solarinverter_w",
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
      physicalPath: "selectronic/shunt_w",
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
      physicalPath: "selectronic/load_w",
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
      physicalPath: "selectronic/battery_w",
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
      physicalPath: "selectronic/grid_w",
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
      physicalPath: "selectronic/battery_soc",
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
      physicalPath: "selectronic/fault_code",
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
      physicalPath: "selectronic/fault_ts",
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
      physicalPath: "selectronic/gen_status",
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
      physicalPath: "selectronic/solar_wh_total",
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
      physicalPath: "selectronic/load_wh_total",
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
      physicalPath: "selectronic/battery_in_wh_total",
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
      physicalPath: "selectronic/battery_out_wh_total",
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
      physicalPath: "selectronic/grid_in_wh_total",
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
      physicalPath: "selectronic/grid_out_wh_total",
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
