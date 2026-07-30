import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  updateLatestPointValue,
  getLatestValues,
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

// Mock the database (Postgres). Two query shapes hit this:
//  - getAreaBindings: select→from→innerJoin→leftJoin→innerJoin×2→orderBy (areas + legacy_handles +
//    points + devices)
//  - getBindinglessAreaMemberPoints: select→from→innerJoin×4→where→orderBy (slice H added the
//    `devices` hop that bridges area_members.device_id back to the owning device's rid)
// config-v4 Phase 13 PR 5 added the `legacy_handles` hop to both — that is where the area's integer
// handle now comes from, instead of the dropped `areas.legacy_system_id`.
// A recursive chain node (innerJoin/leftJoin/where return itself; orderBy resolves) covers both → [].
const chainNode = (): any => {
  const node: any = {
    innerJoin: jest.fn(() => node),
    leftJoin: jest.fn(() => node),
    where: jest.fn(() => node),
    orderBy: jest.fn(() => Promise.resolve([])),
  };
  return node;
};
const mockDb = {
  select: jest.fn(() => ({ from: jest.fn(() => chainNode()) })),
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
  pointInfo: {
    systemId: "systemId",
    index: "index",
    pointUid: "pointUid",
  },
  areas: { id: "id" },
  // config-v4 Phase 13 PR 5: the area's integer handle lives here now, not on `areas`.
  legacyHandles: { handle: "handle", areaId: "areaId", deviceId: "deviceId" },
  areaBindings: {
    areaId: "areaId",
    pointUid: "pointUid",
    ordinal: "ordinal",
  },
  areaMembers: { areaId: "areaId", deviceId: "deviceId", ordinal: "ordinal" },
  devices: { id: "id", rid: "rid" },
  points: { id: "id", deviceId: "deviceId" },
}));

// Mock drizzle-orm
jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
  and: jest.fn(),
  asc: jest.fn(),
  isNotNull: jest.fn(),
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
        "0199aaaa-0000-7000-8000-00000000000a", // point uid (subscription key)
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
        "0199aaaa-0000-7000-8000-00000000000a", // point uid (subscription key)
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
          // keyed by the SOURCE POINT UUID since slice E PR 2b (was the integer index)
          "0199aaaa-0000-7000-8000-00000000000a": ["100.0", "101.0"],
        },
        lastUpdatedTimeMs: Date.now(),
      });

      await updateLatestPointValue(
        10,
        "0199aaaa-0000-7000-8000-00000000000a", // point uid (subscription key)
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

  describe("getLatestValues", () => {
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

      const result = await getLatestValues(10);

      expect(kv.hgetall).toHaveBeenCalledWith("test:latest:system:10");
      expect(result).toEqual(mockValues);
    });

    it("should return empty object when no values exist", async () => {
      const { kv } = await import("../kv");

      (kv.hgetall as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      const result = await getLatestValues(10);

      expect(result).toEqual({});
    });
  });

  describe("buildSubscriptionRegistry", () => {
    // Mock getAreaBindings's query: select→from→innerJoin→leftJoin→innerJoin×2→orderBy → binding rows.
    const mockBindings = (rows: unknown[]) => {
      (mockDb.select as jest.MockedFunction<any>).mockReturnValueOnce({
        from: () => ({
          // getAreaBindings joins `areas`, LEFT-joins `legacy_handles` for the integer handle (PR 5:
          // the handle is no longer a column on `areas`), then `points` → `devices` (the latter pair
          // supplies sourceSystemId now that area_bindings has no point_system_id column).
          innerJoin: () => ({
            leftJoin: () => ({
              innerJoin: () => ({
                innerJoin: () => ({ orderBy: () => Promise.resolve(rows) }),
              }),
            }),
          }),
        }),
      });
    };

    it("builds the reverse source→composite map from area_bindings", async () => {
      const { kv } = await import("../kv");

      // handle 100: solar from sys6 (2 pts) + battery from sys5 (2 pts);
      // handle 101: solar from sys6 (1) + load from sys7 (1). → source systems 5, 6, 7.
      // Rows are keyed by point uuid; sourceSystemId comes from the point_info join.
      mockBindings([
        { handle: 100, sourceSystemId: 6, pointUid: "uid-6-17", ordinal: 0 },
        { handle: 100, sourceSystemId: 6, pointUid: "uid-6-7", ordinal: 1 },
        { handle: 100, sourceSystemId: 5, pointUid: "uid-5-7", ordinal: 2 },
        { handle: 100, sourceSystemId: 5, pointUid: "uid-5-10", ordinal: 3 },
        { handle: 101, sourceSystemId: 6, pointUid: "uid-6-17", ordinal: 0 },
        { handle: 101, sourceSystemId: 7, pointUid: "uid-7-3", ordinal: 1 },
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
