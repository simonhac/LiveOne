/**
 * Amber Electric - Monitoring Point Metadata Definitions
 *
 * This file defines the structure of monitoring points for Amber Electric systems.
 * Amber provides grid import/export data with energy, cost/revenue, and pricing.
 */

import type { PointMetadata } from "@/lib/point/point-manager";
import type { AmberChannelMetadata } from "./types";

/**
 * Create a channel point with specified metric type
 * Simplified - uses channelId (E1/B1) to differentiate import/export
 */
export function createChannelPoint(
  channel: AmberChannelMetadata,
  metricType: "energy" | "value" | "rate",
): PointMetadata {
  // Map metric type to physical path suffix and metricUnit
  const metricConfig = {
    energy: { subId: "kwh", unit: "Wh" },
    value: { subId: "cost", unit: "cents" },
    rate: { subId: "perKwh", unit: "cents_kWh" },
  };

  const config = metricConfig[metricType];

  // Build logicalPathStem from bidi.grid + extension
  const logicalPathStem = channel.extension
    ? `bidi.grid.${channel.extension}`
    : "bidi.grid";

  return {
    physicalPathTail: `${channel.channelId}/${config.subId}`,
    logicalPathStem,
    defaultName: channel.defaultName,
    subsystem: "grid",
    metricType,
    metricUnit: config.unit,
    transform: null, // Interval values, not cumulative
  };
}

/**
 * Get channel metadata from Amber channel type
 */
export function getChannelMetadata(
  channelId: string,
  channelType: "general" | "feedIn" | "controlledLoad",
): AmberChannelMetadata {
  const channelConfig = {
    general: { extension: "import", defaultName: "Grid import" },
    feedIn: { extension: "export", defaultName: "Grid export" },
    controlledLoad: { extension: "controlled", defaultName: "Controlled load" },
  };

  const config = channelConfig[channelType];

  return {
    channelId,
    channelType,
    extension: config.extension,
    defaultName: config.defaultName,
  };
}

/**
 * Create renewables percentage point (device-level, not channel-specific)
 * Represents the grid-wide renewable energy percentage
 */
export function createRenewablesPoint(): PointMetadata {
  return {
    physicalPathTail: "grid/renewables",
    logicalPathStem: "bidi.grid.renewables",
    defaultName: "Grid renewables",
    subsystem: "grid",
    metricType: "proportion",
    metricUnit: "%",
    transform: null,
  };
}

/**
 * Create wholesale spot price point (device-level, not channel-specific)
 * Represents the NEM wholesale spot price
 */
export function createSpotPricePoint(): PointMetadata {
  return {
    physicalPathTail: "grid/spotPerKwh",
    logicalPathStem: "bidi.grid.spot",
    defaultName: "Grid spot price",
    subsystem: "grid",
    metricType: "rate",
    metricUnit: "cents_kWh",
    transform: null,
  };
}
