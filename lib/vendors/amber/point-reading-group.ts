/**
 * PointReadingGroup - Encapsulates a day's worth of point readings
 * organized by time interval and point key
 */

import type { CalendarDate } from "@internationalized/date";
import { toCalendarDateTime, toZoned } from "@internationalized/date";
import type {
  PointReading,
  Completeness,
  CharacterisationRange,
  Milliseconds,
} from "./types";

/**
 * Generates all 48 half-hour interval end times for a given day (AEST = UTC+10)
 * Note: Amber uses fixed UTC+10 (AEST), NOT Australia/Sydney timezone which observes DST
 */
function generateIntervalEndTimes(day: CalendarDate): Milliseconds[] {
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
 * Abbreviates quality string to single character for overview
 */
function abbreviateQuality(quality: string | null | undefined): string {
  if (!quality) return ".";
  const q = quality.toLowerCase();
  if (q.includes("billable")) return "b";
  if (q.includes("actual")) return "a";
  if (q.includes("estimated")) return "e";
  if (q.includes("forecast")) return "f";
  return "?";
}

export class PointReadingGroup {
  private records: Map<string, Map<string, PointReading>>;
  private day: CalendarDate;
  private intervalEndTimes: Milliseconds[];

  constructor(day: CalendarDate) {
    this.day = day;
    this.intervalEndTimes = generateIntervalEndTimes(day);
    this.records = new Map();

    // Prepopulate map with all time keys
    for (const intervalEndTimeMs of this.intervalEndTimes) {
      this.records.set(String(intervalEndTimeMs), new Map());
    }
  }

  /**
   * Add a point reading to the group
   * Throws exception if reading is outside the day's boundaries
   */
  add(reading: PointReading): void {
    // Validate reading is within day boundaries
    const dayStart = (this.intervalEndTimes[0] -
      30 * 60 * 1000) as Milliseconds;
    const dayEnd = this.intervalEndTimes[47];

    if (
      reading.measurementTimeMs < dayStart ||
      reading.measurementTimeMs > dayEnd
    ) {
      const pointKey = reading.pointMetadata.originSubId
        ? `${reading.pointMetadata.originId}.${reading.pointMetadata.originSubId}`
        : reading.pointMetadata.originId;

      throw new Error(
        `Cannot add reading for ${pointKey} with timestamp ${reading.measurementTimeMs} ` +
          `(${new Date(reading.measurementTimeMs).toISOString()}) - ` +
          `outside day boundaries [${dayStart}, ${dayEnd}] ` +
          `(${new Date(dayStart).toISOString()} to ${new Date(dayEnd).toISOString()})` +
          ` for day ${this.day.toString()}`,
      );
    }

    const timeKey = String(reading.measurementTimeMs);
    const pointKey = reading.pointMetadata.originSubId
      ? `${reading.pointMetadata.originId}.${reading.pointMetadata.originSubId}`
      : reading.pointMetadata.originId;

    if (!this.records.has(timeKey)) {
      // This shouldn't happen if we prepopulated correctly, but handle gracefully
      this.records.set(timeKey, new Map());
    }

    this.records.get(timeKey)!.set(pointKey, reading);
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
   * Generate overview string for a specific point (48 chars)
   */
  getOverview(pointKey: string): string {
    let overview = "";
    for (const intervalEndTimeMs of this.intervalEndTimes) {
      const reading = this.records
        .get(String(intervalEndTimeMs))
        ?.get(pointKey);
      overview += abbreviateQuality(reading?.dataQuality);
    }
    return overview;
  }

  /**
   * Generate overview strings for all points found in the data
   */
  getOverviews(): Map<string, string> {
    // Collect all unique point keys
    const pointKeys = new Set<string>();
    for (const pointMap of this.records.values()) {
      for (const pointKey of pointMap.keys()) {
        pointKeys.add(pointKey);
      }
    }

    // Build overview for each point
    const overviews = new Map<string, string>();
    for (const pointKey of pointKeys) {
      overviews.set(pointKey, this.getOverview(pointKey));
    }

    return overviews;
  }

  /**
   * Determine completeness state
   */
  getCompleteness(): Completeness {
    let hasBillable = false;
    let hasNonBillable = false;

    for (const pointMap of this.records.values()) {
      for (const reading of pointMap.values()) {
        const quality = reading.dataQuality?.toLowerCase() ?? "";
        if (quality.includes("billable")) {
          hasBillable = true;
        } else {
          hasNonBillable = true;
        }

        // Early exit if we've seen both
        if (hasBillable && hasNonBillable) {
          return "mixed";
        }
      }
    }

    if (!hasBillable && !hasNonBillable) return "none";
    if (hasBillable && !hasNonBillable) return "all-billable";
    return "mixed";
  }

  /**
   * Generate characterisation ranges (groups of consecutive intervals with same quality)
   */
  getCharacterisation(): CharacterisationRange[] | undefined {
    const completeness = this.getCompleteness();
    if (completeness !== "mixed") {
      return undefined; // Only characterize mixed completeness
    }

    // Collect all unique point keys
    const pointKeys = new Set<string>();
    for (const pointMap of this.records.values()) {
      for (const pointKey of pointMap.keys()) {
        pointKeys.add(pointKey);
      }
    }

    const ranges: CharacterisationRange[] = [];
    let currentRange: CharacterisationRange | null = null;

    for (let i = 0; i < this.intervalEndTimes.length; i++) {
      const intervalEndTimeMs = this.intervalEndTimes[i];
      const pointMap = this.records.get(String(intervalEndTimeMs))!;

      // Get qualities for all points at this interval
      const qualities = new Set<string | null>();
      const pointsAtInterval: string[] = [];

      for (const pointKey of pointKeys) {
        const reading = pointMap.get(pointKey);
        const quality = reading?.dataQuality ?? null;
        // Abbreviate quality for characterisation
        const abbreviated = quality ? abbreviateQuality(quality) : null;
        qualities.add(abbreviated);
        if (reading) {
          pointsAtInterval.push(pointKey);
        }
      }

      // Determine single quality for this interval (or null if mixed)
      const quality = qualities.size === 1 ? Array.from(qualities)[0] : null;

      // Start new range or extend current one
      if (!currentRange || currentRange.quality !== quality) {
        // Save previous range if exists
        if (currentRange) {
          ranges.push(currentRange);
        }

        // Start new range
        const rangeStartTimeMs: Milliseconds =
          i === 0
            ? ((this.intervalEndTimes[0] - 30 * 60 * 1000) as Milliseconds)
            : currentRange!.rangeEndTimeMs;

        currentRange = {
          rangeStartTimeMs,
          rangeEndTimeMs: intervalEndTimeMs,
          quality,
          pointOriginIds: [...pointsAtInterval].sort(),
        };
      } else {
        // Extend current range
        currentRange.rangeEndTimeMs = intervalEndTimeMs;
        // Merge point lists
        const mergedPoints = new Set([
          ...currentRange.pointOriginIds,
          ...pointsAtInterval,
        ]);
        currentRange.pointOriginIds = [...mergedPoints].sort();
      }
    }

    // Save final range
    if (currentRange) {
      ranges.push(currentRange);
    }

    return ranges;
  }

  /**
   * Get all views in one call - convenience method for stages
   */
  getInfo(): {
    overviews: Map<string, string>;
    completeness: Completeness;
    characterisation: CharacterisationRange[] | undefined;
    numRecords: number;
  } {
    return {
      overviews: this.getOverviews(),
      completeness: this.getCompleteness(),
      characterisation: this.getCharacterisation(),
      numRecords: this.getCount(),
    };
  }
}
