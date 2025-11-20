/**
 * Amber Electric API types
 */

import type { CalendarDate } from "@internationalized/date";
import type { PointMetadata } from "@/lib/monitoring-points-manager";

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

// Simplified sample record (stripped down from PointReading)
export interface SimplifiedSampleRecord {
  rawValue: any;
  measurementTimeMs: Milliseconds;
  receivedTimeMs: Milliseconds;
  quality?: string;
}

// Sample records for a single point
export interface SampleRecordsForPoint {
  records: SimplifiedSampleRecord[]; // Up to 3 sample records
  numSkipped?: number; // Number of records not included (if total > 3)
}

// Batch info - summary views of a time period's readings
export interface BatchInfo {
  completeness: Completeness;
  overviews: Record<string, string>; // Single object: {pointKey: overview, ...} (48 × numberOfDays chars each)
  numRecords: number; // Count of non-null records
  characterisation?: CharacterisationRange[];
  canonical: string[]; // Formatted table display (one line per row, monospaced)
  sampleRecords?: Record<string, SampleRecordsForPoint>; // Single object: {pointKey: {records, numSkipped}, ...}
}

// Helper functions for BatchInfo
export function getOverviewKeys(info: BatchInfo): string[] {
  return Object.keys(info.overviews);
}

export function getSampleRecordKeys(info: BatchInfo): string[] {
  return info.sampleRecords ? Object.keys(info.sampleRecords) : [];
}

// Result from a single sync stage
export interface StageResult {
  stage: string; // e.g., "stage 1: load local usage"
  info: BatchInfo; // Summary views of the batch
  records?: Map<string, Map<string, PointReading>>;
  error?: string;
  request?: string; // Debug info about the API request made
  discovery?: string; // Optional text description of what was discovered/learned
  numRowsInserted?: number; // Number of rows inserted into database (only for store stages)
}

// Quality range grouping for mixed completeness
export interface CharacterisationRange {
  rangeStartTimeMs: Milliseconds;
  rangeEndTimeMs: Milliseconds;
  quality: string | null;
  pointOriginIds: string[]; // e.g., ["E1.kwh", "B1.cost"] - varies by site
  numPeriods: number; // Number of 30-minute periods in this range
}

// Point reading structure for sync records
export interface PointReading {
  pointMetadata: PointMetadata;
  rawValue: any;
  measurementTimeMs: Milliseconds;
  receivedTimeMs: Milliseconds;
  dataQuality?: string;
  sessionId: number;
  error?: string | null;
}

// Complete sync audit result (strips out records field to reduce payload size)
export interface AmberSyncResult {
  action: "updateUsage" | "updateForecasts";
  success: boolean; // True if sync completed without errors
  systemId: number;
  firstDay: CalendarDate;
  numberOfDays: number;
  stages: Omit<StageResult, "records">[]; // Omit records Map - use sampleRecords instead
  summary: {
    totalStages: number;
    numRowsInserted: number; // Total rows inserted across all stages
    durationMs: Milliseconds;
    error?: string;
    exception?: Error;
  };
}
