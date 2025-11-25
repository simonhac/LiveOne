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
 * Simplified - uses originId (E1/B1) to differentiate import/export
 */
export function createChannelPoint(
  channel: AmberChannelMetadata,
  metricType: "energy" | "value" | "rate",
): PointMetadata {
  // Map metric type to originSubId and metricUnit
  const metricConfig = {
    energy: { subId: "kwh", unit: "Wh" },
    value: { subId: "cost", unit: "cents" },
    rate: { subId: "perKwh", unit: "cents_kWh" },
  };

  const config = metricConfig[metricType];

  return {
    originId: channel.channelId,
    originSubId: config.subId, // No prefix - differentiated by originId
    defaultName: channel.defaultName,
    subsystem: "grid",
    type: "bidi", // All Amber points are bidirectional grid
    subtype: "grid",
    extension: channel.extension,
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
    createChannelPoint(channel, "energy"),
    createChannelPoint(channel, "value"),
    createChannelPoint(channel, "rate"),
  ];
}
