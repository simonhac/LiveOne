/**
 * Tests for AmberReadingsBatch class
 */

import { describe, it, expect } from "@jest/globals";
import { CalendarDate } from "@internationalized/date";
import { AmberReadingsBatch } from "../amber-readings-batch";
import type { Milliseconds } from "../types";

describe("AmberReadingsBatch", () => {
  describe("characterisation with partial point coverage", () => {
    it("should NOT merge ranges with same quality but different point sets", () => {
      // This test reproduces the actual bug from production logs
      // The overviews showed:
      // E1.perKwh:     "aaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" (13 a's, then b's)
      // grid.renewables: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" (all a's)
      // B1.perKwh:     "aaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" (13 a's, then b's)
      // grid.spotPerKwh: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" (all a's)
      //
      // But characterisation incorrectly showed only 1 range with all 4 points,
      // when it should show at least 2 ranges:
      // - Range 1: Intervals 0-12 with all 4 points having 'a' quality
      // - Range 2: Intervals 13-47 with only grid.renewables and grid.spotPerKwh having 'a', others having 'b'

      const day = new CalendarDate(2025, 11, 19);
      const group = new AmberReadingsBatch(day, 1);
      const dayStartMs = 1763474400000;

      // Add all 4 points for first 13 intervals with 'Actual' quality
      const allPoints = [
        "E1.perKwh",
        "B1.perKwh",
        "grid.renewables",
        "grid.spotPerKwh",
      ];
      for (let i = 0; i < 13; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;
        for (const pointKey of allPoints) {
          group.add({
            measurementTimeMs,
            rawValue: 0.25 + i * 0.01,
            dataQuality: "Actual",
            pointMetadata: {
              physicalPathTail: `amber/${pointKey.replace(".", "/")}`,
              logicalPathStem: `bidi.${pointKey.split(".")[0]}`,
              defaultName: "Price data",
              subsystem: "grid",
              metricType: "rate",
              metricUnit: "cents_kWh",
              transform: null,
            },
            receivedTimeMs: Date.now() as Milliseconds,
            sessionId: 0,
          });
        }
      }

      // For intervals 13-47: Only grid points have 'Actual', price points have 'Billable'
      for (let i = 13; i < 48; i++) {
        const measurementTimeMs = (dayStartMs +
          (i + 1) * 30 * 60 * 1000) as Milliseconds;

        // grid.renewables and grid.spotPerKwh continue with 'Actual'
        for (const pointKey of ["grid.renewables", "grid.spotPerKwh"]) {
          group.add({
            measurementTimeMs,
            rawValue: 0.25 + i * 0.01,
            dataQuality: "Actual",
            pointMetadata: {
              physicalPathTail: `amber/${pointKey.replace(".", "/")}`,
              logicalPathStem: `bidi.${pointKey.split(".")[0]}`,
              defaultName: "Grid data",
              subsystem: "grid",
              metricType: "rate",
              metricUnit: "cents_kWh",
              transform: null,
            },
            receivedTimeMs: Date.now() as Milliseconds,
            sessionId: 0,
          });
        }

        // E1.perKwh and B1.perKwh switch to 'Billable'
        for (const pointKey of ["E1.perKwh", "B1.perKwh"]) {
          group.add({
            measurementTimeMs,
            rawValue: 0.25 + i * 0.01,
            dataQuality: "Billable",
            pointMetadata: {
              physicalPathTail: `amber/${pointKey.replace(".", "/")}`,
              logicalPathStem: `bidi.${pointKey.split(".")[0]}`,
              defaultName: "Price data",
              subsystem: "grid",
              metricType: "rate",
              metricUnit: "cents_kWh",
              transform: null,
            },
            receivedTimeMs: Date.now() as Milliseconds,
            sessionId: 0,
          });
        }
      }

      // Verify overviews match the pattern from production logs
      expect(group.getOverview("E1.perKwh")).toBe(
        "a".repeat(13) + "b".repeat(35),
      );
      expect(group.getOverview("B1.perKwh")).toBe(
        "a".repeat(13) + "b".repeat(35),
      );
      expect(group.getOverview("grid.renewables")).toBe("a".repeat(48));
      expect(group.getOverview("grid.spotPerKwh")).toBe("a".repeat(48));

      // Get characterisation
      const characterisation = group.getCharacterisation();

      expect(characterisation).toBeDefined();

      // Expected 3 ranges:
      // 1. Intervals 0-12: All 4 points with 'a' quality
      // 2. Intervals 13-47: E1.perKwh + B1.perKwh with 'b' quality
      // 3. Intervals 13-47: grid.renewables + grid.spotPerKwh with 'a' quality
      expect(characterisation!.length).toBe(3);

      // Find ranges by their characteristics (order may vary)
      const allFourPointsRange = characterisation!.find(
        (r) =>
          r.pointOriginIds.length === 4 &&
          r.quality === "a" &&
          r.numPeriods === 13,
      );
      const pricePointsRange = characterisation!.find(
        (r) =>
          r.pointOriginIds.length === 2 &&
          r.pointOriginIds.includes("B1.perKwh") &&
          r.pointOriginIds.includes("E1.perKwh") &&
          r.quality === "b",
      );
      const gridPointsRange = characterisation!.find(
        (r) =>
          r.pointOriginIds.length === 2 &&
          r.pointOriginIds.includes("grid.renewables") &&
          r.pointOriginIds.includes("grid.spotPerKwh") &&
          r.quality === "a",
      );

      // Range 1: All 4 points with 'a' quality (intervals 0-12)
      expect(allFourPointsRange).toBeDefined();
      expect(allFourPointsRange!.pointOriginIds.sort()).toEqual([
        "B1.perKwh",
        "E1.perKwh",
        "grid.renewables",
        "grid.spotPerKwh",
      ]);
      expect(allFourPointsRange!.quality).toBe("a");
      expect(allFourPointsRange!.numPeriods).toBe(13);

      // Range 2: E1 and B1 with 'b' quality (intervals 13-47)
      expect(pricePointsRange).toBeDefined();
      expect(pricePointsRange!.pointOriginIds.sort()).toEqual([
        "B1.perKwh",
        "E1.perKwh",
      ]);
      expect(pricePointsRange!.quality).toBe("b");
      expect(pricePointsRange!.numPeriods).toBe(35);

      // Range 3: grid points with 'a' quality (intervals 13-47)
      expect(gridPointsRange).toBeDefined();
      expect(gridPointsRange!.pointOriginIds.sort()).toEqual([
        "grid.renewables",
        "grid.spotPerKwh",
      ]);
      expect(gridPointsRange!.quality).toBe("a");
      expect(gridPointsRange!.numPeriods).toBe(35);
    });

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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
              physicalPathTail: `amber/${pointKey.replace(".", "/")}`,
              logicalPathStem: `bidi.${pointKey.split(".")[0]}`,
              defaultName: "Price data",
              subsystem: "grid",
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
              physicalPathTail: `amber/${pointKey.replace(".", "/")}`,
              logicalPathStem: `bidi.${pointKey.split(".")[0]}`,
              defaultName: "Price data",
              subsystem: "grid",
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

      // Should have exactly 3 ranges:
      // 1. 00:00-13:00: grid.spotPerKwh with actual quality (extends through all intervals where it has 'a')
      // 2. 06:30-13:00: B1.perKwh, E1.perKwh, grid.renewables with actual quality
      // 3. 13:00-00:00: All 4 points with forecast quality
      expect(characterisation!.length).toBe(3);

      // Find ranges by characteristics since order may vary
      const gridSpotRange = characterisation!.find(
        (r) =>
          r.pointOriginIds.length === 1 &&
          r.pointOriginIds[0] === "grid.spotPerKwh" &&
          r.quality === "a",
      );
      const threePricePointsRange = characterisation!.find(
        (r) =>
          r.pointOriginIds.length === 3 &&
          r.pointOriginIds.includes("B1.perKwh") &&
          r.pointOriginIds.includes("E1.perKwh") &&
          r.pointOriginIds.includes("grid.renewables") &&
          r.quality === "a",
      );
      const forecastRange = characterisation!.find(
        (r) => r.pointOriginIds.length === 4 && r.quality === "f",
      );

      // Verify all ranges found
      expect(gridSpotRange).toBeDefined();
      expect(threePricePointsRange).toBeDefined();
      expect(forecastRange).toBeDefined();

      // First range: grid.spotPerKwh alone for 26 periods (00:00-13:00)
      expect(gridSpotRange!.pointOriginIds).toEqual(["grid.spotPerKwh"]);
      expect(gridSpotRange!.numPeriods).toBe(26); // Extends from interval 0-25
      expect(gridSpotRange!.rangeStartTimeMs).toBe(dayStartMs);
      expect(gridSpotRange!.rangeEndTimeMs).toBe(
        dayStartMs + 26 * 30 * 60 * 1000,
      );

      // Second range: B1, E1, renewables for 13 periods (06:30-13:00)
      expect(threePricePointsRange!.numPeriods).toBe(13);
      expect(threePricePointsRange!.rangeStartTimeMs).toBe(
        dayStartMs + 13 * 30 * 60 * 1000,
      );
      expect(threePricePointsRange!.rangeEndTimeMs).toBe(
        dayStartMs + 26 * 30 * 60 * 1000,
      );

      // Third range: all 4 points with forecast for 22 periods (13:00-00:00)
      expect(forecastRange!.pointOriginIds).toEqual([
        "B1.perKwh",
        "E1.perKwh",
        "grid.renewables",
        "grid.spotPerKwh",
      ]);
      expect(forecastRange!.numPeriods).toBe(22);
      expect(forecastRange!.rangeStartTimeMs).toBe(
        dayStartMs + 26 * 30 * 60 * 1000,
      );
      expect(forecastRange!.rangeEndTimeMs).toBe(
        dayStartMs + 48 * 30 * 60 * 1000,
      );
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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

      // Verify uniform quality
      expect(group.getUniformQuality()).toBe("b");
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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
            physicalPathTail: "amber/grid/spotPerKwh",
            logicalPathStem: "bidi.grid",
            defaultName: "Grid spot price",
            subsystem: "grid",
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

      // Verify mixed quality (undefined = mixed)
      expect(group.getUniformQuality()).toBe(undefined);

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

  describe("getUniformQuality", () => {
    const dayStartMs = 1763474400000; // 2025-11-19 00:00:00 UTC

    const createReading = (
      intervalIdx: number,
      pointKey: string,
      quality: string,
    ) => ({
      measurementTimeMs: (dayStartMs +
        (intervalIdx + 1) * 30 * 60 * 1000) as Milliseconds,
      rawValue: 0.25,
      dataQuality: quality,
      pointMetadata: {
        physicalPathTail: `amber/${pointKey.replace(".", "/")}`,
        logicalPathStem: `bidi.${pointKey.split(".")[0]}`,
        defaultName: "Test point",
        subsystem: "grid",
        metricType: "rate" as const,
        metricUnit: "cents_kWh",
        transform: null,
      },
      receivedTimeMs: Date.now() as Milliseconds,
      sessionId: 0,
    });

    it("should return 'b' when all readings are billable", () => {
      const day = new CalendarDate(2025, 11, 19);
      const batch = new AmberReadingsBatch(day, 1);

      // Add billable readings for multiple points and intervals
      for (let i = 0; i < 10; i++) {
        batch.add(createReading(i, "E1.perKwh", "Billable"));
        batch.add(createReading(i, "B1.perKwh", "Billable"));
      }

      expect(batch.getUniformQuality()).toBe("b");
    });

    it("should return 'a' when all readings are actual", () => {
      const day = new CalendarDate(2025, 11, 19);
      const batch = new AmberReadingsBatch(day, 1);

      // Add actual readings
      for (let i = 0; i < 10; i++) {
        batch.add(createReading(i, "E1.perKwh", "Actual"));
        batch.add(createReading(i, "grid.spotPerKwh", "Actual"));
      }

      expect(batch.getUniformQuality()).toBe("a");
    });

    it("should return 'f' when all readings are forecast", () => {
      const day = new CalendarDate(2025, 11, 19);
      const batch = new AmberReadingsBatch(day, 1);

      // Add forecast readings
      for (let i = 0; i < 5; i++) {
        batch.add(createReading(i, "E1.perKwh", "Forecast"));
      }

      expect(batch.getUniformQuality()).toBe("f");
    });

    it("should return null when there's no data", () => {
      const day = new CalendarDate(2025, 11, 19);
      const batch = new AmberReadingsBatch(day, 1);

      // Empty batch - no data
      expect(batch.getUniformQuality()).toBe(null);
    });

    it("should return undefined when qualities are mixed (actual and billable)", () => {
      const day = new CalendarDate(2025, 11, 19);
      const batch = new AmberReadingsBatch(day, 1);

      // Add mix of actual and billable
      batch.add(createReading(0, "E1.perKwh", "Actual"));
      batch.add(createReading(1, "E1.perKwh", "Billable"));

      expect(batch.getUniformQuality()).toBe(undefined);
    });

    it("should return undefined when qualities are mixed (billable and forecast)", () => {
      const day = new CalendarDate(2025, 11, 19);
      const batch = new AmberReadingsBatch(day, 1);

      // Add mix of billable and forecast
      for (let i = 0; i < 5; i++) {
        batch.add(createReading(i, "E1.perKwh", "Billable"));
      }
      for (let i = 5; i < 10; i++) {
        batch.add(createReading(i, "E1.perKwh", "Forecast"));
      }

      expect(batch.getUniformQuality()).toBe(undefined);
    });

    it("should check uniformity across all points and intervals", () => {
      const day = new CalendarDate(2025, 11, 19);
      const batch = new AmberReadingsBatch(day, 1);

      // Add billable for multiple points across many intervals
      const points = [
        "E1.perKwh",
        "B1.perKwh",
        "grid.spotPerKwh",
        "grid.renewables",
      ];
      for (let i = 0; i < 20; i++) {
        for (const point of points) {
          batch.add(createReading(i, point, "Billable"));
        }
      }

      // All should be billable
      expect(batch.getUniformQuality()).toBe("b");

      // Add one actual reading - should break uniformity
      batch.add(createReading(20, "E1.perKwh", "Actual"));
      expect(batch.getUniformQuality()).toBe(undefined);
    });
  });
});
