/**
 * Amber Electric Sync Client
 *
 * Methodical, audit-focused syncing with auto-numbered stages.
 * Phase 1: Read-only audit operations for data validation and comparison.
 */

import {
  CalendarDate,
  toCalendarDateTime,
  toZoned,
} from "@internationalized/date";
import type {
  AmberCredentials,
  AmberUsageRecord,
  AmberPriceRecord,
  Milliseconds,
  StageResult,
  SyncAudit,
  Completeness,
  CharacterisationRange,
  PointReading,
} from "./types";
import type { PointMetadata } from "@/lib/vendors/base-vendor-adapter";
import { formatDateAEST } from "@/lib/date-utils";
import { PointReadingGroup } from "./point-reading-group";

/**
 * Quality precedence for comparison
 * Higher values = higher precedence/quality
 */
const QUALITY_PRECEDENCE: Record<string, number> = {
  billable: 4,
  actual: 3,
  estimated: 2,
  forecast: 1,
};

/**
 * Stage tracker for auto-numbering
 */
class StageTracker {
  private currentStage = 0;

  nextStage(description: string): string {
    this.currentStage++;
    return `stage ${this.currentStage}: ${description}`;
  }
}

/**
 * Helper Functions
 */

/**
 * Abbreviate quality to first letter lowercase
 * No mapping - use quality string directly
 */
function abbreviateQuality(quality: string | null): string {
  if (quality === null) return ".";
  return quality.charAt(0).toLowerCase();
}

/**
 * Get quality precedence value
 */
function getQualityPrecedence(quality: string | null): number {
  if (quality === null) return 0;
  return QUALITY_PRECEDENCE[quality] ?? 0;
}

/**
 * Check if new record is superior to existing record
 * Takes into account quality precedence and raw value
 */
function isNewRecordSuperior(
  existingRecord: PointReading | undefined,
  newRecord: PointReading | undefined,
): boolean {
  // If no existing record, new is superior (if it exists)
  if (!existingRecord) return !!newRecord;

  // If no new record, existing is superior
  if (!newRecord) return false;

  // Both exist - compare quality
  const existingPrecedence = getQualityPrecedence(
    existingRecord.dataQuality ?? null,
  );
  const newPrecedence = getQualityPrecedence(newRecord.dataQuality ?? null);

  if (newPrecedence > existingPrecedence) return true;
  if (newPrecedence < existingPrecedence) return false;

  // Same quality - new is superior ONLY if raw value is different
  return existingRecord.rawValue !== newRecord.rawValue;
}

/**
 * Determine completeness from overview string
 * Throws error if overview length is not exactly 48
 */
function determineCompleteness(overview: string): Completeness {
  if (overview.length !== 48) {
    throw new Error(`Invalid overview length: ${overview.length}, expected 48`);
  }

  const nonNull = overview.replace(/\./g, "").length;
  const billable = overview.replace(/[^b]/g, "").length;

  if (billable === 48) return "all-billable";
  if (nonNull === 0) return "none";
  return "mixed";
}

/**
 * Generate 48 half-hour interval timestamps for a day in AEST (UTC+10)
 * Returns timestamps from 00:30 AEST to 00:00 AEST (next day)
 * Note: Uses fixed UTC+10 offset, NOT Australia/Sydney which observes DST
 */
function generate48IntervalsAEST(day: CalendarDate): Milliseconds[] {
  const intervals: Milliseconds[] = [];

  // Convert CalendarDate to ZonedDateTime at midnight in +10:00 timezone (AEST)
  let current = toZoned(toCalendarDateTime(day), "+10:00");

  // Generate 48 intervals starting at 00:30 AEST
  for (let i = 0; i < 48; i++) {
    current = current.add({ minutes: 30 });
    intervals.push(current.toDate().getTime() as Milliseconds);
  }

  return intervals;
}

/**
 * Build overview string from intervals
 */
function buildOverviewFromIntervals(
  intervals: Array<{ dataQuality: string | null }>,
): string {
  return intervals.map((i) => abbreviateQuality(i.dataQuality)).join("");
}

/**
 * Build characterisation ranges from intervals
 * Groups consecutive intervals with the same quality
 */
function buildCharacterisation(
  intervals: Array<{
    timeMs: Milliseconds;
    quality: string | null;
    pointOriginIds: string[];
  }>,
): CharacterisationRange[] {
  if (intervals.length === 0) return [];

  const ranges: CharacterisationRange[] = [];
  let currentRange: CharacterisationRange | null = null;

  for (const interval of intervals) {
    const isAdjacent =
      currentRange &&
      interval.timeMs === currentRange.rangeEndTimeMs + 30 * 60 * 1000;
    const isSameQuality =
      currentRange && currentRange.quality === interval.quality;

    if (!currentRange || !isAdjacent || !isSameQuality) {
      // Start new range
      if (currentRange) {
        ranges.push(currentRange);
      }
      currentRange = {
        rangeStartTimeMs: interval.timeMs,
        rangeEndTimeMs: interval.timeMs, // Will be updated when range extends
        quality: interval.quality,
        pointOriginIds: interval.pointOriginIds,
      };
    } else {
      // Extend current range - interval is adjacent and same quality
      currentRange.rangeEndTimeMs = interval.timeMs;
    }
  }

  // Push final range
  if (currentRange) {
    ranges.push(currentRange);
  }

  return ranges;
}

/**
 * Build characterisation from local database readings
 */
function buildCharacterisationFromLocal(
  readings: any[],
  allPoints: any[],
  expectedIntervals: Milliseconds[],
): CharacterisationRange[] {
  const intervals = expectedIntervals.map((timeMs) => {
    // Get readings for this interval across all points
    const intervalReadings = readings.filter((r) => r.intervalEnd === timeMs);

    // Use the quality from the first reading (they should all be the same)
    const quality =
      intervalReadings.length > 0 ? intervalReadings[0].dataQuality : null;

    // Get all point origin IDs for this interval
    const pointOriginIds = intervalReadings
      .map((r) => {
        const point = allPoints.find((p) => p.index === r.pointId);
        if (!point) return "";
        return point.originSubId
          ? `${point.originId}.${point.originSubId}`
          : point.originId;
      })
      .filter((id) => id !== "");

    return {
      timeMs,
      quality,
      pointOriginIds,
    };
  });

  return buildCharacterisation(intervals);
}

/**
 * Build PointReadingGroup from local database readings
 */
function buildRecordsMapFromLocal(
  readings: any[],
  allPoints: any[],
  day: CalendarDate,
): PointReadingGroup {
  const group = new PointReadingGroup(day);

  for (const reading of readings) {
    const point = allPoints.find((p) => p.index === reading.pointId);
    if (!point) continue;

    // Determine the value based on metric type
    let rawValue: any = null;
    if (point.metricType === "energy") {
      rawValue = reading.delta;
    } else if (point.metricType === "code") {
      rawValue = reading.valueStr;
    } else {
      rawValue = reading.avg ?? reading.last;
    }

    const pointReading: PointReading = {
      pointMetadata: {
        originId: point.originId,
        originSubId: point.originSubId,
        defaultName: point.defaultName || point.displayName,
        subsystem: point.subsystem,
        type: point.type,
        subtype: point.subtype,
        extension: point.extension,
        metricType: point.metricType,
        metricUnit: point.metricUnit,
        transform: point.transform,
      },
      rawValue,
      measurementTimeMs: reading.intervalEnd as Milliseconds,
      receivedTimeMs: (reading.createdAt || Date.now()) as Milliseconds,
      dataQuality: reading.dataQuality,
      sessionId: reading.sessionId || 0,
    };

    group.add(pointReading);
  }

  return group;
}

/**
 * Stage Implementations
 */

/**
 * Stage 1a: Load Local Usage
 * Fetches all point readings from the database for the specified day
 */
async function loadLocalUsage(
  systemId: number,
  day: CalendarDate,
  stageName: string,
): Promise<StageResult> {
  try {
    const { SystemsManager } = await import("@/lib/systems-manager");
    const { PointManager } = await import("@/lib/point/point-manager");
    const { db } = await import("@/lib/db");
    const { pointReadingsAgg5m } = await import(
      "@/lib/db/schema-monitoring-points"
    );
    const { eq, and, inArray } = await import("drizzle-orm");

    // 0. Verify this is an Amber system
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);

    if (!system) {
      throw new Error(`System ${systemId} not found`);
    }

    if (system.vendorType !== "amber") {
      throw new Error(
        `System ${systemId} is ${system.vendorType}, not amber. This sync only works with Amber systems.`,
      );
    }

    // 1. Get all points using PointManager
    const pointManager = PointManager.getInstance();
    const allPoints = await pointManager.getPointsForSystem(systemId);

    if (allPoints.length === 0) {
      return {
        stage: stageName,
        completeness: "none",
        overviews: new Map(),
        numRecords: 0,
        error: "No points found for system",
      };
    }

    // 2. Generate 48 expected intervals
    const expectedIntervals = generate48IntervalsAEST(day);

    // 3. Fetch readings for all points
    const pointIds = allPoints.map((p) => p.index);
    const readings = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(
        and(
          eq(pointReadingsAgg5m.systemId, systemId),
          inArray(pointReadingsAgg5m.pointId, pointIds),
          inArray(pointReadingsAgg5m.intervalEnd, expectedIntervals),
        ),
      )
      .orderBy(pointReadingsAgg5m.intervalEnd);

    // 4. Build PointReadingGroup from database readings
    const group = buildRecordsMapFromLocal(readings, allPoints, day);

    // 5. Get all views from group
    const { overviews, completeness, characterisation, numRecords } =
      group.getInfo();

    return {
      stage: stageName,
      completeness,
      overviews,
      numRecords,
      characterisation,
      records: group.getRecords(),
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviews: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stage 1b: Load Remote Usage
 * Fetches usage data from Amber API for the specified day
 */
async function loadRemoteUsage(
  credentials: AmberCredentials,
  day: CalendarDate,
  stageName: string,
): Promise<StageResult> {
  try {
    const dateStr = formatDateAEST(day);
    const request = `GET /v1/sites/${credentials.siteId}/usage?startDate=${dateStr}&endDate=${dateStr}`;

    // Fetch from Amber API
    const usageRecords = await fetchAmberUsage(credentials, day);

    // Group by timestamp
    const recordsByTime = groupRecordsByTime(usageRecords);

    // Build PointReadingGroup from Amber data
    const group = buildRecordsMapFromAmber(recordsByTime, day);

    // Get all views from group
    const { overviews, completeness, characterisation, numRecords } =
      group.getInfo();

    return {
      stage: stageName,
      completeness,
      overviews,
      numRecords,
      characterisation,
      records: group.getRecords(),
      request,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviews: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generic comparison function for comparing existing and new records
 *
 * Strategy:
 * 1. Iterate through intervals and points, building superior PointReadingGroup
 * 2. Build comparison overview character-by-character (uppercase = superior)
 * 3. Use PointReadingGroup methods to derive views from superior records
 */
function compareRecords(
  existingResult: StageResult,
  newResult: StageResult,
  day: CalendarDate,
  pointKeys: string[],
): {
  comparisonOverviewsByPoint: Map<string, string>;
  numSuperiorRecords: number;
  completeness: Completeness;
  characterisation: CharacterisationRange[] | undefined;
  records: Map<string, Map<string, PointReading>>;
} {
  // Create PointReadingGroup for superior records
  const superiorGroup = new PointReadingGroup(day);

  // Initialize comparison overview arrays for each point
  const comparisonOverviewBuilders = new Map<string, string[]>();
  for (const pointKey of pointKeys) {
    comparisonOverviewBuilders.set(pointKey, []);
  }

  // Iterate through each point's entries and compare
  for (const pointKey of pointKeys) {
    const existingRecords = existingResult.records || new Map();
    const newRecords = newResult.records || new Map();

    for (const [intervalMs] of superiorGroup.getPointRecords(pointKey)) {
      const timeKey = String(intervalMs);

      const existingRecord = existingRecords.get(timeKey)?.get(pointKey);
      const newRecord = newRecords.get(timeKey)?.get(pointKey);

      const isSuperior = isNewRecordSuperior(existingRecord, newRecord);

      if (isSuperior && newRecord) {
        // New record is superior - add to superior group
        superiorGroup.add(newRecord);

        // Add uppercase to comparison overview
        const quality = newRecord.dataQuality ?? null;
        comparisonOverviewBuilders
          .get(pointKey)!
          .push(abbreviateQuality(quality).toUpperCase());
      } else {
        // Existing is same or better - add lowercase to comparison overview
        const quality = existingRecord?.dataQuality ?? null;
        comparisonOverviewBuilders
          .get(pointKey)!
          .push(abbreviateQuality(quality));
      }
    }
  }

  // Build comparison overview strings
  const comparisonOverviewsByPoint = new Map<string, string>();
  for (const [pointKey, builder] of comparisonOverviewBuilders.entries()) {
    comparisonOverviewsByPoint.set(pointKey, builder.join(""));
  }

  // Determine completeness from comparison overview
  const firstOverview =
    comparisonOverviewsByPoint.values().next().value ?? "".padEnd(48, ".");
  const completeness = determineCompleteness(firstOverview);

  // Get characterisation from superior group
  const characterisation = superiorGroup.getCharacterisation();
  const numSuperiorRecords = superiorGroup.getCount();

  return {
    comparisonOverviewsByPoint,
    numSuperiorRecords,
    completeness,
    characterisation,
    records: superiorGroup.getRecords(),
  };
}

/**
 * Stage 3: Compare Local vs Remote Usage
 * Compares local and remote data, identifies superior remote data
 */
async function compareUsage(
  existingResult: StageResult,
  newResult: StageResult,
  day: CalendarDate,
  stageName: string,
): Promise<StageResult> {
  // Should not reach here if either failed
  if (existingResult.error || newResult.error) {
    throw new Error(
      `Cannot compare with errors: existing=${existingResult.error}, new=${newResult.error}`,
    );
  }

  try {
    // Determine which points to compare
    // If local has points, use those (remote may have different/fewer points)
    // If local is empty, use remote points instead
    const localPointKeys = Array.from(existingResult.overviews.keys());
    const remotePointKeys = Array.from(newResult.overviews.keys());
    const pointKeys =
      localPointKeys.length > 0 ? localPointKeys : remotePointKeys;
    const sortedPointKeys = pointKeys.sort();

    const {
      comparisonOverviewsByPoint,
      numSuperiorRecords,
      completeness,
      characterisation,
      records,
    } = compareRecords(existingResult, newResult, day, sortedPointKeys);

    return {
      stage: stageName,
      completeness,
      overviews: comparisonOverviewsByPoint,
      numRecords: numSuperiorRecords,
      characterisation,
      records,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviews: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Amber API Integration
 */

/**
 * Fetch usage data from Amber API
 */
async function fetchAmberUsage(
  credentials: AmberCredentials,
  day: CalendarDate,
): Promise<AmberUsageRecord[]> {
  const dateStr = formatDateAEST(day);

  const url = `https://api.amber.com.au/v1/sites/${credentials.siteId}/usage`;
  const params = new URLSearchParams({
    startDate: dateStr,
    endDate: dateStr,
  });

  const response = await fetch(`${url}?${params}`, {
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Amber API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return data as AmberUsageRecord[];
}

/**
 * Group usage records by timestamp
 */
function groupRecordsByTime(
  records: AmberUsageRecord[],
): Map<Milliseconds, AmberUsageRecord[]> {
  const grouped = new Map<Milliseconds, AmberUsageRecord[]>();

  for (const record of records) {
    const timeMs = new Date(record.endTime).getTime() as Milliseconds;
    const existing = grouped.get(timeMs) || [];
    existing.push(record);
    grouped.set(timeMs, existing);
  }

  return grouped;
}

/**
 * Build overview strings for each series from grouped records
 */
function buildOverviewsFromRecords(
  recordsByTime: Map<Milliseconds, AmberUsageRecord[]>,
): Map<string, string> {
  const overviews = new Map<string, string>();

  // Get all unique series (channel + metric combinations)
  const seriesKeys = new Set<string>();
  for (const records of recordsByTime.values()) {
    for (const record of records) {
      seriesKeys.add(`${record.channelIdentifier}.kwh`);
      seriesKeys.add(`${record.channelIdentifier}.cost`);
      seriesKeys.add(`${record.channelIdentifier}.perKwh`);
    }
  }

  // Build overview for each series
  const sortedTimes = Array.from(recordsByTime.keys()).sort((a, b) => a - b);

  for (const seriesKey of seriesKeys) {
    const overview = sortedTimes
      .map((timeMs) => {
        const records = recordsByTime.get(timeMs) || [];
        const [channelId] = seriesKey.split(".");
        const record = records.find((r) => r.channelIdentifier === channelId);
        return abbreviateQuality(record?.quality ?? null);
      })
      .join("");

    overviews.set(seriesKey, overview);
  }

  return overviews;
}

/**
 * Build characterisation from Amber records
 */
function buildCharacterisationFromRecords(
  recordsByTime: Map<Milliseconds, AmberUsageRecord[]>,
  expectedIntervals: Milliseconds[],
): CharacterisationRange[] {
  const intervals = expectedIntervals.map((timeMs) => {
    const records = recordsByTime.get(timeMs) || [];
    const quality = records.length > 0 ? records[0].quality : null;
    const pointOriginIds = records.map((r) => `${r.channelIdentifier}.kwh`);

    return {
      timeMs,
      quality,
      pointOriginIds,
    };
  });

  return buildCharacterisation(intervals);
}

/**
 * Build PointReadingGroup from Amber usage data
 */
function buildRecordsMapFromAmber(
  recordsByTime: Map<Milliseconds, AmberUsageRecord[]>,
  day: CalendarDate,
): PointReadingGroup {
  const group = new PointReadingGroup(day);

  for (const [intervalMs, records] of recordsByTime.entries()) {
    for (const record of records) {
      // Create point readings for each metric
      const channelId = record.channelIdentifier;

      // Energy reading
      group.add({
        pointMetadata: createAmberPointMetadata(
          channelId,
          record.channelType,
          "energy",
        ),
        rawValue: record.kwh * 1000, // Convert to Wh
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: record.quality,
        sessionId: 0, // Not applicable for remote data
      });

      // Cost reading
      group.add({
        pointMetadata: createAmberPointMetadata(
          channelId,
          record.channelType,
          "value",
        ),
        rawValue: record.cost,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: record.quality,
        sessionId: 0,
      });

      // Price reading
      group.add({
        pointMetadata: createAmberPointMetadata(
          channelId,
          record.channelType,
          "rate",
        ),
        rawValue: record.perKwh,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: record.quality,
        sessionId: 0,
      });
    }
  }

  return group;
}

/**
 * Create point metadata for Amber points
 */
function createAmberPointMetadata(
  channelId: string,
  channelType: string,
  metricType: "energy" | "value" | "rate",
): PointMetadata {
  const metricConfig = {
    energy: { subId: "kwh", unit: "Wh" },
    value: { subId: "cost", unit: "cents" },
    rate: { subId: "perKwh", unit: "cents_kWh" },
  };

  const config = metricConfig[metricType];
  const extension =
    channelType === "general"
      ? "import"
      : channelType === "feedIn"
        ? "export"
        : "controlled";

  return {
    originId: channelId,
    originSubId: config.subId,
    defaultName: `${channelId} ${metricType}`,
    subsystem: "grid",
    type: "bidi",
    subtype: "grid",
    extension,
    metricType,
    metricUnit: config.unit,
    transform: null,
  };
}

/**
 * Fetch price data from Amber API for the specified day
 */
async function fetchAmberPrices(
  credentials: AmberCredentials,
  day: CalendarDate,
): Promise<AmberPriceRecord[]> {
  // Try using /prices with date parameters (similar to usage endpoint)
  const dateStr = formatDateAEST(day);
  const url = `https://api.amber.com.au/v1/sites/${credentials.siteId}/prices`;
  const params = new URLSearchParams({
    startDate: dateStr,
    endDate: dateStr,
  });

  const response = await fetch(`${url}?${params}`, {
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Amber API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return data as AmberPriceRecord[];
}

/**
 * Stage 4: Load Remote Prices
 * Fetches price data from Amber API for the specified day
 */
async function loadRemotePrices(
  credentials: AmberCredentials,
  day: CalendarDate,
  stageName: string,
): Promise<StageResult> {
  try {
    // Build request info for debugging
    const dateStr = formatDateAEST(day);
    const request = `GET /v1/sites/${credentials.siteId}/prices?startDate=${dateStr}&endDate=${dateStr}`;

    // Fetch from Amber API
    const priceRecords = await fetchAmberPrices(credentials, day);

    // Build PointReadingGroup from price data
    const group = new PointReadingGroup(day);

    for (const record of priceRecords) {
      // Use nemTime (AEST/UTC+10) instead of endTime (UTC) to match our interval times
      const intervalMs = new Date(record.nemTime).getTime() as Milliseconds;
      const channelType = record.channelType;

      // Map channelType to channelId to match usage data keys
      const channelId =
        channelType === "general"
          ? "E1"
          : channelType === "feedIn"
            ? "B1"
            : channelType; // fallback for "controlledLoad" if present

      // Infer quality from type
      let quality: string | null = null;
      if (record.type === "ActualInterval") quality = "actual";
      else if (record.type === "CurrentInterval") quality = "actual";
      else if (record.type === "ForecastInterval") quality = "forecast";

      // perKwh reading (per-channel: E1.perKwh or B1.perKwh)
      group.add({
        pointMetadata: createAmberPointMetadata(channelId, channelType, "rate"),
        rawValue: record.perKwh,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: quality,
        sessionId: 0,
      });

      // spotPerKwh reading (grid-level: grid.spotPerKwh)
      group.add({
        pointMetadata: createGridPointMetadata("spotPerKwh"),
        rawValue: record.spotPerKwh,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: quality,
        sessionId: 0,
      });

      // renewables reading (grid-level: grid.renewables)
      group.add({
        pointMetadata: createGridPointMetadata("renewables"),
        rawValue: record.renewables,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: quality,
        sessionId: 0,
      });
    }

    // Get all views from group
    const { overviews, completeness, characterisation, numRecords } =
      group.getInfo();

    return {
      stage: stageName,
      completeness,
      overviews,
      numRecords,
      characterisation,
      records: group.getRecords(),
      request,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviews: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create point metadata for grid-level points (spotPerKwh, renewables, tariffPeriod)
 */
function createGridPointMetadata(
  subId: "spotPerKwh" | "renewables" | "tariffPeriod",
): PointMetadata {
  const metricConfig = {
    spotPerKwh: {
      defaultName: "Grid spot price",
      metricType: "rate" as const,
      unit: "cents_kWh",
    },
    renewables: {
      defaultName: "Grid renewables",
      metricType: "value" as const,
      unit: "percent",
    },
    tariffPeriod: {
      defaultName: "Tariff period",
      metricType: "code" as const,
      unit: "text",
    },
  };

  const config = metricConfig[subId];

  return {
    originId: "grid",
    originSubId: subId,
    defaultName: config.defaultName,
    subsystem: "grid",
    type: "bidi",
    subtype: "grid",
    extension: "import", // Grid-level, default to import
    metricType: config.metricType,
    metricUnit: config.unit,
    transform: null,
  };
}

/**
 * Stage 5: Compare Prices
 * Compares local price data with remote price data
 */
async function comparePrices(
  existingResult: StageResult,
  newPricesResult: StageResult,
  day: CalendarDate,
  stageName: string,
): Promise<StageResult> {
  if (existingResult.error || newPricesResult.error) {
    throw new Error(
      `Cannot compare with errors: existing=${existingResult.error}, new=${newPricesResult.error}`,
    );
  }

  try {
    // Get all new price point keys
    const newPriceKeys = Array.from(newPricesResult.overviews.keys()).sort();

    const {
      comparisonOverviewsByPoint,
      numSuperiorRecords,
      completeness,
      characterisation,
      records,
    } = compareRecords(existingResult, newPricesResult, day, newPriceKeys);

    return {
      stage: stageName,
      completeness,
      overviews: comparisonOverviewsByPoint,
      numRecords: numSuperiorRecords,
      characterisation,
      records,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviews: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Main Entry Points
 */

/**
 * Update Usage: Syncs usage data only
 *
 * Early termination logic:
 * - Stage 1: If local is all-billable, we're done
 * - Stage 2: If both local and remote are empty, we're done
 * - Stage 3: Compare and identify superior records
 */
export async function updateUsage(
  systemId: number,
  day: CalendarDate,
  credentials: AmberCredentials,
): Promise<SyncAudit> {
  const tracker = new StageTracker();
  const stages: StageResult[] = [];
  const startTime = Date.now();

  let error: string | undefined;
  let exception: Error | undefined;

  try {
    // STAGE 1: Load local data
    const localResult = await loadLocalUsage(
      systemId,
      day,
      tracker.nextStage("load local data"),
    );
    stages.push(localResult);

    if (localResult.error) {
      error = `Stage 1 failed: ${localResult.error}`;
    } else if (localResult.completeness === "all-billable") {
      // EARLY EXIT: Local already has complete billable data
      localResult.discovery = "local is already up to date";
    } else {
      // STAGE 2: Load remote usage
      const remoteResult = await loadRemoteUsage(
        credentials,
        day,
        tracker.nextStage("load remote usage"),
      );
      stages.push(remoteResult);

      if (remoteResult.error) {
        error = `Stage 2 failed: ${remoteResult.error}`;
      } else if (remoteResult.completeness === "none") {
        // EARLY EXIT: Both local and remote are empty
        remoteResult.discovery = "local and remote both empty";
      } else {
        // Set discovery based on what we found
        if (remoteResult.completeness === "all-billable") {
          remoteResult.discovery = "remote has full day of data";
        } else if (remoteResult.completeness === "mixed") {
          remoteResult.discovery =
            "local empty, remote has partial day of data (unexpected!)";
        }

        // STAGE 3: Compare usage
        const compareResult = await compareUsage(
          localResult,
          remoteResult,
          day,
          tracker.nextStage("compare local vs remote usage"),
        );
        stages.push(compareResult);

        if (compareResult.error) {
          error = `Stage 3 failed: ${compareResult.error}`;
        } else {
          // Verify completeness is not "none"
          if (compareResult.completeness === "none") {
            error =
              "Stage 3 unexpected: completeness is none (should be impossible)";
          } else {
            compareResult.discovery = `found ${compareResult.numRecords} superior remote records to update/insert`;
          }
        }
      }
    }
  } catch (ex) {
    exception = ex instanceof Error ? ex : new Error(String(ex));
    error = exception.message;
  }

  const result: SyncAudit = {
    systemId,
    day,
    stages,
    summary: {
      totalStages: stages.length,
      durationMs: (Date.now() - startTime) as Milliseconds,
    },
  };

  if (error !== undefined) result.summary.error = error;
  if (exception !== undefined) result.summary.exception = exception;

  return result;
}

/**
 * Update Forecasts: Syncs price/forecast data only
 *
 * Early termination logic:
 * - Stage 1: If local has all-billable price data, we're done
 * - Stage 2: If remote has no price data, we're done
 * - Stage 3: Compare and identify superior price records
 */
export async function updateForecasts(
  systemId: number,
  day: CalendarDate,
  credentials: AmberCredentials,
): Promise<SyncAudit> {
  const tracker = new StageTracker();
  const stages: StageResult[] = [];
  const startTime = Date.now();

  let error: string | undefined;
  let exception: Error | undefined;

  try {
    // STAGE 1: Load local data
    const localResult = await loadLocalUsage(
      systemId,
      day,
      tracker.nextStage("load local data"),
    );
    stages.push(localResult);

    if (localResult.error) {
      error = `Stage 1 failed: ${localResult.error}`;
    } else {
      // Check if local has price points (E1.perKwh, B1.perKwh, grid.spotPerKwh, grid.renewables)
      const hasPricePoints = Array.from(localResult.overviews.keys()).some(
        (key) => key === "grid.spotPerKwh" || key === "grid.renewables",
      );

      if (localResult.completeness === "all-billable" && hasPricePoints) {
        // EARLY EXIT: Local already has complete forecast data
        localResult.discovery = "local forecasts already up to date";
      } else {
        // STAGE 2: Load remote prices
        const pricesResult = await loadRemotePrices(
          credentials,
          day,
          tracker.nextStage("load remote prices"),
        );
        stages.push(pricesResult);

        if (pricesResult.error) {
          error = `Stage 2 failed: ${pricesResult.error}`;
        } else if (pricesResult.completeness === "none") {
          // EARLY EXIT: No price data available
          pricesResult.discovery = "no price data available yet";
        } else {
          // Set discovery based on what we found
          if (pricesResult.completeness === "mixed") {
            pricesResult.discovery = "remote has price forecasts available";
          } else if (pricesResult.completeness === "all-billable") {
            pricesResult.discovery = "remote has all actual prices";
          }

          // STAGE 3: Compare prices
          const compareResult = await comparePrices(
            localResult,
            pricesResult,
            day,
            tracker.nextStage("compare local vs remote prices"),
          );
          stages.push(compareResult);

          if (compareResult.error) {
            error = `Stage 3 failed: ${compareResult.error}`;
          } else {
            if (compareResult.completeness === "none") {
              error =
                "Stage 3 unexpected: completeness is none (should be impossible)";
            } else {
              compareResult.discovery = `found ${compareResult.numRecords} superior remote price records to update/insert`;
            }
          }
        }
      }
    }
  } catch (ex) {
    exception = ex instanceof Error ? ex : new Error(String(ex));
    error = exception.message;
  }

  const result: SyncAudit = {
    systemId,
    day,
    stages,
    summary: {
      totalStages: stages.length,
      durationMs: (Date.now() - startTime) as Milliseconds,
    },
  };

  if (error !== undefined) result.summary.error = error;
  if (exception !== undefined) result.summary.exception = exception;

  return result;
}
