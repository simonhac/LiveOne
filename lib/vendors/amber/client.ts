/**
 * Amber Electric Sync Client
 *
 * Methodical, audit-focused syncing with auto-numbered stages.
 * Phase 1: Read-only audit operations for data validation and comparison.
 */

import { CalendarDate } from "@internationalized/date";
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
 * Expand abbreviated quality back to full quality string
 * Reverse of abbreviateQuality
 */
function expandQuality(abbreviation: string): string | null {
  if (abbreviation === ".") return null;

  const lower = abbreviation.toLowerCase();

  // Map first letter back to full quality
  if (lower === "b") return "billable";
  if (lower === "a") return "actual";
  if (lower === "e") return "estimated";
  if (lower === "f") return "forecast";

  // Unknown quality
  return null;
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
 * Generate 48 half-hour interval timestamps for a day in AEST
 * Returns timestamps from 00:30 AEST to 00:00 AEST (next day)
 */
function generate48IntervalsAEST(day: CalendarDate): Milliseconds[] {
  const intervals: Milliseconds[] = [];

  const year = day.year;
  const month = day.month;
  const dayOfMonth = day.day;

  // Create midnight UTC for the day, then add AEST offset
  // AEST is UTC+10, so midnight AEST = midnight UTC + 10 hours
  // But we want the UTC timestamp that corresponds to midnight AEST
  // So: midnight AEST in UTC = midnight - 10 hours
  const midnightUTC =
    Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0, 0) - 10 * 60 * 60 * 1000;

  // Generate 48 intervals starting at 00:30 AEST
  for (let i = 0; i < 48; i++) {
    const intervalMinutes = 30 + i * 30; // 30, 60, 90, ..., 1440
    const intervalMs = midnightUTC + intervalMinutes * 60 * 1000;
    intervals.push(intervalMs as Milliseconds);
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
 * Build characterisation from overviews map
 * Analyzes all point overviews to determine quality ranges
 */
function buildCharacterisationFromOverviews(
  overviewsByPoint: Map<string, string>,
  day: CalendarDate,
): CharacterisationRange[] | undefined {
  const expectedIntervals = generate48IntervalsAEST(day);

  // Build intervals by analyzing each time slot across all points
  const intervals = expectedIntervals.map((timeMs, index) => {
    // Get the quality character for this interval from all points
    const qualitiesAtInterval = new Map<string | null, string[]>();

    for (const [pointKey, overview] of overviewsByPoint.entries()) {
      const qualityChar = overview[index];
      const quality = expandQuality(qualityChar); // Can be null for "."

      // Include all points, even those with null quality
      if (!qualitiesAtInterval.has(quality)) {
        qualitiesAtInterval.set(quality, []);
      }
      qualitiesAtInterval.get(quality)!.push(pointKey);
    }

    // Use the most common quality (prefer non-null over null)
    let dominantQuality: string | null = null;
    let dominantPoints: string[] = [];

    // First, try to find a non-null quality
    for (const [quality, points] of qualitiesAtInterval.entries()) {
      if (quality !== null && points.length > dominantPoints.length) {
        dominantQuality = quality;
        dominantPoints = points;
      }
    }

    // If no non-null quality found, use null quality points
    if (dominantQuality === null && qualitiesAtInterval.has(null)) {
      dominantQuality = null;
      dominantPoints = qualitiesAtInterval.get(null)!;
    }

    return {
      timeMs,
      quality: dominantQuality,
      pointOriginIds: dominantPoints.sort(),
    };
  });

  // Check if we have any non-null quality
  const hasData = intervals.some((i) => i.quality !== null);
  if (!hasData) return undefined;

  return buildCharacterisation(intervals);
}

/**
 * Count non-null records in the records map
 */
function countNonNullRecords(
  records: Map<string, Map<string, PointReading>> | undefined,
): number {
  if (!records) return 0;

  let count = 0;
  for (const intervalRecords of records.values()) {
    count += intervalRecords.size;
  }
  return count;
}

/**
 * Format interval time as key for records map
 */
function formatIntervalKey(
  intervalMs: Milliseconds,
  timezoneOffsetMin: number = 600,
): string {
  const date = new Date(intervalMs);
  // Add timezone offset to get AEST
  const aestDate = new Date(date.getTime() + timezoneOffsetMin * 60 * 1000);

  const year = aestDate.getUTCFullYear();
  const month = String(aestDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(aestDate.getUTCDate()).padStart(2, "0");
  const hours = String(aestDate.getUTCHours()).padStart(2, "0");
  const minutes = String(aestDate.getUTCMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}`;
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
 * Build records map from local database readings
 */
function buildRecordsMapFromLocal(
  readings: any[],
  allPoints: any[],
  expectedIntervals: Milliseconds[],
): Map<string, Map<string, PointReading>> {
  const recordsMap = new Map<string, Map<string, PointReading>>();

  for (const intervalMs of expectedIntervals) {
    const intervalReadings = readings.filter(
      (r) => r.intervalEnd === intervalMs,
    );

    if (intervalReadings.length === 0) continue;

    const timeKey = formatIntervalKey(intervalMs);
    const intervalRecords = new Map<string, PointReading>();

    for (const reading of intervalReadings) {
      const point = allPoints.find((p) => p.index === reading.pointId);
      if (!point) continue;

      const pointKey = point.originSubId
        ? `${point.originId}.${point.originSubId}`
        : point.originId;

      // Determine the value based on metric type
      let rawValue: any = null;
      if (point.metricType === "energy") {
        rawValue = reading.delta;
      } else if (point.metricType === "code") {
        rawValue = reading.valueStr;
      } else {
        rawValue = reading.avg ?? reading.last;
      }

      intervalRecords.set(pointKey, {
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
        measurementTimeMs: intervalMs,
        receivedTimeMs: (reading.createdAt || Date.now()) as Milliseconds,
        dataQuality: reading.dataQuality,
        sessionId: reading.sessionId || 0,
      });
    }

    if (intervalRecords.size > 0) {
      recordsMap.set(timeKey, intervalRecords);
    }
  }

  return recordsMap;
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
        overviewsByPoint: new Map(),
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

    // 4. Build overview for each point series
    const overviewsByPoint = new Map<string, string>();

    for (const point of allPoints) {
      const pointKey = point.originSubId
        ? `${point.originId}.${point.originSubId}`
        : point.originId;

      // Get readings for this specific point
      const pointReadings = readings.filter((r) => r.pointId === point.index);

      // Build map of intervalEnd -> reading for quick lookup
      const readingMap = new Map(pointReadings.map((r) => [r.intervalEnd, r]));

      // Build overview string for this point
      const overview = expectedIntervals
        .map((intervalMs) => {
          const reading = readingMap.get(intervalMs);
          return abbreviateQuality(reading?.dataQuality ?? null);
        })
        .join("");

      overviewsByPoint.set(pointKey, overview);
    }

    // 5. Verify all series have same completeness (only for points with data)
    if (overviewsByPoint.size > 0) {
      // Filter to only points that have at least some data (not all dots)
      const nonEmptyOverviews = Array.from(overviewsByPoint.entries()).filter(
        ([_, overview]) => overview.replace(/\./g, "").length > 0,
      );

      if (nonEmptyOverviews.length > 0) {
        const completenessValues = nonEmptyOverviews.map(([_, overview]) =>
          determineCompleteness(overview),
        );

        const firstCompleteness = completenessValues[0];
        if (!completenessValues.every((c) => c === firstCompleteness)) {
          const uniqueValues = [...new Set(completenessValues)].join(", ");
          throw new Error(
            `Completeness mismatch across series with data: ${uniqueValues}`,
          );
        }
      }
    }

    // Use first non-empty overview to determine overall completeness
    const nonEmptyOverviews = Array.from(overviewsByPoint.values()).filter(
      (overview) => overview.replace(/\./g, "").length > 0,
    );
    const firstOverview =
      nonEmptyOverviews.length > 0 ? nonEmptyOverviews[0] : "".padEnd(48, ".");

    const completeness = determineCompleteness(firstOverview);

    // 6. Build characterisation from overviews
    const characterisation = buildCharacterisationFromOverviews(
      overviewsByPoint,
      day,
    );

    // 7. Build records map
    const records = buildRecordsMapFromLocal(
      readings,
      allPoints,
      expectedIntervals,
    );

    // Count non-null records
    const numRecords = countNonNullRecords(records);

    return {
      stage: stageName,
      completeness,
      overviewsByPoint,
      numRecords,
      characterisation,
      records,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviewsByPoint: new Map(),
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

    // Build overview for each series
    const overviewsByPoint = buildOverviewsFromRecords(recordsByTime);

    // Verify all series have same completeness
    const completenessValues = Array.from(overviewsByPoint.values()).map((o) =>
      determineCompleteness(o),
    );

    if (completenessValues.length > 0) {
      const firstCompleteness = completenessValues[0];
      if (!completenessValues.every((c) => c === firstCompleteness)) {
        throw new Error(
          `Completeness mismatch across series: ${[...new Set(completenessValues)].join(", ")}`,
        );
      }
    }

    // Use first overview to determine overall completeness
    const firstOverview =
      overviewsByPoint.size > 0
        ? (overviewsByPoint.values().next().value ?? "".padEnd(48, "."))
        : "".padEnd(48, ".");
    const completeness = determineCompleteness(firstOverview);

    // Generate expected intervals for characterisation
    const expectedIntervals = generate48IntervalsAEST(day);

    // Build characterisation from overviews
    const characterisation = buildCharacterisationFromOverviews(
      overviewsByPoint,
      day,
    );

    // Build records map
    const records = buildRecordsMapFromAmber(recordsByTime, expectedIntervals);

    // Count non-null records
    const numRecords = countNonNullRecords(records);

    return {
      stage: stageName,
      completeness,
      overviewsByPoint,
      numRecords,
      characterisation,
      records,
      request,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviewsByPoint: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generic comparison function for comparing existing and new records
 * Builds overviews character by character using isNewRecordSuperior
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
} {
  const expectedIntervals = generate48IntervalsAEST(day);
  const comparisonOverviewsByPoint = new Map<string, string>();

  // Compare each point
  for (const pointKey of pointKeys) {
    const comparisonOverview: string[] = [];

    // Compare each interval
    for (const intervalMs of expectedIntervals) {
      const timeKey = formatIntervalKey(intervalMs);

      // Get existing and new records for this interval and point
      const existingIntervalRecords = existingResult.records?.get(timeKey);
      const newIntervalRecords = newResult.records?.get(timeKey);

      const existingRecord = existingIntervalRecords?.get(pointKey);
      const newRecord = newIntervalRecords?.get(pointKey);

      // Use isNewRecordSuperior to determine which is better
      if (isNewRecordSuperior(existingRecord, newRecord)) {
        // New is superior - use uppercase
        const quality = newRecord?.dataQuality ?? null;
        comparisonOverview.push(abbreviateQuality(quality).toUpperCase());
      } else {
        // Existing is same or better - use lowercase
        const quality = existingRecord?.dataQuality ?? null;
        comparisonOverview.push(abbreviateQuality(quality));
      }
    }

    comparisonOverviewsByPoint.set(pointKey, comparisonOverview.join(""));
  }

  // Determine completeness from first overview
  const firstOverview =
    comparisonOverviewsByPoint.values().next().value ?? "".padEnd(48, ".");
  const completeness = determineCompleteness(firstOverview);

  // Build characterisation - only include superior records (uppercase letters)
  const superiorOverviewsByPoint = new Map<string, string>();
  for (const [pointKey, overview] of comparisonOverviewsByPoint.entries()) {
    const superiorOnly = overview
      .split("")
      .map((char) => (char === char.toUpperCase() && char !== "." ? char : "."))
      .join("");
    superiorOverviewsByPoint.set(pointKey, superiorOnly);
  }

  const characterisation = buildCharacterisationFromOverviews(
    superiorOverviewsByPoint,
    day,
  );

  // Count superior records
  let numSuperiorRecords = 0;
  for (const overview of comparisonOverviewsByPoint.values()) {
    numSuperiorRecords += (overview.match(/[A-Z]/g) || []).length;
  }

  return {
    comparisonOverviewsByPoint,
    numSuperiorRecords,
    completeness,
    characterisation,
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
    // Only compare points that exist in existing (Stage 1)
    // Stage 2 may have different points (e.g., no grid.* points)
    const existingPointKeys = Array.from(
      existingResult.overviewsByPoint.keys(),
    ).sort();

    const {
      comparisonOverviewsByPoint,
      numSuperiorRecords,
      completeness,
      characterisation,
    } = compareRecords(existingResult, newResult, day, existingPointKeys);

    return {
      stage: stageName,
      completeness,
      overviewsByPoint: comparisonOverviewsByPoint,
      numRecords: numSuperiorRecords,
      characterisation,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviewsByPoint: new Map(),
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
 * Build records map from Amber usage data
 */
function buildRecordsMapFromAmber(
  recordsByTime: Map<Milliseconds, AmberUsageRecord[]>,
  expectedIntervals: Milliseconds[],
): Map<string, Map<string, PointReading>> {
  const recordsMap = new Map<string, Map<string, PointReading>>();

  for (const intervalMs of expectedIntervals) {
    const records = recordsByTime.get(intervalMs);
    if (!records || records.length === 0) continue;

    const timeKey = formatIntervalKey(intervalMs);
    const intervalRecords = new Map<string, PointReading>();

    for (const record of records) {
      // Create point readings for each metric
      const channelId = record.channelIdentifier;

      // Energy reading
      intervalRecords.set(`${channelId}.kwh`, {
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
      intervalRecords.set(`${channelId}.cost`, {
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
      intervalRecords.set(`${channelId}.perKwh`, {
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

    recordsMap.set(timeKey, intervalRecords);
  }

  return recordsMap;
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

    // Group by timestamp and channel
    const recordsByTime = new Map<Milliseconds, AmberPriceRecord[]>();
    for (const record of priceRecords) {
      const timeMs = new Date(record.endTime).getTime() as Milliseconds;
      const existing = recordsByTime.get(timeMs) || [];
      existing.push(record);
      recordsByTime.set(timeMs, existing);
    }

    // Build overview for each series (perKwh, spotPerKwh, renewables for each channel)
    const overviewsByPoint = new Map<string, string>();
    const seriesKeys = new Set<string>();

    // Identify all series from the records
    for (const records of recordsByTime.values()) {
      for (const record of records) {
        seriesKeys.add(`${record.channelType}.perKwh`);
        seriesKeys.add(`${record.channelType}.spotPerKwh`);
        seriesKeys.add(`${record.channelType}.renewables`);
      }
    }

    // Generate expected intervals
    const expectedIntervals = generate48IntervalsAEST(day);

    // Build overview for each series
    for (const seriesKey of seriesKeys) {
      const [channelType, metric] = seriesKey.split(".");
      const overview = expectedIntervals
        .map((timeMs) => {
          const records = recordsByTime.get(timeMs) || [];
          const record = records.find((r) => r.channelType === channelType);

          // Price records don't have a quality field, so we infer it from the type
          // ActualInterval = "actual", ForecastInterval = "forecast"
          let quality: string | null = null;
          if (record) {
            if (record.type === "ActualInterval") quality = "actual";
            else if (record.type === "CurrentInterval") quality = "actual";
            else if (record.type === "ForecastInterval") quality = "forecast";
          }

          return abbreviateQuality(quality);
        })
        .join("");

      overviewsByPoint.set(seriesKey, overview);
    }

    // Determine completeness from first overview
    const firstOverview =
      overviewsByPoint.size > 0
        ? (overviewsByPoint.values().next().value ?? "".padEnd(48, "."))
        : "".padEnd(48, ".");
    const completeness = determineCompleteness(firstOverview);

    // Build characterisation
    const characterisation = buildCharacterisationFromOverviews(
      overviewsByPoint,
      day,
    );

    // Build records map
    const records = new Map<string, Map<string, PointReading>>();
    for (const intervalMs of expectedIntervals) {
      const priceRecords = recordsByTime.get(intervalMs);
      if (!priceRecords || priceRecords.length === 0) continue;

      const timeKey = formatIntervalKey(intervalMs);
      const intervalRecords = new Map<string, PointReading>();

      for (const record of priceRecords) {
        const channelType = record.channelType;

        // Infer quality from type
        let quality: string | null = null;
        if (record.type === "ActualInterval") quality = "actual";
        else if (record.type === "CurrentInterval") quality = "actual";
        else if (record.type === "ForecastInterval") quality = "forecast";

        // perKwh reading
        intervalRecords.set(`${channelType}.perKwh`, {
          pointMetadata: createPricePointMetadata(channelType, "rate"),
          rawValue: record.perKwh,
          measurementTimeMs: intervalMs,
          receivedTimeMs: Date.now() as Milliseconds,
          dataQuality: quality,
          sessionId: 0,
        });

        // spotPerKwh reading
        intervalRecords.set(`${channelType}.spotPerKwh`, {
          pointMetadata: createPricePointMetadata(channelType, "rate"),
          rawValue: record.spotPerKwh,
          measurementTimeMs: intervalMs,
          receivedTimeMs: Date.now() as Milliseconds,
          dataQuality: quality,
          sessionId: 0,
        });

        // renewables reading
        intervalRecords.set(`${channelType}.renewables`, {
          pointMetadata: createPricePointMetadata(channelType, "percentage"),
          rawValue: record.renewables,
          measurementTimeMs: intervalMs,
          receivedTimeMs: Date.now() as Milliseconds,
          dataQuality: quality,
          sessionId: 0,
        });
      }

      if (intervalRecords.size > 0) {
        records.set(timeKey, intervalRecords);
      }
    }

    // Count non-null records
    const numRecords = countNonNullRecords(records);

    return {
      stage: stageName,
      completeness,
      overviewsByPoint,
      numRecords,
      characterisation,
      records,
      request,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviewsByPoint: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create point metadata for price points
 */
function createPricePointMetadata(
  channelType: string,
  metricType: "rate" | "percentage",
): PointMetadata {
  const metricConfig = {
    rate: { subId: "rate", unit: "cents_kWh" },
    percentage: { subId: "pct", unit: "percent" },
  };

  const config = metricConfig[metricType];
  const extension =
    channelType === "general"
      ? "import"
      : channelType === "feedIn"
        ? "export"
        : "controlled";

  return {
    originId: channelType,
    originSubId: config.subId,
    defaultName: `${channelType} ${metricType}`,
    subsystem: "grid",
    type: "bidi",
    subtype: "grid",
    extension,
    metricType: metricType === "rate" ? "rate" : "value",
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
    const newPriceKeys = Array.from(
      newPricesResult.overviewsByPoint.keys(),
    ).sort();

    const {
      comparisonOverviewsByPoint,
      numSuperiorRecords,
      completeness,
      characterisation,
    } = compareRecords(existingResult, newPricesResult, day, newPriceKeys);

    return {
      stage: stageName,
      completeness,
      overviewsByPoint: comparisonOverviewsByPoint,
      numRecords: numSuperiorRecords,
      characterisation,
    };
  } catch (error) {
    return {
      stage: stageName,
      completeness: "none",
      overviewsByPoint: new Map(),
      numRecords: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Main Entry Point
 */

/**
 * Sync Amber data for a specific day
 * Phase 1: Read-only audit operations
 *
 * @param systemId System ID to sync
 * @param day Calendar date to sync (AEST)
 * @param credentials Amber API credentials
 * @returns Complete sync audit with all stages
 */
export async function syncAmberDay(
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
    // Stage 1: Load local data
    const localUsageResult = await loadLocalUsage(
      systemId,
      day,
      tracker.nextStage("load local data"),
    );
    stages.push(localUsageResult);

    if (localUsageResult.error) {
      error = `Stage 1 failed: ${localUsageResult.error}`;
    } else {
      // Stage 2: Load remote usage
      const remoteUsageResult = await loadRemoteUsage(
        credentials,
        day,
        tracker.nextStage("load remote usage"),
      );
      stages.push(remoteUsageResult);

      if (remoteUsageResult.error) {
        error = `Stage 2 failed: ${remoteUsageResult.error}`;
      } else {
        // Stage 3: Compare usage
        const compareUsageResult = await compareUsage(
          localUsageResult,
          remoteUsageResult,
          day,
          tracker.nextStage("compare local vs remote usage"),
        );
        stages.push(compareUsageResult);

        if (compareUsageResult.error) {
          error = `Stage 3 failed: ${compareUsageResult.error}`;
        } else {
          // Stage 4: Load remote prices
          const remotePricesResult = await loadRemotePrices(
            credentials,
            day,
            tracker.nextStage("load remote prices"),
          );
          stages.push(remotePricesResult);

          if (remotePricesResult.error) {
            error = `Stage 4 failed: ${remotePricesResult.error}`;
          } else {
            // Stage 5: Compare prices
            const comparePricesResult = await comparePrices(
              localUsageResult,
              remotePricesResult,
              day,
              tracker.nextStage("compare local vs remote prices"),
            );
            stages.push(comparePricesResult);

            if (comparePricesResult.error) {
              error = `Stage 5 failed: ${comparePricesResult.error}`;
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
