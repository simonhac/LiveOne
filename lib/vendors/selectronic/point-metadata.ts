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
      originId: "selectronic",
      originSubId: "solar_w",
      defaultName: "Solar",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: null,
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Solar Power - Remote (Inverter)
  {
    field: "solarInverterW",
    metadata: {
      originId: "selectronic",
      originSubId: "solarinverter_w",
      defaultName: "Solar Remote",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: "remote",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Solar Power - Local (Shunt)
  {
    field: "shuntW",
    metadata: {
      originId: "selectronic",
      originSubId: "shunt_w",
      defaultName: "Solar Local",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: "local",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Load Power
  {
    field: "loadW",
    metadata: {
      originId: "selectronic",
      originSubId: "load_w",
      defaultName: "Load",
      subsystem: "load",
      type: "load",
      subtype: null,
      extension: null,
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Battery Power
  {
    field: "batteryW",
    metadata: {
      originId: "selectronic",
      originSubId: "battery_w",
      defaultName: "Battery",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: null,
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Grid Power
  {
    field: "gridW",
    metadata: {
      originId: "selectronic",
      originSubId: "grid_w",
      defaultName: "Grid",
      subsystem: "grid",
      type: "bidi",
      subtype: "grid",
      extension: null,
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
      originId: "selectronic",
      originSubId: "battery_soc",
      defaultName: "Battery",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: null,
      metricType: "soc",
      metricUnit: "%",
      transform: null,
    },
  },

  // Fault Code
  {
    field: "faultCode",
    metadata: {
      originId: "selectronic",
      originSubId: "fault_code",
      defaultName: "Fault Code",
      subsystem: "system",
      type: null,
      subtype: null,
      extension: null,
      metricType: "code",
      metricUnit: "text",
      transform: null,
    },
  },

  // Fault Timestamp (stored as milliseconds since epoch)
  {
    field: "faultTimestamp",
    metadata: {
      originId: "selectronic",
      originSubId: "fault_ts",
      defaultName: "Fault Time",
      subsystem: "system",
      type: null,
      subtype: null,
      extension: null,
      metricType: "time",
      metricUnit: "epochMs",
      transform: null,
    },
  },

  // Generator Status
  {
    field: "generatorStatus",
    metadata: {
      originId: "selectronic",
      originSubId: "gen_status",
      defaultName: "Generator Status",
      subsystem: "generator",
      type: null,
      subtype: null,
      extension: null,
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
      originId: "selectronic",
      originSubId: "solar_wh_total",
      defaultName: "Solar",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: null,
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "loadKwhTotal",
    metadata: {
      originId: "selectronic",
      originSubId: "load_wh_total",
      defaultName: "Load",
      subsystem: "load",
      type: "load",
      subtype: null,
      extension: null,
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "batteryInKwhTotal",
    metadata: {
      originId: "selectronic",
      originSubId: "battery_in_wh_total",
      defaultName: "Battery Charge",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: "charge",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "batteryOutKwhTotal",
    metadata: {
      originId: "selectronic",
      originSubId: "battery_out_wh_total",
      defaultName: "Battery Discharge",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: "discharge",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "gridInKwhTotal",
    metadata: {
      originId: "selectronic",
      originSubId: "grid_in_wh_total",
      defaultName: "Import",
      subsystem: "grid",
      type: "bidi",
      subtype: "grid",
      extension: "import",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d",
    },
  },
  {
    field: "gridOutKwhTotal",
    metadata: {
      originId: "selectronic",
      originSubId: "grid_out_wh_total",
      defaultName: "Export",
      subsystem: "grid",
      type: "bidi",
      subtype: "grid",
      extension: "export",
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
