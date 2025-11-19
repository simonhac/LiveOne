/**
 * Tests for AmberReadingsBatch class
 */

import { describe, it, expect } from "@jest/globals";
import { CalendarDate } from "@internationalized/date";
import { AmberReadingsBatch } from "../amber-readings-batch";
import type { Milliseconds } from "../types";

describe("AmberReadingsBatch", () => {
  describe("characterisation with partial point coverage", () => {
    it("should include intervals where only some points have data", () => {
      // Test day: 2025-11-19
      const day = new CalendarDate(2025, 11, 19);
      const group = new AmberReadingsBatch(day);

      // Add readings that simulate the actual bug scenario:
      // - grid.spotPerKwh has superior data for first 13 intervals (00:00-06:30)
      // - B1.perKwh, E1.perKwh, grid.renewables have data starting at interval 13 (06:30)
      // - All points have forecast data after that

      // First interval starts at 00:30 AEST (midnight + 30 minutes)
      // AEST is UTC+10, so 2025-11-19 00:00 AEST = 1763474400000ms
      const dayStartMs = 1763474400000;

      // Add grid.spotPerKwh readings for intervals 0-12 (00:30-06:30) with "actual" quality
      for (let i = 0; i < 13; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;
        group.add({
          measurementTimeMs,
          value: 0.25 + i * 0.01,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid.spotPerKwh",
            dataType: "PerKwh",
            description: "Grid spot price",
            dataCategory: "Price",
          },
        });
      }

      // Add all 4 points for intervals 13-25 (06:30-13:00) with "actual" quality
      const pointKeys = [
        "grid.spotPerKwh",
        "B1.perKwh",
        "E1.perKwh",
        "grid.renewables",
      ];
      for (let i = 13; i < 26; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;
        for (const pointKey of pointKeys) {
          group.add({
            measurementTimeMs,
            value: 0.25 + i * 0.01,
            dataQuality: "Actual",
            pointMetadata: {
              originId: pointKey,
              dataType: "PerKwh",
              description: "Price data",
              dataCategory: "Price",
            },
          });
        }
      }

      // Add all 4 points for remaining intervals (13:00-00:00) with "forecast" quality
      for (let i = 26; i < 48; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;
        for (const pointKey of pointKeys) {
          group.add({
            measurementTimeMs,
            value: 0.25 + i * 0.01,
            dataQuality: "Forecast",
            pointMetadata: {
              originId: pointKey,
              dataType: "PerKwh",
              description: "Price data",
              dataCategory: "Price",
            },
          });
        }
      }

      // Get characterisation
      const characterisation = group.getCharacterisation();

      // Should have characterisation ranges (mixed quality)
      expect(characterisation).toBeDefined();
      expect(characterisation).not.toBeNull();

      // Should have at least 3 ranges:
      // 1. 00:00-06:30: Only grid.spotPerKwh with actual quality
      // 2. 06:30-13:00: All points with actual quality
      // 3. 13:00-00:00: All points with forecast quality
      expect(characterisation!.length).toBeGreaterThanOrEqual(3);

      // First range should cover the period where only grid.spotPerKwh has data
      const firstRange = characterisation![0];
      expect(firstRange.quality).toBe("a"); // actual abbreviated
      expect(firstRange.pointOriginIds).toEqual(["grid.spotPerKwh"]);
      expect(firstRange.numPeriods).toBe(13); // 13 half-hour periods (00:00-06:30)

      // Check the time range (00:00 AEST to 06:30 AEST)
      expect(firstRange.rangeStartTimeMs).toBe(dayStartMs);
      expect(firstRange.rangeEndTimeMs).toBe(dayStartMs + 13 * 30 * 60 * 1000);
    });
  });

  describe("boundary validation", () => {
    it("should throw an exception when adding readings outside the day boundaries", () => {
      // Test day: 2025-11-19
      const day = new CalendarDate(2025, 11, 19);
      const group = new AmberReadingsBatch(day);

      // AEST is UTC+10, so 2025-11-19 00:00 AEST = 1763474400000ms
      const dayStartMs = 1763474400000;
      const dayEndMs = dayStartMs + 48 * 30 * 60 * 1000; // End of day (next day 00:00)

      // Try to add a reading BEFORE the day starts (e.g., 23:30 on previous day)
      const beforeDayMs = (dayStartMs - 30 * 60 * 1000) as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: beforeDayMs,
          value: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid.spotPerKwh",
            dataType: "PerKwh",
            description: "Grid spot price",
            dataCategory: "Price",
          },
        });
      }).toThrow(/outside day boundaries/);

      // Try to add a reading AFTER the day ends (e.g., 00:30 on next day)
      const afterDayMs = (dayEndMs + 30 * 60 * 1000) as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: afterDayMs,
          value: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid.spotPerKwh",
            dataType: "PerKwh",
            description: "Grid spot price",
            dataCategory: "Price",
          },
        });
      }).toThrow(/outside day boundaries/);

      // A reading exactly at the day end (last interval end time) should work
      const lastIntervalMs = dayEndMs as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: lastIntervalMs,
          value: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid.spotPerKwh",
            dataType: "PerKwh",
            description: "Grid spot price",
            dataCategory: "Price",
          },
        });
      }).not.toThrow();
    });
  });
});
