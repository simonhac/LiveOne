/**
 * AmberReadingsBatch - Encapsulates a day's worth of point readings
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
export function abbreviateQuality(quality: string | null | undefined): string {
  if (!quality) return ".";
  return quality.charAt(0).toLowerCase();
}

export class AmberReadingsBatch {
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
   * Generate overview string for a specific point (48 chars)
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
   * Quality is already normalized to single lowercase letter
   */
  getCompleteness(): Completeness {
    let hasBillable = false;
    let hasNonBillable = false;

    for (const pointMap of this.records.values()) {
      for (const reading of pointMap.values()) {
        const quality = reading.dataQuality ?? "";
        if (quality === "b") {
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
      // Quality is already normalized to single lowercase letter
      const qualities = new Set<string | null>();
      const pointsAtInterval: string[] = [];

      for (const pointKey of pointKeys) {
        const reading = pointMap.get(pointKey);
        if (reading) {
          qualities.add(reading.dataQuality ?? null);
          pointsAtInterval.push(pointKey);
        }
      }

      // Determine single quality for this interval (or null if mixed)
      const quality = qualities.size === 1 ? Array.from(qualities)[0] : null;

      // Check if point set changed
      const sortedPoints = [...pointsAtInterval].sort();
      let pointSetChanged = false;
      if (currentRange) {
        pointSetChanged =
          sortedPoints.length !== currentRange.pointOriginIds.length ||
          sortedPoints.some((p, i) => p !== currentRange!.pointOriginIds[i]);
      }

      // Start new range or extend current one
      if (
        !currentRange ||
        currentRange.quality !== quality ||
        pointSetChanged
      ) {
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
          numPeriods: 1, // Will be incremented as range extends
        };
      } else {
        // Extend current range
        currentRange.rangeEndTimeMs = intervalEndTimeMs;
        currentRange.numPeriods++;
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

    // Filter out ranges where quality is null (missing data only)
    return ranges.filter((range) => range.quality !== null);
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

      // Format time as HH:MM AEST
      const timeAEST = new Date(intervalEndTimeMs + 10 * 60 * 60 * 1000);
      const timeStr = `${String(timeAEST.getUTCHours()).padStart(2, "0")}:${String(timeAEST.getUTCMinutes()).padStart(2, "0")}`;
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
   * Get all views in one call - convenience method for stages
   */
  getInfo(): {
    overviews: Map<string, string>;
    completeness: Completeness;
    characterisation: CharacterisationRange[] | undefined;
    numRecords: number;
    canonical: string[];
  } {
    return {
      overviews: this.getOverviews(),
      completeness: this.getCompleteness(),
      characterisation: this.getCharacterisation(),
      numRecords: this.getCount(),
      canonical: this.getCanonicalDisplay(),
    };
  }
}
