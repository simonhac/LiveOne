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
  AmberSyncResult,
  CharacterisationRange,
  PointReading,
  BatchInfo,
} from "./types";
import type { PointMetadata } from "@/lib/monitoring-points-manager";
import { formatDateAEST } from "@/lib/date-utils";
import { AmberReadingsBatch } from "./amber-readings-batch";
import {
  createChannelPoint,
  createRenewablesPoint,
  createSpotPricePoint,
  getChannelMetadata,
} from "./point-metadata";
import { insertPointReadingsDirectTo5m } from "@/lib/monitoring-points-manager";

/**
 * Quality rank for comparison (single-character codes)
 * Higher values = higher precedence/quality
 */
const QUALITY_RANK: Record<string, number> = {
  b: 4, // billable
  a: 3, // actual
  e: 2, // estimated
  f: 1, // forecast
  ".": 0, // null/missing
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
 * Compare local and remote readings to determine which is superior
 *
 * @param local - Local record (may be undefined)
 * @param remote - Remote record (should not be undefined)
 * @returns 1 if remote wins, -1 if local wins, 0 if equal
 * @throws Error if remote is undefined (impossible situation)
 */
function compareReadings(
  local: PointReading | undefined,
  remote: PointReading | undefined,
): number {
  // Guard: throw if remote is null (impossible situation)
  if (!remote) {
    throw new Error("compareReadings: remote is null");
  }

  // Case 1: local is null → remote wins
  if (!local) return 1;

  // Case 2: Compare quality ranks
  const localRank = QUALITY_RANK[local.dataQuality] ?? 0;
  const remoteRank = QUALITY_RANK[remote.dataQuality] ?? 0;

  if (remoteRank > localRank) return 1;
  if (localRank > remoteRank) return -1;

  // Case 3: Same quality → compare values (exact equality)
  if (remote.rawValue !== local.rawValue) return 1;
  return 0;
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
          overviews: {},
          numRecords: 0,
          uniformQuality: null,
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
        overviews: {},
        numRecords: 0,
        uniformQuality: null,
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
  const startDateStr = formatDateAEST(firstDay);
  const endDay = firstDay.add({ days: numberOfDays - 1 });
  const endDateStr = formatDateAEST(endDay);
  const request = `GET /v1/sites/${credentials.siteId}/usage?startDate=${startDateStr}&endDate=${endDateStr}`;

  try {
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
        overviews: {},
        numRecords: 0,
        uniformQuality: null,
        canonical: [],
      },
      error: error instanceof Error ? error.message : String(error),
      request,
    };
  }
}

/**
 * Generic comparison function for comparing existing and new records
 *
 * Strategy:
 * 1. Create empty superiorPoints batch
 * 2. For each remote point key, build comparison overview showing:
 *    - Uppercase = remote wins (added to superiorPoints)
 *    - Lowercase = local wins
 *    - '=' = equal
 *    - '.' = both null
 * 3. Compute regular overviews and other BatchInfo from superiorPoints
 * 4. Return both regular overviews and comparison overviews
 */
function compareRecords(
  existingResult: StageResult,
  newResult: StageResult,
  firstDay: CalendarDate,
  numberOfDays: number,
  pointKeys: string[],
): BatchInfo & {
  comparisonOverviews: Record<string, string>;
  records: Map<string, Map<string, PointReading>>;
} {
  // Create empty AmberReadingsBatch for superior records
  const superiorPoints = new AmberReadingsBatch(firstDay, numberOfDays);

  // Initialize comparison overview builders for each remote point key
  const comparisonOverviewBuilders = new Map<string, string[]>();
  for (const pointKey of pointKeys) {
    comparisonOverviewBuilders.set(pointKey, []);
  }

  const localRecords = existingResult.records || new Map();
  const remoteRecords = newResult.records || new Map();

  // Generate expected intervals for the date range
  const expectedIntervals = generateIntervalsAEST(firstDay, numberOfDays);

  // Iterate through each interval and each remote point key
  for (const intervalMs of expectedIntervals) {
    const timeKey = String(intervalMs);

    for (const pointKey of pointKeys) {
      const localRecord = localRecords.get(timeKey)?.get(pointKey);
      const remoteRecord = remoteRecords.get(timeKey)?.get(pointKey);

      // Case 1: Both null
      if (!localRecord && !remoteRecord) {
        comparisonOverviewBuilders.get(pointKey)!.push(".");
        continue;
      }

      // Case 2: Local doesn't have this key (no local point for it)
      if (!localRecord && remoteRecord) {
        const quality = remoteRecord.dataQuality ?? ".";
        comparisonOverviewBuilders.get(pointKey)!.push(quality.toUpperCase());
        superiorPoints.add(remoteRecord);
        continue;
      }

      // Case 2b: Remote doesn't have this key (local wins by default, nothing to upgrade)
      if (localRecord && !remoteRecord) {
        const quality = localRecord.dataQuality ?? ".";
        comparisonOverviewBuilders.get(pointKey)!.push(quality);
        continue;
      }

      // Case 3: Both exist - use compareReadings to decide
      const comp = compareReadings(localRecord, remoteRecord);

      if (comp === 1) {
        // Remote wins
        const quality = remoteRecord!.dataQuality ?? ".";
        comparisonOverviewBuilders.get(pointKey)!.push(quality.toUpperCase());
        superiorPoints.add(remoteRecord!);
      } else if (comp === 0) {
        // Equal
        comparisonOverviewBuilders.get(pointKey)!.push("=");
      } else {
        // Local wins
        const quality = localRecord!.dataQuality ?? ".";
        comparisonOverviewBuilders.get(pointKey)!.push(quality);
      }
    }
  }

  // Build comparison overview strings
  const comparisonOverviews: Record<string, string> = {};
  for (const [pointKey, builder] of comparisonOverviewBuilders.entries()) {
    comparisonOverviews[pointKey] = builder.join("");
  }

  // Get all BatchInfo fields from superiorPoints
  const info = superiorPoints.getInfo();

  return {
    ...info,
    comparisonOverviews,
    records: superiorPoints.getRecords(),
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
    // Extract point keys from overviews object
    const getPointKeys = (overviews: Record<string, string>): string[] => {
      return Object.keys(overviews);
    };

    const pointKeys = useNewPoints
      ? getPointKeys(newResult.info.overviews).sort()
      : (() => {
          const local = getPointKeys(existingResult.info.overviews);
          const remote = getPointKeys(newResult.info.overviews);
          return (local.length > 0 ? local : remote).sort();
        })();

    const { comparisonOverviews, records, ...info } = compareRecords(
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
        // Keep regular overviews from superiorPoints and add comparison overviews
        comparisonOverviews,
      },
      records,
    };
  } catch (error) {
    return {
      stage: stageName,
      info: {
        overviews: {},
        numRecords: 0,
        uniformQuality: null,
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
  // Build request info for debugging
  const startDateStr = formatDateAEST(firstDay);
  const endDay = firstDay.add({ days: numberOfDays - 1 });
  const endDateStr = formatDateAEST(endDay);
  const request = `GET /v1/sites/${credentials.siteId}/prices?startDate=${startDateStr}&endDate=${endDateStr}`;

  try {
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

      // Infer quality from type (always has a value)
      let quality: string;
      if (record.type === "ActualInterval") quality = "actual";
      else if (record.type === "CurrentInterval") quality = "actual";
      else if (record.type === "ForecastInterval") quality = "forecast";
      else quality = "unknown"; // Fallback for unexpected types

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
        overviews: {},
        numRecords: 0,
        uniformQuality: null,
        canonical: [],
      },
      error: error instanceof Error ? error.message : String(error),
      request,
    };
  }
}

/**
 * Store superior records to local database (point_readings_agg_5m)
 */
async function storeRecordsLocally(
  systemId: number,
  sessionId: number,
  batch: AmberReadingsBatch,
  stageName: string,
): Promise<StageResult> {
  const records = batch.getRecords();

  // Flatten nested Map structure into array for insertPointReadingsDirectTo5m
  const readingsToInsert: Array<{
    pointMetadata: PointMetadata;
    rawValue: any;
    intervalEndMs: number;
    dataQuality?: string | null;
    error?: string | null;
  }> = [];

  for (const [intervalMsStr, pointMap] of records.entries()) {
    const intervalEndMs = Number(intervalMsStr);

    for (const [pointKey, reading] of pointMap.entries()) {
      readingsToInsert.push({
        pointMetadata: reading.pointMetadata,
        rawValue: reading.rawValue,
        intervalEndMs,
        dataQuality: reading.dataQuality ?? null,
        error: reading.error ?? null,
      });
    }
  }

  // Batch insert to point_readings_agg_5m
  await insertPointReadingsDirectTo5m(systemId, sessionId, readingsToInsert);

  // Return stage result
  return {
    stage: stageName,
    discovery: `inserted ${readingsToInsert.length} readings into database`,
    info: batch.getInfo(),
    numRowsInserted: readingsToInsert.length,
  };
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
 * - Stage 4: Store superior records to database
 */
export async function updateUsage(
  systemId: number,
  firstDay: CalendarDate,
  numberOfDays: number = 1,
  credentials: AmberCredentials,
  sessionId: number,
  dryRun: boolean = false,
): Promise<AmberSyncResult> {
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
      "usage stage 1: load local data",
    );
    stages.push(localResult);

    if (localResult.error) {
      error = `Usage stage 1 failed: ${localResult.error}`;
    } else if (localResult.info.uniformQuality === "b") {
      // EARLY EXIT: Local already has complete billable data
      localResult.discovery =
        "yay, we already have BILLABLE usage data locally for this period";
    } else {
      // Set discovery for local data when it's not billable
      if (localResult.info.uniformQuality !== null) {
        localResult.discovery =
          "billable usage data held locally for this period is INCOMPLETE";
      }

      // STAGE 2: Load remote usage
      const remoteResult = await loadRemoteUsage(
        credentials,
        firstDay,
        numberOfDays,
        "usage stage 2: load remote usage",
      );
      stages.push(remoteResult);

      if (remoteResult.error) {
        error = `Usage stage 2 failed: ${remoteResult.error}`;
      } else if (remoteResult.info.numRecords === 0) {
        // EARLY EXIT: remote is empty
        remoteResult.discovery =
          "remote usage data for this interval is NOT AVAILABLE";
      } else {
        // Set discovery based on what we found
        if (remoteResult.info.uniformQuality === "b") {
          remoteResult.discovery = "remote has full day of data";
        } else if (remoteResult.info.uniformQuality === undefined) {
          remoteResult.discovery =
            "local empty, remote has partial day of data (unexpected!)";
        }

        // STAGE 3: Compare usage
        const compareResult = createComparisonStage(
          localResult,
          remoteResult,
          firstDay,
          numberOfDays,
          "usage stage 3: compare local vs remote usage",
        );
        stages.push(compareResult);

        if (compareResult.error) {
          error = `Usage stage 3 failed: ${compareResult.error}`;
        } else {
          if (compareResult.info.numRecords === 0) {
            // No superior records - local is already equal to or better than remote
            compareResult.discovery =
              "local usage is already equal to or better than remote";
          } else {
            compareResult.discovery = `found ${compareResult.info.numRecords} superior remote records to update/insert`;

            // STAGE 4: Store superior records to database
            if (compareResult.records && compareResult.info.numRecords > 0) {
              const batch = new AmberReadingsBatch(firstDay, numberOfDays);
              for (const [
                intervalMsStr,
                pointMap,
              ] of compareResult.records.entries()) {
                for (const reading of pointMap.values()) {
                  batch.add(reading);
                }
              }

              if (!dryRun) {
                const storeResult = await storeRecordsLocally(
                  systemId,
                  sessionId,
                  batch,
                  "usage stage 4: store superior usage records",
                );
                stages.push(storeResult);

                if (storeResult.error) {
                  error = `Usage stage 4 failed: ${storeResult.error}`;
                }
              } else {
                // Dry run: create a stage result without actually storing
                stages.push({
                  stage:
                    "usage stage 4: store superior usage records (DRY RUN)",
                  discovery: `would insert ${compareResult.info.numRecords} readings (dry run, skipped)`,
                  info: batch.getInfo(),
                  numRowsInserted: 0,
                });
              }
            }
          }
        }
      }
    }
  } catch (ex) {
    exception = ex instanceof Error ? ex : new Error(String(ex));
    error = exception.message;
  }

  // Calculate total rows inserted from all stages
  const numRowsInserted = stages.reduce(
    (sum, stage) => sum + (stage.numRowsInserted ?? 0),
    0,
  );

  // Strip out records field from stages to reduce payload size
  const stagesWithoutRecords = stages.map(({ records, ...stage }) => stage);

  const result: AmberSyncResult = {
    action: "updateUsage",
    success: error === undefined && exception === undefined,
    systemId,
    firstDay,
    numberOfDays,
    stages: stagesWithoutRecords,
    summary: {
      totalStages: stages.length,
      numRowsInserted,
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
 * - Stage 4: Store superior records to database
 */
export async function updateForecasts(
  systemId: number,
  firstDay: CalendarDate,
  numberOfDays: number = 1,
  credentials: AmberCredentials,
  sessionId: number,
  dryRun: boolean = false,
): Promise<AmberSyncResult> {
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
      "forecast stage 1: load local data",
    );
    stages.push(localResult);

    if (localResult.error) {
      error = `Forecast stage 1 failed: ${localResult.error}`;
    } else {
      // Check if local has price points (E1.perKwh, B1.perKwh, grid.spotPerKwh, grid.renewables)
      const pointKeys = Object.keys(localResult.info.overviews);
      const hasPricePoints = pointKeys.some(
        (key) => key === "grid.spotPerKwh" || key === "grid.renewables",
      );

      if (localResult.info.uniformQuality === "b" && hasPricePoints) {
        // EARLY EXIT: Local already has complete forecast data
        localResult.discovery = "local forecasts already up to date";
      } else {
        // STAGE 2: Load remote prices
        const pricesResult = await loadRemotePrices(
          credentials,
          firstDay,
          numberOfDays,
          "forecast stage 2: load remote prices",
        );
        stages.push(pricesResult);

        if (pricesResult.error) {
          error = `Forecast stage 2 failed: ${pricesResult.error}`;
        } else if (pricesResult.info.numRecords === 0) {
          // EARLY EXIT: No price data available
          pricesResult.discovery = "no price data available yet";
        } else {
          // Set discovery based on what we found
          if (pricesResult.info.uniformQuality === undefined) {
            pricesResult.discovery = "remote has price forecasts available";
          } else if (pricesResult.info.uniformQuality === "b") {
            pricesResult.discovery = "remote has all actual prices";
          }

          // STAGE 3: Compare prices
          const compareResult = createComparisonStage(
            localResult,
            pricesResult,
            firstDay,
            numberOfDays,
            "forecast stage 3: compare local vs remote prices",
            true, // useNewPoints: true for prices
          );
          stages.push(compareResult);

          if (compareResult.error) {
            error = `Forecast stage 3 failed: ${compareResult.error}`;
          } else {
            if (compareResult.info.numRecords === 0) {
              // No superior records - local is already equal to or better than remote
              compareResult.discovery =
                "local prices are already equal to or better than remote";
            } else {
              compareResult.discovery = `found ${compareResult.info.numRecords} superior remote price records to update/insert`;

              // STAGE 4: Store superior records to database
              if (compareResult.records && compareResult.info.numRecords > 0) {
                const batch = new AmberReadingsBatch(firstDay, numberOfDays);
                for (const [
                  intervalMsStr,
                  pointMap,
                ] of compareResult.records.entries()) {
                  for (const reading of pointMap.values()) {
                    batch.add(reading);
                  }
                }

                if (!dryRun) {
                  const storeResult = await storeRecordsLocally(
                    systemId,
                    sessionId,
                    batch,
                    "forecast stage 4: store superior price records",
                  );
                  stages.push(storeResult);

                  if (storeResult.error) {
                    error = `Forecast stage 4 failed: ${storeResult.error}`;
                  }
                } else {
                  // Dry run: create a stage result without actually storing
                  stages.push({
                    stage:
                      "forecast stage 4: store superior price records (DRY RUN)",
                    discovery: `would insert ${compareResult.info.numRecords} readings (dry run, skipped)`,
                    info: batch.getInfo(),
                    numRowsInserted: 0,
                  });
                }
              }
            }
          }
        }
      }
    }
  } catch (ex) {
    exception = ex instanceof Error ? ex : new Error(String(ex));
    error = exception.message;
  }

  // Calculate total rows inserted from all stages
  const numRowsInserted = stages.reduce(
    (sum, stage) => sum + (stage.numRowsInserted ?? 0),
    0,
  );

  // Strip out records field from stages to reduce payload size
  const stagesWithoutRecords = stages.map(({ records, ...stage }) => stage);

  const result: AmberSyncResult = {
    action: "updateForecasts",
    success: error === undefined && exception === undefined,
    systemId,
    firstDay,
    numberOfDays,
    stages: stagesWithoutRecords,
    summary: {
      totalStages: stages.length,
      numRowsInserted,
      durationMs: (Date.now() - startTime) as Milliseconds,
    },
  };

  if (error !== undefined) result.summary.error = error;
  if (exception !== undefined) result.summary.exception = exception;

  return result;
}
