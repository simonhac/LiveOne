/**
 * Amber Electric - Monitoring Point Metadata Definitions
 *
 * This file defines the structure of monitoring points for Amber Electric systems.
 * Amber provides grid import/export data with energy, cost/revenue, and pricing.
 */

import type { PointMetadata } from "@/lib/monitoring-points-manager";
import type { AmberChannelMetadata } from "./types";

/**
 * Create energy point for a channel
 */
export function createEnergyPoint(
  channel: AmberChannelMetadata,
): PointMetadata {
  const isExport = channel.pointType === "grid.export";
  const isControlled = channel.pointType === "grid.controlled";

  // Determine extension based on channel type
  let extension: string | null;
  if (isExport) {
    extension = "export";
  } else if (isControlled) {
    extension = "controlled";
  } else {
    extension = "import";
  }

  return {
    originId: channel.channelId,
    originSubId: "energy",
    defaultName: isExport
      ? "Grid export energy"
      : isControlled
        ? "Controlled load energy"
        : "Grid import energy",
    subsystem: "grid",
    type: "bidi", // All Amber points are bidirectional grid
    subtype: "grid",
    extension,
    metricType: "energy",
    metricUnit: "Wh",
    transform: null, // Interval values, not cumulative
  };
}

/**
 * Create cost/revenue point for a channel
 * Using unified "value" metric type for all monetary values
 */
export function createCostPoint(channel: AmberChannelMetadata): PointMetadata {
  const isExport = channel.pointType === "grid.export";
  const isControlled = channel.pointType === "grid.controlled";

  // Determine extension based on channel type
  let extension: string | null;
  if (isExport) {
    extension = "export";
  } else if (isControlled) {
    extension = "controlled";
  } else {
    extension = "import";
  }

  return {
    originId: channel.channelId,
    originSubId: isExport ? "revenue" : "cost",
    defaultName: isExport
      ? "Grid export revenue"
      : isControlled
        ? "Controlled load cost"
        : "Grid import cost",
    subsystem: "grid",
    type: "bidi", // All Amber points are bidirectional grid
    subtype: "grid",
    extension,
    metricType: "value", // Unified metric type for monetary values
    metricUnit: "cents",
    transform: null,
  };
}

/**
 * Create price point for a channel
 * Using "rate" metric type for pricing
 */
export function createPricePoint(channel: AmberChannelMetadata): PointMetadata {
  const isExport = channel.pointType === "grid.export";
  const isControlled = channel.pointType === "grid.controlled";

  // Determine extension based on channel type
  let extension: string | null;
  if (isExport) {
    extension = "export";
  } else if (isControlled) {
    extension = "controlled";
  } else {
    extension = "import";
  }

  return {
    originId: channel.channelId,
    originSubId: "price",
    defaultName: isExport
      ? "Grid export price"
      : isControlled
        ? "Controlled load price"
        : "Grid import price",
    subsystem: "grid",
    type: "bidi", // All Amber points are bidirectional grid
    subtype: "grid",
    extension,
    metricType: "rate", // Using "rate" for pricing
    metricUnit: "cents_kWh",
    transform: null,
  };
}

/**
 * Get channel metadata from Amber channel type
 */
export function getChannelMetadata(
  channelId: string,
  channelType: "general" | "feedIn" | "controlledLoad",
): AmberChannelMetadata {
  let pointType: "grid.import" | "grid.export" | "grid.controlled";

  switch (channelType) {
    case "general":
      pointType = "grid.import";
      break;
    case "feedIn":
      pointType = "grid.export";
      break;
    case "controlledLoad":
      pointType = "grid.controlled";
      break;
  }

  return {
    channelId,
    channelType,
    pointType,
  };
}

/**
 * Create all three points (energy, cost, price) for a channel
 */
export function createChannelPoints(
  channel: AmberChannelMetadata,
): PointMetadata[] {
  return [
    createEnergyPoint(channel),
    createCostPoint(channel),
    createPricePoint(channel),
  ];
}
