/**
 * AmberReadingsBatch - Encapsulates a day's worth of point readings
 * organized by time interval and point key
 */

import type { CalendarDate } from "@internationalized/date";
import { toCalendarDateTime, toZoned, fromDate } from "@internationalized/date";
import type {
  PointReading,
  CharacterisationRange,
  Milliseconds,
  SimplifiedSampleRecord,
} from "./types";

/**
 * Generates all half-hour interval end times for a given date range (AEST = UTC+10)
 * Note: Amber uses fixed UTC+10 (AEST), NOT Australia/Sydney timezone which observes DST
 * @param firstDay - Starting day of the range
 * @param numberOfDays - Number of days to generate (default: 1)
 * @returns Array of interval end times (48 × numberOfDays intervals)
 */
function generateIntervalEndTimes(
  firstDay: CalendarDate,
  numberOfDays: number = 1,
): Milliseconds[] {
  const intervals: Milliseconds[] = [];

  // Convert CalendarDate to ZonedDateTime at midnight in +10:00 timezone (AEST)
  let current = toZoned(toCalendarDateTime(firstDay), "+10:00");

  // Generate 48 × numberOfDays intervals starting at 00:30 AEST on firstDay
  const totalIntervals = 48 * numberOfDays;
  for (let i = 0; i < totalIntervals; i++) {
    current = current.add({ minutes: 30 });
    intervals.push(current.toDate().getTime() as Milliseconds);
  }

  return intervals;
}

/**
 * Abbreviates quality string to single character for overview
 */
export function abbreviateQuality(quality: string | null | undefined): string {
  if (!quality) return ".";
  return quality.charAt(0).toLowerCase();
}

/**
 * Derives a point key from physicalPath for internal grouping
 * e.g., "amber/E1/perKwh" -> "E1.perKwh"
 * e.g., "amber/grid/spotPerKwh" -> "grid.spotPerKwh"
 */
function derivePointKey(physicalPath: string): string {
  // physicalPath format: "vendor/segments..." -> we want everything after vendor joined with "."
  const segments = physicalPath.split("/");
  if (segments.length <= 1) return physicalPath;
  // Skip the first segment (vendor) and join rest with "."
  return segments.slice(1).join(".");
}

export class AmberReadingsBatch {
  private records: Map<string, Map<string, PointReading>>;
  private firstDay: CalendarDate;
  private numberOfDays: number;
  private intervalEndTimes: Milliseconds[];

  constructor(firstDay: CalendarDate, numberOfDays: number = 1) {
    this.firstDay = firstDay;
    this.numberOfDays = numberOfDays;
    this.intervalEndTimes = generateIntervalEndTimes(firstDay, numberOfDays);
    this.records = new Map();

    // Prepopulate map with all time keys
    for (const intervalEndTimeMs of this.intervalEndTimes) {
      this.records.set(String(intervalEndTimeMs), new Map());
    }
  }

  /**
   * Add a point reading to the group
   * Throws exception if reading is outside the date range boundaries
   */
  add(reading: PointReading): void {
    // Validate reading is within date range boundaries
    const rangeStart = (this.intervalEndTimes[0] -
      30 * 60 * 1000) as Milliseconds;
    const rangeEnd = this.intervalEndTimes[this.intervalEndTimes.length - 1];

    const pointKey = derivePointKey(reading.pointMetadata.physicalPathTail);

    if (
      reading.measurementTimeMs < rangeStart ||
      reading.measurementTimeMs > rangeEnd
    ) {
      throw new Error(
        `Cannot add reading for ${pointKey} with timestamp ${reading.measurementTimeMs} ` +
          `(${new Date(reading.measurementTimeMs).toISOString()}) - ` +
          `outside range boundaries [${rangeStart}, ${rangeEnd}] ` +
          `(${new Date(rangeStart).toISOString()} to ${new Date(rangeEnd).toISOString()})` +
          ` for ${this.numberOfDays} day(s) starting ${this.firstDay.toString()}`,
      );
    }

    const timeKey = String(reading.measurementTimeMs);

    if (!this.records.has(timeKey)) {
      // This shouldn't happen if we prepopulated correctly, but handle gracefully
      this.records.set(timeKey, new Map());
    }

    // Normalize quality to single lowercase letter on entry
    const normalizedReading: PointReading = {
      ...reading,
      dataQuality: abbreviateQuality(reading.dataQuality),
    };

    this.records.get(timeKey)!.set(pointKey, normalizedReading);
  }

  /**
   * Get a point reading for a specific time and point
   */
  get(
    intervalEndTimeMs: Milliseconds,
    pointKey: string,
  ): PointReading | undefined {
    return this.records.get(String(intervalEndTimeMs))?.get(pointKey);
  }

  /**
   * Get all records (for passing to stages that need them)
   */
  getRecords(): Map<string, Map<string, PointReading>> {
    return this.records;
  }

  /**
   * Get all point keys that have at least one reading
   */
  getPointKeys(): string[] {
    const pointKeys = new Set<string>();
    for (const pointMap of this.records.values()) {
      for (const pointKey of pointMap.keys()) {
        pointKeys.add(pointKey);
      }
    }
    return Array.from(pointKeys).sort();
  }

  /**
   * Get all readings for a specific point, in chronological order
   * Returns array of [intervalEndTimeMs, reading | undefined] tuples
   */
  getPointRecords(
    pointKey: string,
  ): Array<[Milliseconds, PointReading | undefined]> {
    const entries: Array<[Milliseconds, PointReading | undefined]> = [];
    for (const intervalEndTimeMs of this.intervalEndTimes) {
      const reading = this.records
        .get(String(intervalEndTimeMs))
        ?.get(pointKey);
      entries.push([intervalEndTimeMs, reading]);
    }
    return entries;
  }

  /**
   * Count total number of non-null readings
   */
  getCount(): number {
    let count = 0;
    for (const pointMap of this.records.values()) {
      count += pointMap.size;
    }
    return count;
  }

  /**
   * Generate overview string for a specific point (48 × numberOfDays chars)
   * Quality is already normalized to single lowercase letter when added
   */
  getOverview(pointKey: string): string {
    let overview = "";
    for (const intervalEndTimeMs of this.intervalEndTimes) {
      const reading = this.records
        .get(String(intervalEndTimeMs))
        ?.get(pointKey);
      overview += reading?.dataQuality ?? ".";
    }
    return overview;
  }

  /**
   * Get all unique point keys present in this batch
   */
  getKeys(): string[] {
    const pointKeys = new Set<string>();
    for (const pointMap of this.records.values()) {
      for (const pointKey of pointMap.keys()) {
        pointKeys.add(pointKey);
      }
    }
    return Array.from(pointKeys).sort();
  }

  /**
   * Get the uniform quality across all readings, if uniform
   * Returns the quality if all readings have the same quality, undefined if mixed
   *
   * @returns The uniform quality ('a', 'b', 'f', '.') or null if no data, undefined if mixed
   *
   * Examples:
   * - Returns 'b' if all readings are billable
   * - Returns 'a' if all readings are actual
   * - Returns '.' if all readings have missing/null quality
   * - Returns null if there's no data
   * - Returns undefined if qualities are mixed
   */
  getUniformQuality(): string | null | undefined {
    let firstQuality: string | undefined = undefined;
    let hasFoundFirst = false;

    for (const pointMap of this.records.values()) {
      for (const reading of pointMap.values()) {
        // dataQuality is always a string (never undefined) because abbreviateQuality is called on entry
        const readingQuality = reading.dataQuality;

        if (!hasFoundFirst) {
          // First reading sets the expected quality
          firstQuality = readingQuality;
          hasFoundFirst = true;
        } else if (readingQuality !== firstQuality) {
          // Found a different quality - not uniform
          return undefined;
        }
      }
    }

    // If no data was found, return null
    // Otherwise return the uniform quality (which could be '.' for missing quality)
    return hasFoundFirst ? firstQuality : null;
  }

  /**
   * Generate characterisation ranges using a streaming algorithm:
   * - Maintains open ranges (currently being extended)
   * - Closes ranges when point quality changes or points disappear
   * - Creates new ranges when new point/quality combinations appear
   *
   * Returns undefined only if there's no data.
   * Generates characterisation even for uniform quality data.
   */
  getCharacterisation(): CharacterisationRange[] | undefined {
    // No data - no characterisation
    if (this.getCount() === 0) {
      return undefined;
    }

    // Generate detailed characterisation ranges

    interface OpenRange {
      quality: string;
      pointOriginIds: Set<string>;
      startIntervalIdx: number;
      endIntervalIdx: number;
    }

    const openRanges: OpenRange[] = [];
    const closedRanges: CharacterisationRange[] = [];

    for (let i = 0; i < this.intervalEndTimes.length; i++) {
      const intervalEndTimeMs = this.intervalEndTimes[i];
      const pointMap = this.records.get(String(intervalEndTimeMs))!;

      // Build bag of readings at this interval: Map<pointKey, quality>
      const bag = new Map<string, string>();
      for (const [pointKey, reading] of pointMap.entries()) {
        if (reading && reading.dataQuality) {
          bag.set(pointKey, reading.dataQuality);
        }
      }

      // Process each open range: extend or close
      const rangesToKeepOpen: OpenRange[] = [];
      for (const range of openRanges) {
        let canExtend = true;

        // Check if all points in the range still have the same quality
        for (const pointKey of range.pointOriginIds) {
          const quality = bag.get(pointKey);
          if (quality !== range.quality) {
            canExtend = false;
            break;
          }
        }

        if (canExtend) {
          // Extend the range and remove points from bag
          range.endIntervalIdx = i;
          for (const pointKey of range.pointOriginIds) {
            bag.delete(pointKey);
          }
          rangesToKeepOpen.push(range);
        } else {
          // Close the range
          const rangeStartTimeMs: Milliseconds =
            range.startIntervalIdx === 0
              ? ((this.intervalEndTimes[0] - 30 * 60 * 1000) as Milliseconds)
              : this.intervalEndTimes[range.startIntervalIdx - 1];

          closedRanges.push({
            rangeStartTimeMs,
            rangeEndTimeMs: this.intervalEndTimes[range.endIntervalIdx],
            quality: range.quality,
            pointOriginIds: Array.from(range.pointOriginIds).sort(),
            numPeriods: range.endIntervalIdx - range.startIntervalIdx + 1,
          });
        }
      }

      openRanges.length = 0;
      openRanges.push(...rangesToKeepOpen);

      // Process remaining readings in bag - these are NEW or CHANGED points
      // They can only join NEW ranges (created in this interval), not existing open ranges
      const newRanges: OpenRange[] = [];

      for (const [pointKey, quality] of bag.entries()) {
        // Check if there's a NEW range (created this interval) with matching quality
        let foundNewRange = newRanges.find((r) => r.quality === quality);

        if (foundNewRange) {
          // Add point to the new range
          foundNewRange.pointOriginIds.add(pointKey);
        } else {
          // Create a new range
          newRanges.push({
            quality,
            pointOriginIds: new Set([pointKey]),
            startIntervalIdx: i,
            endIntervalIdx: i,
          });
        }
      }

      // Add all new ranges to open ranges
      openRanges.push(...newRanges);
    }

    // Close all remaining open ranges
    for (const range of openRanges) {
      const rangeStartTimeMs: Milliseconds =
        range.startIntervalIdx === 0
          ? ((this.intervalEndTimes[0] - 30 * 60 * 1000) as Milliseconds)
          : this.intervalEndTimes[range.startIntervalIdx - 1];

      closedRanges.push({
        rangeStartTimeMs,
        rangeEndTimeMs: this.intervalEndTimes[range.endIntervalIdx],
        quality: range.quality,
        pointOriginIds: Array.from(range.pointOriginIds).sort(),
        numPeriods: range.endIntervalIdx - range.startIntervalIdx + 1,
      });
    }

    return closedRanges;
  }

  /**
   * Generate canonical display table (4 rows: time, E1.perKwh, renewables, quality)
   * Returns array of formatted strings with 6-char columns for monospaced display
   */
  getCanonicalDisplay(): string[] {
    if (this.intervalEndTimes.length === 0) {
      return [];
    }

    // Build table rows
    const timeRow: string[] = [];
    const e1PerKwhRow: string[] = [];
    const renewablesRow: string[] = [];
    const qualityRow: string[] = [];

    for (const intervalEndTimeMs of this.intervalEndTimes) {
      const pointMap = this.records.get(String(intervalEndTimeMs));
      if (!pointMap) continue;

      // Convert to ZonedDateTime in Melbourne timezone and subtract 30 minutes to get interval start
      const intervalEndZoned = toZoned(
        fromDate(new Date(intervalEndTimeMs), "UTC"),
        "Australia/Melbourne",
      );
      const intervalStartZoned = intervalEndZoned.subtract({ minutes: 30 });
      const timeStr = `${String(intervalStartZoned.hour).padStart(2, "0")}:${String(intervalStartZoned.minute).padStart(2, "0")}`;
      timeRow.push(timeStr);

      // Get E1.perKwh value
      const e1PerKwh = pointMap.get("E1.perKwh");
      if (e1PerKwh && e1PerKwh.rawValue !== null) {
        e1PerKwhRow.push(`${Math.round(e1PerKwh.rawValue)}¢`);
        qualityRow.push(e1PerKwh.dataQuality || ".");
      } else {
        e1PerKwhRow.push("-");
        qualityRow.push(".");
      }

      // Get grid.renewables value
      const renewables = pointMap.get("grid.renewables");
      if (renewables && renewables.rawValue !== null) {
        renewablesRow.push(`${Math.round(renewables.rawValue)}%`);
      } else {
        renewablesRow.push("-");
      }
    }

    // Format rows with proper spacing (6 chars per column, right-aligned)
    return [
      timeRow.map((s) => s.padStart(6)).join(""),
      e1PerKwhRow.map((s) => s.padStart(6)).join(""),
      renewablesRow.map((s) => s.padStart(6)).join(""),
      qualityRow.map((s) => s.padStart(6)).join(""),
    ];
  }

  /**
   * Get up to 2 sample records for each point type (sorted by key and timestamp)
   * Returns simplified records: {pointKey: {records, numSkipped}, ...}
   */
  getSampleRecords(): Record<
    string,
    { records: SimplifiedSampleRecord[]; numSkipped?: number }
  > {
    const samples: Record<
      string,
      { records: SimplifiedSampleRecord[]; numSkipped?: number }
    > = {};

    // First, collect all point keys from all timestamps
    const allPointKeys = new Set<string>();
    for (const pointMap of this.records.values()) {
      for (const pointKey of pointMap.keys()) {
        allPointKeys.add(pointKey);
      }
    }

    // Sort point keys alphabetically
    const sortedPointKeys = Array.from(allPointKeys).sort();

    for (const pointKey of sortedPointKeys) {
      // Collect all records for this point across all timestamps
      const allRecordsForPoint: Array<[string, PointReading]> = [];
      for (const [timeKey, pointMap] of this.records.entries()) {
        const reading = pointMap.get(pointKey);
        if (
          reading &&
          reading.rawValue !== null &&
          reading.rawValue !== undefined
        ) {
          allRecordsForPoint.push([timeKey, reading]);
        }
      }

      // Sort by timestamp
      allRecordsForPoint.sort((a, b) => Number(a[0]) - Number(b[0]));

      if (allRecordsForPoint.length > 0) {
        // Take first 2 and simplify
        const records: SimplifiedSampleRecord[] = [];
        for (let i = 0; i < Math.min(2, allRecordsForPoint.length); i++) {
          const reading = allRecordsForPoint[i][1];
          records.push({
            rawValue: reading.rawValue,
            measurementTimeMs: reading.measurementTimeMs,
            receivedTimeMs: reading.receivedTimeMs,
            quality: reading.dataQuality,
          });
        }

        const sampleInfo: {
          records: SimplifiedSampleRecord[];
          numSkipped?: number;
        } = { records };

        // Add numSkipped if there are more than 2 records
        if (allRecordsForPoint.length > 2) {
          sampleInfo.numSkipped = allRecordsForPoint.length - 2;
        }

        samples[pointKey] = sampleInfo;
      }
    }

    return samples;
  }

  /**
   * Get all views in one call - convenience method for stages
   */
  getInfo(): {
    overviews: Record<string, string>;
    characterisation: CharacterisationRange[] | undefined;
    numRecords: number;
    uniformQuality?: string | null;
    canonical: string[];
    sampleRecords: Record<
      string,
      { records: SimplifiedSampleRecord[]; numSkipped?: number }
    >;
  } {
    // Build overviews for all points
    const overviews: Record<string, string> = {};
    for (const pointKey of this.getKeys()) {
      overviews[pointKey] = this.getOverview(pointKey);
    }

    // Determine uniform quality if present
    const uniformQuality = this.getUniformQuality();

    return {
      overviews,
      characterisation: this.getCharacterisation(),
      numRecords: this.getCount(),
      uniformQuality,
      canonical: this.getCanonicalDisplay(),
      sampleRecords: this.getSampleRecords(),
    };
  }
}
