/**
 * Fusher (Fronius Pusher) Point Metadata Configuration
 *
 * This defines all metadata for the key monitoring points from Fusher systems.
 * Each entry maps a field from the FusherPushData interface to point_info metadata.
 *
 * Fusher systems push data to /api/push/fusher endpoint
 */

import type { PointMetadata } from "@/lib/point/point-manager";

export interface FusherPointConfig {
  // Field name from FusherPushData interface
  field: keyof import("../../../app/api/push/fusher/route").FusherPushData;
  // Metadata for point_info table
  metadata: PointMetadata;
}

/**
 * Monitoring points for Fusher systems
 */
export const FUSHER_POINTS: FusherPointConfig[] = [
  // ============================================================================
  // POWER METRICS (W)
  // ============================================================================

  // Solar Power - Total
  {
    field: "solarW",
    metadata: {
      physicalPathTail: "solarW",
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
      physicalPathTail: "solarRemoteW",
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
      physicalPathTail: "solarLocalW",
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
      physicalPathTail: "loadW",
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
      physicalPathTail: "batteryW",
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
      physicalPathTail: "gridW",
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
      physicalPathTail: "batterySOC",
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
      physicalPathTail: "faultCode",
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
      physicalPathTail: "faultTimestamp",
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
      physicalPathTail: "generatorStatus",
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
      physicalPathTail: "solarWhInterval",
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
      physicalPathTail: "loadWhInterval",
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
      physicalPathTail: "batteryInWhInterval",
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
      physicalPathTail: "batteryOutWhInterval",
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
      physicalPathTail: "gridInWhInterval",
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
      physicalPathTail: "gridOutWhInterval",
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
  field: keyof import("../../../app/api/push/fusher/route").FusherPushData,
): PointMetadata | undefined {
  return FUSHER_POINTS.find((p) => p.field === field)?.metadata;
}
