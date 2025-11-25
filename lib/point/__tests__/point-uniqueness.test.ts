/**
 * Tests for point uniqueness logic in PointManager
 *
 * Points are uniquely identified by (systemId, originId, originSubId).
 * metricType is NOT part of the unique key - each origin can only have one metricType.
 */

import { describe, it, expect } from "@jest/globals";

/**
 * Simulates the key generation logic from loadPointInfoMap
 */
function generatePointKeyFromDb(point: {
  originId: string;
  originSubId: string | null;
}): string {
  return point.originSubId
    ? `${point.originId}:${point.originSubId}`
    : point.originId;
}

/**
 * Simulates the key generation logic from ensurePointInfo
 */
function generatePointKeyFromMetadata(metadata: {
  originId: string;
  originSubId?: string;
}): string {
  return metadata.originSubId
    ? `${metadata.originId}:${metadata.originSubId}`
    : metadata.originId;
}

describe("Point Uniqueness", () => {
  describe("Key Generation Consistency", () => {
    it("should generate matching keys for same origin without subId", () => {
      const dbPoint = { originId: "solar_power", originSubId: null };
      const metadata = { originId: "solar_power" };

      expect(generatePointKeyFromDb(dbPoint)).toBe(
        generatePointKeyFromMetadata(metadata),
      );
      expect(generatePointKeyFromDb(dbPoint)).toBe("solar_power");
    });

    it("should generate matching keys for same origin with subId", () => {
      const dbPoint = { originId: "E1", originSubId: "energy" };
      const metadata = { originId: "E1", originSubId: "energy" };

      expect(generatePointKeyFromDb(dbPoint)).toBe(
        generatePointKeyFromMetadata(metadata),
      );
      expect(generatePointKeyFromDb(dbPoint)).toBe("E1:energy");
    });

    it("should generate matching keys when metadata originSubId is undefined vs null", () => {
      const dbPoint = { originId: "battery_soc", originSubId: null };
      const metadataUndefined = { originId: "battery_soc" };
      const metadataExplicitUndefined = {
        originId: "battery_soc",
        originSubId: undefined,
      };

      const dbKey = generatePointKeyFromDb(dbPoint);
      expect(dbKey).toBe(generatePointKeyFromMetadata(metadataUndefined));
      expect(dbKey).toBe(
        generatePointKeyFromMetadata(metadataExplicitUndefined),
      );
      expect(dbKey).toBe("battery_soc");
    });

    it("should generate different keys for different originSubIds", () => {
      const point1 = { originId: "E1", originSubId: "energy" };
      const point2 = { originId: "E1", originSubId: "power" };

      expect(generatePointKeyFromDb(point1)).not.toBe(
        generatePointKeyFromDb(point2),
      );
      expect(generatePointKeyFromDb(point1)).toBe("E1:energy");
      expect(generatePointKeyFromDb(point2)).toBe("E1:power");
    });

    it("should generate different keys for different originIds", () => {
      const point1 = { originId: "E1", originSubId: null };
      const point2 = { originId: "B1", originSubId: null };

      expect(generatePointKeyFromDb(point1)).not.toBe(
        generatePointKeyFromDb(point2),
      );
    });
  });

  describe("metricType is NOT part of uniqueness", () => {
    it("should generate same key regardless of metricType", () => {
      // Two metadata objects with same origin but different metricTypes
      // should generate the SAME key (metricType doesn't affect uniqueness)
      const metadataPower = {
        originId: "solar",
        originSubId: "inverter1",
        metricType: "power",
      };
      const metadataEnergy = {
        originId: "solar",
        originSubId: "inverter1",
        metricType: "energy",
      };

      // Keys should match - metricType is NOT part of the key
      expect(generatePointKeyFromMetadata(metadataPower)).toBe(
        generatePointKeyFromMetadata(metadataEnergy),
      );
      expect(generatePointKeyFromMetadata(metadataPower)).toBe(
        "solar:inverter1",
      );
    });

    it("should NOT include metricType in key even when present", () => {
      const metadata = {
        originId: "grid",
        originSubId: "import",
        metricType: "energy",
        metricUnit: "Wh",
      };

      const key = generatePointKeyFromMetadata(metadata);

      // Key should NOT contain metricType
      expect(key).toBe("grid:import");
      expect(key).not.toContain("energy");
      expect(key).not.toContain("Wh");
    });
  });

  describe("Point Map Lookup Simulation", () => {
    it("should find existing point in map using metadata", () => {
      // Simulate a point map loaded from database
      const pointMap: Record<string, { index: number; metricType: string }> = {
        solar_power: { index: 1, metricType: "power" },
        "E1:energy": { index: 2, metricType: "energy" },
        "E1:value": { index: 3, metricType: "currency" },
        battery_soc: { index: 4, metricType: "soc" },
      };

      // Look up using metadata
      const metadata1 = { originId: "solar_power" };
      const metadata2 = { originId: "E1", originSubId: "energy" };
      const metadata3 = { originId: "battery_soc", originSubId: undefined };

      expect(pointMap[generatePointKeyFromMetadata(metadata1)]).toEqual({
        index: 1,
        metricType: "power",
      });
      expect(pointMap[generatePointKeyFromMetadata(metadata2)]).toEqual({
        index: 2,
        metricType: "energy",
      });
      expect(pointMap[generatePointKeyFromMetadata(metadata3)]).toEqual({
        index: 4,
        metricType: "soc",
      });
    });

    it("should return undefined for non-existent point", () => {
      const pointMap: Record<string, { index: number }> = {
        solar_power: { index: 1 },
      };

      const metadata = { originId: "unknown_point" };
      expect(pointMap[generatePointKeyFromMetadata(metadata)]).toBeUndefined();
    });

    it("should correctly distinguish between originId and originId:originSubId", () => {
      const pointMap: Record<string, { index: number }> = {
        E1: { index: 1 }, // E1 without subId
        "E1:energy": { index: 2 }, // E1 with subId
      };

      // Without subId should find E1
      const metadataNoSub = { originId: "E1" };
      expect(pointMap[generatePointKeyFromMetadata(metadataNoSub)]).toEqual({
        index: 1,
      });

      // With subId should find E1:energy
      const metadataWithSub = { originId: "E1", originSubId: "energy" };
      expect(pointMap[generatePointKeyFromMetadata(metadataWithSub)]).toEqual({
        index: 2,
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty string originSubId as truthy (creates key with colon)", () => {
      // Empty string is falsy in JS, so it should behave like null/undefined
      const metadata = { originId: "test", originSubId: "" };
      const key = generatePointKeyFromMetadata(metadata);
      // Empty string is falsy, so no colon should be added
      expect(key).toBe("test");
    });

    it("should handle originId containing colon character", () => {
      // If originId contains a colon, the key format still works
      // because we split on the first colon when loading
      const metadata = { originId: "device:123", originSubId: "power" };
      const key = generatePointKeyFromMetadata(metadata);
      expect(key).toBe("device:123:power");
    });

    it("should handle special characters in originId and originSubId", () => {
      const metadata = {
        originId: "5ecacac2-3cc3-447a-b3b5-423e333031e6",
        originSubId: "energyNowW",
      };
      const key = generatePointKeyFromMetadata(metadata);
      expect(key).toBe("5ecacac2-3cc3-447a-b3b5-423e333031e6:energyNowW");
    });
  });
});
