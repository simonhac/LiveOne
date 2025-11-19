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
  BatchInfo,
} from "./types";
import type { PointMetadata } from "@/lib/vendors/base-vendor-adapter";
import { formatDateAEST } from "@/lib/date-utils";
import { AmberReadingsBatch } from "./amber-readings-batch";
import {
  createChannelPoint,
  createRenewablesPoint,
  createSpotPricePoint,
  getChannelMetadata,
} from "./point-metadata";

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
 * @param overview - Overview string (48 × numberOfDays chars)
 * @param expectedLength - Expected overview length (48 × numberOfDays)
 */
function determineCompleteness(
  overview: string,
  expectedLength: number,
): Completeness {
  if (overview.length !== expectedLength) {
    throw new Error(
      `Invalid overview length: ${overview.length}, expected ${expectedLength}`,
    );
  }

  const nonNull = overview.replace(/\./g, "").length;
  const billable = overview.replace(/[^b]/g, "").length;

  if (billable === expectedLength) return "all-billable";
  if (nonNull === 0) return "none";
  return "mixed";
}

/**
 * Generate half-hour interval timestamps for a date range in AEST (UTC+10)
 * Returns timestamps from 00:30 AEST on firstDay to 00:00 AEST on (firstDay + numberOfDays)
 * Note: Uses fixed UTC+10 offset, NOT Australia/Sydney which observes DST
 * @param firstDay - Starting day
 * @param numberOfDays - Number of days (default: 1)
 * @returns Array of interval end timestamps (48 × numberOfDays intervals)
 */
function generateIntervalsAEST(
  firstDay: CalendarDate,
  numberOfDays: number = 1,
): Milliseconds[] {
  const intervals: Milliseconds[] = [];

  // Convert CalendarDate to ZonedDateTime at midnight in +10:00 timezone (AEST)
  let current = toZoned(toCalendarDateTime(firstDay), "+10:00");

  // Generate 48 × numberOfDays intervals starting at 00:30 AEST
  const totalIntervals = 48 * numberOfDays;
  for (let i = 0; i < totalIntervals; i++) {
    current = current.add({ minutes: 30 });
    intervals.push(current.toDate().getTime() as Milliseconds);
  }

  return intervals;
}

/**
 * Build AmberReadingsBatch from local database readings
 */
function buildRecordsMapFromLocal(
  readings: any[],
  allPoints: any[],
  firstDay: CalendarDate,
  numberOfDays: number,
): AmberReadingsBatch {
  const group = new AmberReadingsBatch(firstDay, numberOfDays);

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
 * Stage 1a: Load Local Records
 * Fetches all point readings from the database for the specified date range
 */
async function loadLocalRecords(
  systemId: number,
  firstDay: CalendarDate,
  numberOfDays: number,
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
        info: {
          completeness: "none",
          overviews: new Map(),
          numRecords: 0,
          canonical: [],
        },
        error: "No points found for system",
      };
    }

    // 2. Generate expected intervals
    const expectedIntervals = generateIntervalsAEST(firstDay, numberOfDays);

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

    // 4. Build AmberReadingsBatch from database readings
    const group = buildRecordsMapFromLocal(
      readings,
      allPoints,
      firstDay,
      numberOfDays,
    );

    // 5. Get all views from group
    const info = group.getInfo();

    return {
      stage: stageName,
      info,
      records: group.getRecords(),
    };
  } catch (error) {
    return {
      stage: stageName,
      info: {
        completeness: "none",
        overviews: new Map(),
        numRecords: 0,
        canonical: [],
      },
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
  firstDay: CalendarDate,
  numberOfDays: number,
  stageName: string,
): Promise<StageResult> {
  try {
    const startDateStr = formatDateAEST(firstDay);
    const endDay = firstDay.add({ days: numberOfDays - 1 });
    const endDateStr = formatDateAEST(endDay);
    const request = `GET /v1/sites/${credentials.siteId}/usage?startDate=${startDateStr}&endDate=${endDateStr}`;

    // Fetch from Amber API
    const usageRecords = await fetchAmberUsage(
      credentials,
      firstDay,
      numberOfDays,
    );

    // Group by timestamp
    const recordsByTime = groupRecordsByTime(usageRecords);

    // Build AmberReadingsBatch from Amber data
    const group = buildRecordsMapFromAmber(
      recordsByTime,
      firstDay,
      numberOfDays,
    );

    // Get all views from group
    const info = group.getInfo();

    return {
      stage: stageName,
      info,
      records: group.getRecords(),
      request,
    };
  } catch (error) {
    return {
      stage: stageName,
      info: {
        completeness: "none",
        overviews: new Map(),
        numRecords: 0,
        canonical: [],
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generic comparison function for comparing existing and new records
 *
 * Strategy:
 * 1. Iterate through intervals and points, building superior AmberReadingsBatch
 * 2. Build comparison overview character-by-character (uppercase = superior)
 * 3. Use AmberReadingsBatch methods to derive views from superior records
 */
function compareRecords(
  existingResult: StageResult,
  newResult: StageResult,
  firstDay: CalendarDate,
  numberOfDays: number,
  pointKeys: string[],
): BatchInfo & {
  comparisonOverviewsByPoint: Map<string, string>;
  records: Map<string, Map<string, PointReading>>;
} {
  // Create AmberReadingsBatch for superior records
  const superiorGroup = new AmberReadingsBatch(firstDay, numberOfDays);

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

        // Add uppercase to comparison overview (quality is already single lowercase letter)
        const quality = newRecord.dataQuality ?? ".";
        comparisonOverviewBuilders.get(pointKey)!.push(quality.toUpperCase());
      } else {
        // Existing is same or better - add lowercase to comparison overview
        const quality = existingRecord?.dataQuality ?? ".";
        comparisonOverviewBuilders.get(pointKey)!.push(quality);
      }
    }
  }

  // Build comparison overview strings
  const comparisonOverviewsByPoint = new Map<string, string>();
  for (const [pointKey, builder] of comparisonOverviewBuilders.entries()) {
    comparisonOverviewsByPoint.set(pointKey, builder.join(""));
  }

  // Determine completeness from comparison overview
  const expectedLength = 48 * numberOfDays;
  const firstOverview =
    comparisonOverviewsByPoint.values().next().value ??
    "".padEnd(expectedLength, ".");
  const completeness = determineCompleteness(firstOverview, expectedLength);

  // Get characterisation and canonical from superior group
  const characterisation = superiorGroup.getCharacterisation();
  const canonical = superiorGroup.getCanonicalDisplay();
  const numRecords = superiorGroup.getCount();

  return {
    completeness,
    overviews: comparisonOverviewsByPoint,
    numRecords,
    characterisation,
    canonical,
    comparisonOverviewsByPoint,
    records: superiorGroup.getRecords(),
  };
}

/**
 * Stage 3: Compare Local vs Remote Usage
 * Compares local and remote data, identifies superior remote data
 */
/**
 * Generic comparison function for both usage and prices
 * For usage: uses local points if available, otherwise remote
 * For prices: uses all new price points
 */
function createComparisonStage(
  existingResult: StageResult,
  newResult: StageResult,
  firstDay: CalendarDate,
  numberOfDays: number,
  stageName: string,
  useNewPoints: boolean = false,
): StageResult {
  if (existingResult.error || newResult.error) {
    throw new Error(
      `Cannot compare with errors: existing=${existingResult.error}, new=${newResult.error}`,
    );
  }

  try {
    const pointKeys = useNewPoints
      ? Array.from(newResult.info.overviews.keys()).sort()
      : (() => {
          const local = Array.from(existingResult.info.overviews.keys());
          const remote = Array.from(newResult.info.overviews.keys());
          return (local.length > 0 ? local : remote).sort();
        })();

    const { comparisonOverviewsByPoint, records, ...info } = compareRecords(
      existingResult,
      newResult,
      firstDay,
      numberOfDays,
      pointKeys,
    );

    return {
      stage: stageName,
      info: {
        ...info,
        overviews: comparisonOverviewsByPoint,
      },
      records,
    };
  } catch (error) {
    return {
      stage: stageName,
      info: {
        completeness: "none",
        overviews: new Map(),
        numRecords: 0,
        canonical: [],
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Amber API Integration
 */

/**
 * Fetch usage data from Amber API
 * @param credentials - Amber API credentials
 * @param firstDay - Starting day of the range
 * @param numberOfDays - Number of days to fetch (default: 1)
 */
async function fetchAmberUsage(
  credentials: AmberCredentials,
  firstDay: CalendarDate,
  numberOfDays: number = 1,
): Promise<AmberUsageRecord[]> {
  const startDateStr = formatDateAEST(firstDay);
  const endDay = firstDay.add({ days: numberOfDays - 1 });
  const endDateStr = formatDateAEST(endDay);

  const url = `https://api.amber.com.au/v1/sites/${credentials.siteId}/usage`;
  const params = new URLSearchParams({
    startDate: startDateStr,
    endDate: endDateStr,
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
 * Build AmberReadingsBatch from Amber usage data
 */
function buildRecordsMapFromAmber(
  recordsByTime: Map<Milliseconds, AmberUsageRecord[]>,
  firstDay: CalendarDate,
  numberOfDays: number,
): AmberReadingsBatch {
  const group = new AmberReadingsBatch(firstDay, numberOfDays);

  for (const [intervalMs, records] of recordsByTime.entries()) {
    for (const record of records) {
      // Create point readings for each metric
      const channelId = record.channelIdentifier;

      // Energy reading
      group.add({
        pointMetadata: createChannelPoint(
          getChannelMetadata(channelId, record.channelType),
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
        pointMetadata: createChannelPoint(
          getChannelMetadata(channelId, record.channelType),
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
        pointMetadata: createChannelPoint(
          getChannelMetadata(channelId, record.channelType),
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
 * Fetch price data from Amber API for the specified date range
 * @param credentials - Amber API credentials
 * @param firstDay - Starting day of the range
 * @param numberOfDays - Number of days to fetch (default: 1)
 */
async function fetchAmberPrices(
  credentials: AmberCredentials,
  firstDay: CalendarDate,
  numberOfDays: number = 1,
): Promise<AmberPriceRecord[]> {
  const startDateStr = formatDateAEST(firstDay);
  const endDay = firstDay.add({ days: numberOfDays - 1 });
  const endDateStr = formatDateAEST(endDay);

  const url = `https://api.amber.com.au/v1/sites/${credentials.siteId}/prices`;
  const params = new URLSearchParams({
    startDate: startDateStr,
    endDate: endDateStr,
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
 * Fetches price data from Amber API for the specified date range
 */
async function loadRemotePrices(
  credentials: AmberCredentials,
  firstDay: CalendarDate,
  numberOfDays: number,
  stageName: string,
): Promise<StageResult> {
  try {
    // Build request info for debugging
    const startDateStr = formatDateAEST(firstDay);
    const endDay = firstDay.add({ days: numberOfDays - 1 });
    const endDateStr = formatDateAEST(endDay);
    const request = `GET /v1/sites/${credentials.siteId}/prices?startDate=${startDateStr}&endDate=${endDateStr}`;

    // Fetch from Amber API
    const priceRecords = await fetchAmberPrices(
      credentials,
      firstDay,
      numberOfDays,
    );

    // Build AmberReadingsBatch from price data
    const group = new AmberReadingsBatch(firstDay, numberOfDays);

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
        pointMetadata: createChannelPoint(
          getChannelMetadata(channelId, channelType),
          "rate",
        ),
        rawValue: record.perKwh,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: quality,
        sessionId: 0,
      });

      // spotPerKwh reading (grid-level: grid.spotPerKwh)
      group.add({
        pointMetadata: createSpotPricePoint(),
        rawValue: record.spotPerKwh,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: quality,
        sessionId: 0,
      });

      // renewables reading (grid-level: grid.renewables)
      group.add({
        pointMetadata: createRenewablesPoint(),
        rawValue: record.renewables,
        measurementTimeMs: intervalMs,
        receivedTimeMs: Date.now() as Milliseconds,
        dataQuality: quality,
        sessionId: 0,
      });
    }

    // Get all views from group
    const info = group.getInfo();

    return {
      stage: stageName,
      info,
      records: group.getRecords(),
      request,
    };
  } catch (error) {
    return {
      stage: stageName,
      info: {
        completeness: "none",
        overviews: new Map(),
        numRecords: 0,
        canonical: [],
      },
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
  firstDay: CalendarDate,
  numberOfDays: number = 1,
  credentials: AmberCredentials,
): Promise<SyncAudit> {
  const tracker = new StageTracker();
  const stages: StageResult[] = [];
  const startTime = Date.now();

  let error: string | undefined;
  let exception: Error | undefined;

  try {
    // STAGE 1: Load local data
    const localResult = await loadLocalRecords(
      systemId,
      firstDay,
      numberOfDays,
      tracker.nextStage("load local data"),
    );
    stages.push(localResult);

    if (localResult.error) {
      error = `Stage 1 failed: ${localResult.error}`;
    } else if (localResult.info.completeness === "all-billable") {
      // EARLY EXIT: Local already has complete billable data
      localResult.discovery = "local is already up to date";
    } else {
      // STAGE 2: Load remote usage
      const remoteResult = await loadRemoteUsage(
        credentials,
        firstDay,
        numberOfDays,
        tracker.nextStage("load remote usage"),
      );
      stages.push(remoteResult);

      if (remoteResult.error) {
        error = `Stage 2 failed: ${remoteResult.error}`;
      } else if (remoteResult.info.completeness === "none") {
        // EARLY EXIT: Both local and remote are empty
        remoteResult.discovery = "local and remote both empty";
      } else {
        // Set discovery based on what we found
        if (remoteResult.info.completeness === "all-billable") {
          remoteResult.discovery = "remote has full day of data";
        } else if (remoteResult.info.completeness === "mixed") {
          remoteResult.discovery =
            "local empty, remote has partial day of data (unexpected!)";
        }

        // STAGE 3: Compare usage
        const compareResult = createComparisonStage(
          localResult,
          remoteResult,
          firstDay,
          numberOfDays,
          tracker.nextStage("compare local vs remote usage"),
        );
        stages.push(compareResult);

        if (compareResult.error) {
          error = `Stage 3 failed: ${compareResult.error}`;
        } else {
          // Verify completeness is not "none"
          if (compareResult.info.completeness === "none") {
            error =
              "Stage 3 unexpected: completeness is none (should be impossible)";
          } else {
            compareResult.discovery = `found ${compareResult.info.numRecords} superior remote records to update/insert`;
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
    firstDay,
    numberOfDays,
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
  firstDay: CalendarDate,
  numberOfDays: number = 1,
  credentials: AmberCredentials,
): Promise<SyncAudit> {
  const tracker = new StageTracker();
  const stages: StageResult[] = [];
  const startTime = Date.now();

  let error: string | undefined;
  let exception: Error | undefined;

  try {
    // STAGE 1: Load local data
    const localResult = await loadLocalRecords(
      systemId,
      firstDay,
      numberOfDays,
      tracker.nextStage("load local data"),
    );
    stages.push(localResult);

    if (localResult.error) {
      error = `Stage 1 failed: ${localResult.error}`;
    } else {
      // Check if local has price points (E1.perKwh, B1.perKwh, grid.spotPerKwh, grid.renewables)
      const hasPricePoints = Array.from(localResult.info.overviews.keys()).some(
        (key) => key === "grid.spotPerKwh" || key === "grid.renewables",
      );

      if (localResult.info.completeness === "all-billable" && hasPricePoints) {
        // EARLY EXIT: Local already has complete forecast data
        localResult.discovery = "local forecasts already up to date";
      } else {
        // STAGE 2: Load remote prices
        const pricesResult = await loadRemotePrices(
          credentials,
          firstDay,
          numberOfDays,
          tracker.nextStage("load remote prices"),
        );
        stages.push(pricesResult);

        if (pricesResult.error) {
          error = `Stage 2 failed: ${pricesResult.error}`;
        } else if (pricesResult.info.completeness === "none") {
          // EARLY EXIT: No price data available
          pricesResult.discovery = "no price data available yet";
        } else {
          // Set discovery based on what we found
          if (pricesResult.info.completeness === "mixed") {
            pricesResult.discovery = "remote has price forecasts available";
          } else if (pricesResult.info.completeness === "all-billable") {
            pricesResult.discovery = "remote has all actual prices";
          }

          // STAGE 3: Compare prices
          const compareResult = createComparisonStage(
            localResult,
            pricesResult,
            firstDay,
            numberOfDays,
            tracker.nextStage("compare local vs remote prices"),
            true, // useNewPoints: true for prices
          );
          stages.push(compareResult);

          if (compareResult.error) {
            error = `Stage 3 failed: ${compareResult.error}`;
          } else {
            if (compareResult.info.completeness === "none") {
              error =
                "Stage 3 unexpected: completeness is none (should be impossible)";
            } else {
              compareResult.discovery = `found ${compareResult.info.numRecords} superior remote price records to update/insert`;
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
    firstDay,
    numberOfDays,
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
