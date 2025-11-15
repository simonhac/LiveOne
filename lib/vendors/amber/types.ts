/**
 * Amber Electric API types
 */

export interface AmberCredentials {
  apiKey: string;
  siteId?: string; // Optional: auto-discover if not provided
}

export interface AmberSite {
  id: string;
  nmi: string;
  channels: AmberChannel[];
  network: string;
  status: string;
  activeFrom: string;
  intervalLength: number; // Minutes (typically 30)
}

export interface AmberChannel {
  identifier: string; // e.g., "E1", "B1", "CL1"
  type: "general" | "feedIn" | "controlledLoad";
  tariff: string; // e.g., "CRTOU", "GENR13"
}

export interface AmberUsageRecord {
  type: "Usage";
  duration: number; // Minutes (typically 30)
  date: string; // Australian date (YYYY-MM-DD)
  startTime: string; // ISO 8601 UTC
  endTime: string; // ISO 8601 UTC
  nemTime: string; // ISO 8601 Australian Eastern time
  quality: string; // "billable", "estimated", etc.
  kwh: number; // Energy in kilowatt-hours
  perKwh: number; // Price in cents/kWh
  cost: number; // Cost in cents (kwh × perKwh)
  channelType: "general" | "feedIn" | "controlledLoad";
  channelIdentifier: string; // e.g., "E1", "B1", "CL1"
  renewables: number; // Renewable percentage
  spotPerKwh: number; // Wholesale spot price component
  spikeStatus: string; // "none", "potential", "spike"
  tariffInformation?: {
    period: string; // "peak", "offPeak", "shoulder"
    season?: string; // "default", "summer", "winter"
  };
  descriptor: string; // "extremelyLow", "low", "neutral", "high", "extremelyHigh"
}

export interface AmberPriceRecord {
  type: "ActualInterval" | "CurrentInterval" | "ForecastInterval";
  date: string; // Australian date (YYYY-MM-DD)
  duration: number; // Minutes (typically 30)
  startTime: string; // ISO 8601 UTC
  endTime: string; // ISO 8601 UTC
  nemTime: string; // ISO 8601 Australian Eastern time
  perKwh: number; // Price in cents/kWh
  renewables: number; // Renewable percentage
  spotPerKwh: number; // Wholesale spot price component
  channelType: "general" | "feedIn" | "controlledLoad";
  spikeStatus: string; // "none", "potential", "spike"
  tariffInformation?: {
    period: string; // "peak", "offPeak", "shoulder"
    season?: string; // "default", "summer", "winter"
  };
  descriptor: string; // "extremelyLow", "low", "neutral", "high", "extremelyHigh"
  estimate?: boolean; // Present on forecast records
}

/**
 * Grouped usage data by timestamp
 * Used internally to process multiple channels at the same timestamp
 */
export interface GroupedUsageReading {
  endTime: string;
  records: AmberUsageRecord[];
  quality: string; // Consolidated quality (or "MIXED" if inconsistent)
}

/**
 * Channel metadata for creating monitoring points
 */
export interface AmberChannelMetadata {
  channelId: string; // e.g., "E1", "B1", "CL1"
  channelType: "general" | "feedIn" | "controlledLoad";
  pointType: "grid.import" | "grid.export" | "grid.controlled";
}
