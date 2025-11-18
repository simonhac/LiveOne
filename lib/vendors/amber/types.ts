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
  extension: string; // "import", "export", or "controlled"
  defaultName: string; // "Grid import", "Grid export", or "Controlled load"
}

/**
 * Sync audit types for methodical data validation and comparison
 */

// Branded type for millisecond timestamps
export type Milliseconds = number & { readonly __brand: "Milliseconds" };

// Completeness states for data quality overview
export type Completeness = "all-billable" | "none" | "mixed";

// Result from a single sync stage
export interface StageResult {
  stage: string; // e.g., "stage 1: load local usage"
  completeness: Completeness;
  overviewsByPoint: Map<string, string>; // Map of point origin ID to overview (48 chars each)
  numRecords: number; // Count of non-null records (required for all stages)
  characterisation?: CharacterisationRange[];
  records?: Map<string, Map<string, PointReading>>;
  error?: string;
  request?: string; // Debug info about the API request made
}

// Quality range grouping for mixed completeness
export interface CharacterisationRange {
  rangeStartTimeMs: Milliseconds;
  rangeEndTimeMs: Milliseconds;
  quality: string | null;
  pointOriginIds: string[]; // e.g., ["E1.kwh", "B1.cost"] - varies by site
}

// Point reading structure for sync records
export interface PointReading {
  pointMetadata: import("@/lib/vendors/base-vendor-adapter").PointMetadata;
  rawValue: any;
  measurementTimeMs: Milliseconds;
  receivedTimeMs: Milliseconds;
  dataQuality?: string;
  sessionId: number;
  error?: string | null;
}

// Complete sync audit result
export interface SyncAudit {
  systemId: number;
  day: import("@internationalized/date").CalendarDate;
  stages: StageResult[];
  summary: {
    totalStages: number;
    durationMs: Milliseconds;
    error?: string;
    exception?: Error;
  };
}
