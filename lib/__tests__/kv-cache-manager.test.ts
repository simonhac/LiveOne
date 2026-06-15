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
    keys: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
  },
  kvKey: jest.fn((pattern: string) => `test:${pattern}`),
}));

// Mock the database (Postgres). getAllCompositeBindings uses select→from→innerJoin→where→orderBy.
const mockDb = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      innerJoin: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => Promise.resolve([])),
        })),
      })),
      where: jest.fn(() => ({
        orderBy: jest.fn(() => Promise.resolve([])),
      })),
    })),
  })),
};
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => mockDb,
  get planetscaleDb() {
    return mockDb;
  },
}));

// Mock the schema
jest.mock("@/lib/db/planetscale/schema", () => ({
  systems: { vendorType: "vendorType" },
  pointInfo: { systemId: "systemId", index: "index" },
  areas: { id: "id", kind: "kind", legacySystemId: "legacySystemId" },
  areaBindings: {
    areaId: "areaId",
    pointSystemId: "pointSystemId",
    pointId: "pointId",
    ordinal: "ordinal",
  },
}));

// Mock drizzle-orm
jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
  and: jest.fn(),
  sql: jest.fn(() => "mock_sql"),
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
        1, // point ID
        "source.solar.local/power",
        5234.5,
        1731627600000, // measurementTimeMs
        1731627605000, // receivedTimeMs
        "W",
        "Test Point",
      );

      // Should update the source system's cache
      expect(kv.hset).toHaveBeenCalledWith(
        "test:latest:system:10",
        expect.objectContaining({
          "source.solar.local/power": expect.objectContaining({
            value: 5234.5,
            measurementTimeMs: 1731627600000,
            receivedTimeMs: 1731627605000,
            metricUnit: "W",
            displayName: "Test Point",
          }),
        }),
      );
    });

    it("should include receivedTimeMs in the cache entry", async () => {
      const { kv } = await import("../kv");
      const receivedTime = 1731627605000;

      await updateLatestPointValue(
        10,
        1, // point ID
        "source.solar.local/power",
        5234.5,
        1731627600000, // measurementTimeMs
        receivedTime, // receivedTimeMs
        "W",
        "Test Point",
      );

      const call = (kv.hset as jest.MockedFunction<any>).mock.calls[0];
      const pointValue = call[1]["source.solar.local/power"];

      expect(pointValue.receivedTimeMs).toBe(receivedTime);
    });

    it("should update composite system caches when subscribers exist", async () => {
      const { kv } = await import("../kv");

      // Mock getPointSubscribers to return subscription registry with point-to-point mappings
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: {
          "1": ["100.0", "101.0"], // Point 1 subscribed by composite systems 100 and 101
        },
        lastUpdatedTimeMs: Date.now(),
      });

      await updateLatestPointValue(
        10,
        1, // point ID
        "source.solar.local/power",
        5234.5,
        1731627600000, // measurementTimeMs
        1731627605000, // receivedTimeMs
        "W",
        "Test Point",
      );

      // Should update source system + 2 composite systems = 3 total hset calls
      expect(kv.hset).toHaveBeenCalledTimes(3);

      // Check source system update
      expect(kv.hset).toHaveBeenCalledWith(
        "test:latest:system:10",
        expect.any(Object),
      );

      // Check composite system updates
      expect(kv.hset).toHaveBeenCalledWith(
        "test:latest:system:100",
        expect.any(Object),
      );
      expect(kv.hset).toHaveBeenCalledWith(
        "test:latest:system:101",
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
          displayName: "Test Point",
        },
        "load.hvac/power": {
          value: 1200,
          measurementTimeMs: 1731627600000,
          receivedTimeMs: 1731627605000,
          metricUnit: "W",
          displayName: "Test Point",
        },
      };

      (kv.hgetall as jest.MockedFunction<any>).mockResolvedValueOnce(
        mockValues,
      );

      const result = await getLatestPointValues(10);

      expect(kv.hgetall).toHaveBeenCalledWith("test:latest:system:10");
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
    // Mock getAllCompositeBindings's query: select→from→innerJoin→where→orderBy → binding rows.
    const mockBindings = (rows: unknown[]) => {
      (mockDb.select as jest.MockedFunction<any>).mockReturnValueOnce({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ orderBy: () => Promise.resolve(rows) }),
          }),
        }),
      });
    };

    it("builds the reverse source→composite map from area_bindings", async () => {
      const { kv } = await import("../kv");

      // composite 100: solar from sys6 (pts 17,7) + battery from sys5 (pts 7,10);
      // composite 101: solar from sys6 (17) + load from sys7 (3). → source systems 5, 6, 7.
      mockBindings([
        { compositeSystemId: 100, pointSystemId: 6, pointId: 17, ordinal: 0 },
        { compositeSystemId: 100, pointSystemId: 6, pointId: 7, ordinal: 1 },
        { compositeSystemId: 100, pointSystemId: 5, pointId: 7, ordinal: 2 },
        { compositeSystemId: 100, pointSystemId: 5, pointId: 10, ordinal: 3 },
        { compositeSystemId: 101, pointSystemId: 6, pointId: 17, ordinal: 0 },
        { compositeSystemId: 101, pointSystemId: 7, pointId: 3, ordinal: 1 },
      ]);

      await buildSubscriptionRegistry();

      for (const sys of [5, 6, 7]) {
        expect(kv.set).toHaveBeenCalledWith(
          `test:subscriptions:system:${sys}`,
          expect.objectContaining({
            pointSubscribers: expect.any(Object),
            lastUpdatedTimeMs: expect.any(Number),
          }),
        );
      }
    });

    it("writes no subscriptions when there are no composite bindings", async () => {
      const { kv } = await import("../kv");

      mockBindings([]); // no bindings (e.g. no composites)

      await buildSubscriptionRegistry();

      expect(kv.set).not.toHaveBeenCalled();
    });
  });
});
