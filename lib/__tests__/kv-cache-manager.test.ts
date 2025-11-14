import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  updateLatestPointValue,
  getLatestPointValues,
  buildSubscriptionRegistry,
} from "../kv-cache-manager";

// Mock the KV client
jest.mock("../kv", () => ({
  kv: {
    hset: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    hgetall: jest
      .fn<() => Promise<Record<string, any>>>()
      .mockResolvedValue({}),
    get: jest.fn<() => Promise<any>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<string>>().mockResolvedValue("OK"),
    del: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  },
}));

// Mock the database
jest.mock("../db", () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve([])),
      })),
    })),
  },
}));

// Mock the schema
jest.mock("../db/schema", () => ({
  systems: {
    vendorType: "vendorType",
  },
}));

// Mock drizzle-orm
jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
}));

// Mock identifiers
jest.mock("../identifiers", () => ({
  PointReference: {
    parse: jest.fn((str: string) => {
      const [systemId, pointId] = str.split(".");
      return systemId && pointId
        ? { systemId: parseInt(systemId), pointId: parseInt(pointId) }
        : null;
    }),
  },
}));

describe("kv-cache-manager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("updateLatestPointValue", () => {
    it("should update a point value in KV cache", async () => {
      const { kv } = await import("../kv");

      await updateLatestPointValue(
        10,
        "source.solar.local/power",
        5234.5,
        1731627600000,
        "W",
      );

      // Should update the source system's cache
      expect(kv.hset).toHaveBeenCalledWith(
        "latest:system:10",
        expect.objectContaining({
          "source.solar.local/power": expect.objectContaining({
            value: 5234.5,
            measurementTimeMs: 1731627600000,
            metricUnit: "W",
          }),
        }),
      );
    });

    it("should include receivedTimeMs in the cache entry", async () => {
      const { kv } = await import("../kv");
      const beforeTime = Date.now();

      await updateLatestPointValue(
        10,
        "source.solar.local/power",
        5234.5,
        1731627600000,
        "W",
      );

      const afterTime = Date.now();

      const call = (kv.hset as jest.MockedFunction<any>).mock.calls[0];
      const pointValue = call[1]["source.solar.local/power"];

      expect(pointValue.receivedTimeMs).toBeGreaterThanOrEqual(beforeTime);
      expect(pointValue.receivedTimeMs).toBeLessThanOrEqual(afterTime);
    });

    it("should update composite system caches when subscribers exist", async () => {
      const { kv } = await import("../kv");

      // Mock getSubscribers to return composite systems 100 and 101
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce([100, 101]);

      await updateLatestPointValue(
        10,
        "source.solar.local/power",
        5234.5,
        1731627600000,
        "W",
      );

      // Should update source system + 2 composite systems = 3 total hset calls
      expect(kv.hset).toHaveBeenCalledTimes(3);

      // Check source system update
      expect(kv.hset).toHaveBeenCalledWith(
        "latest:system:10",
        expect.any(Object),
      );

      // Check composite system updates
      expect(kv.hset).toHaveBeenCalledWith(
        "latest:system:100",
        expect.any(Object),
      );
      expect(kv.hset).toHaveBeenCalledWith(
        "latest:system:101",
        expect.any(Object),
      );
    });
  });

  describe("getLatestPointValues", () => {
    it("should retrieve latest values from KV cache", async () => {
      const { kv } = await import("../kv");

      const mockValues = {
        "source.solar.local/power": {
          value: 5234.5,
          measurementTimeMs: 1731627600000,
          receivedTimeMs: 1731627605000,
          metricUnit: "W",
        },
        "load.hvac/power": {
          value: 1200,
          measurementTimeMs: 1731627600000,
          receivedTimeMs: 1731627605000,
          metricUnit: "W",
        },
      };

      (kv.hgetall as jest.MockedFunction<any>).mockResolvedValueOnce(
        mockValues,
      );

      const result = await getLatestPointValues(10);

      expect(kv.hgetall).toHaveBeenCalledWith("latest:system:10");
      expect(result).toEqual(mockValues);
    });

    it("should return empty object when no values exist", async () => {
      const { kv } = await import("../kv");

      (kv.hgetall as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      const result = await getLatestPointValues(10);

      expect(result).toEqual({});
    });
  });

  describe("buildSubscriptionRegistry", () => {
    it("should build reverse mapping from source systems to composite systems", async () => {
      const { db } = await import("../db");
      const { kv } = await import("../kv");

      // Mock composite systems in database
      const mockCompositeSystems = [
        {
          id: 100,
          vendorType: "composite",
          metadata: {
            version: 2,
            mappings: {
              solar: ["6.17", "6.7"], // Points from system 6
              battery: ["5.7", "5.10"], // Points from system 5
            },
          },
        },
        {
          id: 101,
          vendorType: "composite",
          metadata: {
            version: 2,
            mappings: {
              solar: ["6.17"], // Also uses system 6
              load: ["7.3"], // Uses system 7
            },
          },
        },
      ];

      (db.select as jest.MockedFunction<any>).mockReturnValueOnce({
        from: jest.fn().mockReturnValueOnce({
          where: jest.fn().mockResolvedValueOnce(mockCompositeSystems as never),
        }),
      });

      await buildSubscriptionRegistry();

      // Should create subscription entries for systems 5, 6, and 7
      expect(kv.set).toHaveBeenCalledWith(
        "subscriptions:system:6",
        expect.arrayContaining([100, 101]), // Both composites use system 6
      );
      expect(kv.set).toHaveBeenCalledWith("subscriptions:system:5", [100]);
      expect(kv.set).toHaveBeenCalledWith("subscriptions:system:7", [101]);
    });

    it("should skip composite systems with invalid metadata", async () => {
      const { db } = await import("../db");
      const { kv } = await import("../kv");

      const mockCompositeSystems = [
        {
          id: 100,
          vendorType: "composite",
          metadata: null, // Invalid metadata
        },
        {
          id: 101,
          vendorType: "composite",
          metadata: {
            version: 1, // Old version
            base_system: 5,
          },
        },
        {
          id: 102,
          vendorType: "composite",
          metadata: {
            version: 2,
            mappings: {
              solar: ["6.17"],
            },
          },
        },
      ];

      (db.select as jest.MockedFunction<any>).mockReturnValueOnce({
        from: jest.fn().mockReturnValueOnce({
          where: jest.fn().mockResolvedValueOnce(mockCompositeSystems as never),
        }),
      });

      await buildSubscriptionRegistry();

      // Should only create subscription for system 102 (valid metadata)
      expect(kv.set).toHaveBeenCalledTimes(1);
      expect(kv.set).toHaveBeenCalledWith("subscriptions:system:6", [102]);
    });
  });
});
