/**
 * Fronius Point Metadata Configuration
 *
 * This defines all metadata for the key monitoring points from Fronius systems.
 * Each entry maps a field from the FroniusPushData interface to point_info metadata.
 *
 * Fronius systems push data to /api/push/fronius endpoint
 */

import type { PointMetadata } from "@/lib/point/point-manager";

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
      physicalPath: "fronius/solarW",
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
    field: "solarRemoteW",
    metadata: {
      physicalPath: "fronius/solarRemoteW",
      logicalPathStem: "source.solar.remote",
      defaultName: "Solar Remote",
      subsystem: "solar",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },

  // Solar Power - Local (Shunt/CT)
  {
    field: "solarLocalW",
    metadata: {
      physicalPath: "fronius/solarLocalW",
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
      physicalPath: "fronius/loadW",
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
      physicalPath: "fronius/batteryW",
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
      physicalPath: "fronius/gridW",
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
      physicalPath: "fronius/batterySOC",
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
      physicalPath: "fronius/faultCode",
      logicalPathStem: null,
      defaultName: "Fault",
      subsystem: null,
      metricType: "diagnostic",
      metricUnit: "text",
      transform: null,
    },
  },

  // Fault Timestamp (stored as milliseconds since epoch)
  {
    field: "faultTimestamp",
    metadata: {
      physicalPath: "fronius/faultTimestamp",
      logicalPathStem: null,
      defaultName: "Fault",
      subsystem: null,
      metricType: "diagnostic",
      metricUnit: "epochMs",
      transform: null,
    },
  },

  // Generator Status
  {
    field: "generatorStatus",
    metadata: {
      physicalPath: "fronius/generatorStatus",
      logicalPathStem: null,
      defaultName: "Generator",
      subsystem: null,
      metricType: "status",
      metricUnit: "bool",
      transform: null,
    },
  },

  // ============================================================================
  // INTERVAL ENERGY METRICS (Wh) - Energy accumulated in this interval
  // ============================================================================

  {
    field: "solarWhInterval",
    metadata: {
      physicalPath: "fronius/solarWhInterval",
      logicalPathStem: "source.solar",
      defaultName: "Solar",
      subsystem: "solar",
      metricType: "energy",
      metricUnit: "Wh",
      transform: null,
    },
  },
  {
    field: "loadWhInterval",
    metadata: {
      physicalPath: "fronius/loadWhInterval",
      logicalPathStem: "load",
      defaultName: "Load",
      subsystem: "load",
      metricType: "energy",
      metricUnit: "Wh",
      transform: null,
    },
  },
  {
    field: "batteryInWhInterval",
    metadata: {
      physicalPath: "fronius/batteryInWhInterval",
      logicalPathStem: "bidi.battery.charge",
      defaultName: "Battery Charge",
      subsystem: "battery",
      metricType: "energy",
      metricUnit: "Wh",
      transform: null,
    },
  },
  {
    field: "batteryOutWhInterval",
    metadata: {
      physicalPath: "fronius/batteryOutWhInterval",
      logicalPathStem: "bidi.battery.discharge",
      defaultName: "Battery Discharge",
      subsystem: "battery",
      metricType: "energy",
      metricUnit: "Wh",
      transform: null,
    },
  },
  {
    field: "gridInWhInterval",
    metadata: {
      physicalPath: "fronius/gridInWhInterval",
      logicalPathStem: "bidi.grid.import",
      defaultName: "Import",
      subsystem: "grid",
      metricType: "energy",
      metricUnit: "Wh",
      transform: null,
    },
  },
  {
    field: "gridOutWhInterval",
    metadata: {
      physicalPath: "fronius/gridOutWhInterval",
      logicalPathStem: "bidi.grid.export",
      defaultName: "Export",
      subsystem: "grid",
      metricType: "energy",
      metricUnit: "Wh",
      transform: null,
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
