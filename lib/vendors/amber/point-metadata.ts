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
  return {
    originId: channel.channelId,
    originSubId: `${channel.extension}_kwh`,
    defaultName: channel.defaultName,
    subsystem: "grid",
    type: "bidi", // All Amber points are bidirectional grid
    subtype: "grid",
    extension: channel.extension,
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
  return {
    originId: channel.channelId,
    originSubId: `${channel.extension}_cost`,
    defaultName: channel.defaultName,
    subsystem: "grid",
    type: "bidi", // All Amber points are bidirectional grid
    subtype: "grid",
    extension: channel.extension,
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
  return {
    originId: channel.channelId,
    originSubId: `${channel.extension}_perKwh`,
    defaultName: channel.defaultName,
    subsystem: "grid",
    type: "bidi", // All Amber points are bidirectional grid
    subtype: "grid",
    extension: channel.extension,
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
  let extension: string;
  let defaultName: string;

  switch (channelType) {
    case "general":
      pointType = "grid.import";
      extension = "import";
      defaultName = "Grid import";
      break;
    case "feedIn":
      pointType = "grid.export";
      extension = "export";
      defaultName = "Grid export";
      break;
    case "controlledLoad":
      pointType = "grid.controlled";
      extension = "controlled";
      defaultName = "Controlled load";
      break;
  }

  return {
    channelId,
    channelType,
    pointType,
    extension,
    defaultName,
  };
}

/**
 * Create renewables percentage point (system-level, not channel-specific)
 * Represents the grid-wide renewable energy percentage
 */
export function createRenewablesPoint(): PointMetadata {
  return {
    originId: "grid",
    originSubId: "renewables",
    defaultName: "Grid renewables",
    subsystem: "grid",
    type: "bidi",
    subtype: "grid",
    extension: "renewables",
    metricType: "proportion",
    metricUnit: "%",
    transform: null,
  };
}

/**
 * Create wholesale spot price point (system-level, not channel-specific)
 * Represents the NEM wholesale spot price
 */
export function createSpotPricePoint(): PointMetadata {
  return {
    originId: "grid",
    originSubId: "spotPerKwh",
    defaultName: "Grid spot price",
    subsystem: "grid",
    type: "bidi",
    subtype: "grid",
    extension: "spot",
    metricType: "rate",
    metricUnit: "cents_kWh",
    transform: null,
  };
}

/**
 * Create tariff period point (import channel only)
 * Records current tariff period with abbreviated values
 */
export function createTariffPeriodPoint(): PointMetadata {
  return {
    originId: "grid",
    originSubId: "tariffPeriod",
    defaultName: "Tariff period",
    subsystem: "grid",
    type: "bidi",
    subtype: "grid",
    extension: "tariff",
    metricType: "code",
    metricUnit: "text",
    transform: null,
  };
}

/**
 * Abbreviate tariff period values
 * peak → pk, offPeak → op, shoulder → sh, solarSponge → ss
 */
export function abbreviateTariffPeriod(
  period: string | undefined,
): string | null {
  if (!period) return null;

  const abbreviations: Record<string, string> = {
    peak: "pk",
    offPeak: "op",
    shoulder: "sh",
    solarSponge: "ss",
  };

  return abbreviations[period] || period;
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
