/**
 * Enphase Point Metadata Configuration
 *
 * This defines all metadata for the key monitoring points from Enphase systems.
 * Each entry maps a field from the Enphase data to point_info metadata.
 *
 * Note: Enphase production_micro endpoint returns 5-minute interval data
 * with up to 288 intervals per day (one every 5 minutes).
 */

import type { PointMetadata } from "@/lib/point/point-manager";

/**
 * Enphase interval data structure from production_micro endpoint
 */
export interface EnphaseInterval {
  end_at: number; // Unix timestamp marking END of interval
  devices_reporting: number; // Number of devices reporting
  powr: number; // Power in watts
  enwh: number; // Energy in watt-hours for this interval
}

export interface EnphasePointConfig {
  // Field name from EnphaseInterval interface
  field: keyof EnphaseInterval;
  // Metadata for point_info table
  metadata: PointMetadata;
}

/**
 * Monitoring points for Enphase systems
 *
 * Currently Enphase production_micro endpoint only provides solar production data.
 * Other endpoints may provide consumption, storage, and grid data but are not yet integrated.
 */
export const ENPHASE_POINTS: EnphasePointConfig[] = [
  // ============================================================================
  // POWER METRICS (W)
  // ============================================================================

  // Solar Power
  {
    field: "powr",
    metadata: {
      originId: "enphase",
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

  // ============================================================================
  // INTERVAL ENERGY (Wh)
  // ============================================================================

  // Solar interval energy - energy produced in this 5-minute interval
  {
    field: "enwh",
    metadata: {
      originId: "enphase",
      originSubId: "solar_interval_wh",
      defaultName: "Solar Interval",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: null,
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
  field: keyof EnphaseInterval,
): PointMetadata | undefined {
  return ENPHASE_POINTS.find((p) => p.field === field)?.metadata;
}
