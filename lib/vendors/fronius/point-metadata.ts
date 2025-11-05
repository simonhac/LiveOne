/**
 * Fronius Point Metadata Configuration
 *
 * This defines all metadata for the key monitoring points from Fronius systems.
 * Each entry maps a field from the FroniusPushData interface to point_info metadata.
 *
 * Fronius systems push data to /api/push/fronius endpoint
 */

import type { PointMetadata } from "@/lib/monitoring-points-manager";

export interface FroniusPointConfig {
  // Field name from FroniusPushData interface
  field: keyof import("../../../app/api/push/fronius/route").FroniusPushData;
  // Metadata for point_info table
  metadata: PointMetadata;
}

/**
 * Monitoring points for Fronius systems
 */
export const FRONIUS_POINTS: FroniusPointConfig[] = [
  // ============================================================================
  // POWER METRICS (W)
  // ============================================================================

  // Solar Power - Total
  {
    field: "solarW",
    metadata: {
      originId: "fronius",
      originSubId: "solarW",
      defaultName: "Solar",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: null,
      metricType: "power",
      metricUnit: "W",
    },
  },

  // Solar Power - Remote (Inverter)
  {
    field: "solarRemoteW",
    metadata: {
      originId: "fronius",
      originSubId: "solarRemoteW",
      defaultName: "Solar Remote",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: "remote",
      metricType: "power",
      metricUnit: "W",
    },
  },

  // Solar Power - Local (Shunt/CT)
  {
    field: "solarLocalW",
    metadata: {
      originId: "fronius",
      originSubId: "solarLocalW",
      defaultName: "Solar Local",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: "local",
      metricType: "power",
      metricUnit: "W",
    },
  },

  // Load Power
  {
    field: "loadW",
    metadata: {
      originId: "fronius",
      originSubId: "loadW",
      defaultName: "Load",
      subsystem: "load",
      type: "load",
      subtype: null,
      extension: null,
      metricType: "power",
      metricUnit: "W",
    },
  },

  // Battery Power
  {
    field: "batteryW",
    metadata: {
      originId: "fronius",
      originSubId: "batteryW",
      defaultName: "Battery",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: null,
      metricType: "power",
      metricUnit: "W",
    },
  },

  // Grid Power
  {
    field: "gridW",
    metadata: {
      originId: "fronius",
      originSubId: "gridW",
      defaultName: "Grid",
      subsystem: "grid",
      type: "bidi",
      subtype: "grid",
      extension: null,
      metricType: "power",
      metricUnit: "W",
    },
  },

  // ============================================================================
  // STATE METRICS
  // ============================================================================

  // Battery State of Charge
  {
    field: "batterySOC",
    metadata: {
      originId: "fronius",
      originSubId: "batterySOC",
      defaultName: "Battery",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: null,
      metricType: "soc",
      metricUnit: "%",
    },
  },

  // Fault Code
  {
    field: "faultCode",
    metadata: {
      originId: "fronius",
      originSubId: "faultCode",
      defaultName: "Fault",
      subsystem: null,
      type: null,
      subtype: null,
      extension: null,
      metricType: "diagnostic",
      metricUnit: "text",
    },
  },

  // Fault Timestamp (stored as milliseconds since epoch)
  {
    field: "faultTimestamp",
    metadata: {
      originId: "fronius",
      originSubId: "faultTimestamp",
      defaultName: "Fault",
      subsystem: null,
      type: null,
      subtype: null,
      extension: null,
      metricType: "diagnostic",
      metricUnit: "epochMs",
    },
  },

  // Generator Status
  {
    field: "generatorStatus",
    metadata: {
      originId: "fronius",
      originSubId: "generatorStatus",
      defaultName: "Generator",
      subsystem: null,
      type: null,
      subtype: null,
      extension: null,
      metricType: "status",
      metricUnit: "bool",
    },
  },

  // ============================================================================
  // INTERVAL ENERGY METRICS (Wh) - Energy accumulated in this interval
  // ============================================================================

  {
    field: "solarWhInterval",
    metadata: {
      originId: "fronius",
      originSubId: "solarWhInterval",
      defaultName: "Solar",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: null,
      metricType: "energy",
      metricUnit: "Wh",
    },
  },
  {
    field: "loadWhInterval",
    metadata: {
      originId: "fronius",
      originSubId: "loadWhInterval",
      defaultName: "Load",
      subsystem: "load",
      type: "load",
      subtype: null,
      extension: null,
      metricType: "energy",
      metricUnit: "Wh",
    },
  },
  {
    field: "batteryInWhInterval",
    metadata: {
      originId: "fronius",
      originSubId: "batteryInWhInterval",
      defaultName: "Battery Charge",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: "charge",
      metricType: "energy",
      metricUnit: "Wh",
    },
  },
  {
    field: "batteryOutWhInterval",
    metadata: {
      originId: "fronius",
      originSubId: "batteryOutWhInterval",
      defaultName: "Battery Discharge",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: "discharge",
      metricType: "energy",
      metricUnit: "Wh",
    },
  },
  {
    field: "gridInWhInterval",
    metadata: {
      originId: "fronius",
      originSubId: "gridInWhInterval",
      defaultName: "Import",
      subsystem: "grid",
      type: "bidi",
      subtype: "grid",
      extension: "import",
      metricType: "energy",
      metricUnit: "Wh",
    },
  },
  {
    field: "gridOutWhInterval",
    metadata: {
      originId: "fronius",
      originSubId: "gridOutWhInterval",
      defaultName: "Export",
      subsystem: "grid",
      type: "bidi",
      subtype: "grid",
      extension: "export",
      metricType: "energy",
      metricUnit: "Wh",
    },
  },
];

/**
 * Helper to get metadata for a specific field
 */
export function getPointMetadata(
  field: keyof import("../../../app/api/push/fronius/route").FroniusPushData,
): PointMetadata | undefined {
  return FRONIUS_POINTS.find((p) => p.field === field)?.metadata;
}
