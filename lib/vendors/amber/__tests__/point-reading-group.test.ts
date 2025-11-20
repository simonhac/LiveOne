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
      const group = new AmberReadingsBatch(day, 1);

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
          rawValue: 0.25 + i * 0.01,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
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
            rawValue: 0.25 + i * 0.01,
            dataQuality: "Actual",
            pointMetadata: {
              originId: pointKey.split(".")[0],
              originSubId: pointKey.split(".")[1],
              defaultName: "Price data",
              subsystem: "grid",
              type: "bidi",
              subtype: "grid",
              extension: "price",
              metricType: "rate",
              metricUnit: "cents_kWh",
              transform: null,
            },
            receivedTimeMs: Date.now() as Milliseconds,
            sessionId: 0,
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
            rawValue: 0.25 + i * 0.01,
            dataQuality: "Forecast",
            pointMetadata: {
              originId: pointKey.split(".")[0],
              originSubId: pointKey.split(".")[1],
              defaultName: "Price data",
              subsystem: "grid",
              type: "bidi",
              subtype: "grid",
              extension: "price",
              metricType: "rate",
              metricUnit: "cents_kWh",
              transform: null,
            },
            receivedTimeMs: Date.now() as Milliseconds,
            sessionId: 0,
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
      const group = new AmberReadingsBatch(day, 1);

      // AEST is UTC+10, so 2025-11-19 00:00 AEST = 1763474400000ms
      const dayStartMs = 1763474400000;
      const dayEndMs = dayStartMs + 48 * 30 * 60 * 1000; // End of day (next day 00:00)

      // Try to add a reading BEFORE the day starts (e.g., 23:30 on previous day)
      const beforeDayMs = (dayStartMs - 30 * 60 * 1000) as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: beforeDayMs,
          rawValue: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }).toThrow(/outside range boundaries/);

      // Try to add a reading AFTER the day ends (e.g., 00:30 on next day)
      const afterDayMs = (dayEndMs + 30 * 60 * 1000) as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: afterDayMs,
          rawValue: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }).toThrow(/outside range boundaries/);

      // A reading exactly at the day end (last interval end time) should work
      const lastIntervalMs = dayEndMs as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: lastIntervalMs,
          rawValue: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }).not.toThrow();
    });
  });

  describe("multi-day support", () => {
    it("should support 3-day ranges with 144 intervals", () => {
      // Test 3 days starting 2025-11-19
      const firstDay = new CalendarDate(2025, 11, 19);
      const numberOfDays = 3;
      const group = new AmberReadingsBatch(firstDay, numberOfDays);

      // AEST is UTC+10, so 2025-11-19 00:00 AEST = 1763474400000ms
      const dayStartMs = 1763474400000;

      // Add readings for all 144 intervals (48 × 3)
      for (let i = 0; i < 144; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;
        group.add({
          measurementTimeMs,
          rawValue: 0.25 + i * 0.01,
          dataQuality: "Billable",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }

      // Verify overview length is 144 chars
      const overview = group.getOverview("grid.spotPerKwh");
      expect(overview.length).toBe(144);
      expect(overview).toBe("b".repeat(144)); // All billable quality

      // Verify count
      expect(group.getCount()).toBe(144);

      // Verify completeness
      expect(group.getCompleteness()).toBe("all-billable");
    });

    it("should correctly validate boundaries for multi-day ranges", () => {
      const firstDay = new CalendarDate(2025, 11, 19);
      const numberOfDays = 3;
      const group = new AmberReadingsBatch(firstDay, numberOfDays);

      const dayStartMs = 1763474400000;
      const rangeEndMs = dayStartMs + 144 * 30 * 60 * 1000; // 3 days worth

      // Reading before range should fail
      const beforeRangeMs = (dayStartMs - 30 * 60 * 1000) as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: beforeRangeMs,
          rawValue: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }).toThrow(/outside range boundaries/);

      // Reading after range should fail
      const afterRangeMs = (rangeEndMs + 30 * 60 * 1000) as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: afterRangeMs,
          rawValue: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }).toThrow(/outside range boundaries/);

      // Reading exactly at range end should work
      const lastIntervalMs = rangeEndMs as Milliseconds;
      expect(() => {
        group.add({
          measurementTimeMs: lastIntervalMs,
          rawValue: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }).not.toThrow();
    });

    it("should generate correct characterisation for multi-day mixed quality", () => {
      const firstDay = new CalendarDate(2025, 11, 19);
      const numberOfDays = 2;
      const group = new AmberReadingsBatch(firstDay, numberOfDays);

      const dayStartMs = 1763474400000;

      // Day 1: All actual quality
      for (let i = 0; i < 48; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;
        group.add({
          measurementTimeMs,
          rawValue: 0.25,
          dataQuality: "Actual",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }

      // Day 2: All forecast quality
      for (let i = 48; i < 96; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;
        group.add({
          measurementTimeMs,
          rawValue: 0.3,
          dataQuality: "Forecast",
          pointMetadata: {
            originId: "grid",
            originSubId: "spotPerKwh",
            defaultName: "Grid spot price",
            subsystem: "grid",
            type: "bidi",
            subtype: "grid",
            extension: "spot",
            metricType: "rate",
            metricUnit: "cents_kWh",
            transform: null,
          },
          receivedTimeMs: Date.now() as Milliseconds,
          sessionId: 0,
        });
      }

      // Verify overview shows both qualities
      const overview = group.getOverview("grid.spotPerKwh");
      expect(overview.length).toBe(96);
      expect(overview).toBe("a".repeat(48) + "f".repeat(48));

      // Verify mixed completeness
      expect(group.getCompleteness()).toBe("mixed");

      // Verify characterisation has 2 ranges
      const characterisation = group.getCharacterisation();
      expect(characterisation).toBeDefined();
      expect(characterisation!.length).toBe(2);

      // First range: actual (48 periods)
      expect(characterisation![0].quality).toBe("a");
      expect(characterisation![0].numPeriods).toBe(48);

      // Second range: forecast (48 periods)
      expect(characterisation![1].quality).toBe("f");
      expect(characterisation![1].numPeriods).toBe(48);
    });
  });
});
