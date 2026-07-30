import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Area, Device } from "@/lib/ids";
import {
  updateLatestPointValue,
  getLatestValues,
  buildSubscriptionRegistry,
} from "../kv-cache-manager";

// config-v4 Phase 13 PR 3: the KV keyspace is TypeID-native. Fixtures are real TypeIDs (minted once)
// plus the raw uuids the SQL rows carry, so the key strings asserted below are the real thing rather
// than a hand-written approximation.
const SOURCE_HANDLE = 10;
const SOURCE_DEVICE_UUID = "0199dddd-0000-7000-8000-00000000000a";
const SOURCE_DEVICE = Device.encode(SOURCE_DEVICE_UUID);
const SOURCE_AREA_UUID = "0199eeee-0000-7000-8000-00000000000a";
const SOURCE_AREA = Area.encode(SOURCE_AREA_UUID);
const AREA_A_UUID = "0199bbbb-0000-7000-8000-00000000000a";
const AREA_A = Area.encode(AREA_A_UUID);
const AREA_B_UUID = "0199cccc-0000-7000-8000-00000000000a";
const AREA_B = Area.encode(AREA_B_UUID);

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

// Mock the handle -> KV subject resolver (it reads `legacy_handles`). Handle 10 is given BOTH legs, the
// shape 18 of 22 dev handles really have (every device gets an area-of-one) — so the read below must
// visit both and the write must pick the device.
jest.mock("../kv-subjects", () => ({
  kvSourceSubjectForHandle: jest.fn(async (handle: number) =>
    handle === 10 ? { kind: "device", id: SOURCE_DEVICE } : null,
  ),
  kvDeviceSubjectForHandle: jest.fn(async (handle: number) =>
    handle === 10 ? { kind: "device", id: SOURCE_DEVICE } : null,
  ),
  kvSubjectsForHandle: jest.fn(async (handle: number) =>
    handle === 10
      ? [
          { kind: "area", id: SOURCE_AREA },
          { kind: "device", id: SOURCE_DEVICE },
        ]
      : [],
  ),
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

      // Should update the source DEVICE's cache
      expect(kv.hset).toHaveBeenCalledWith(
        `test:latest:device:${SOURCE_DEVICE}`,
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

    it("should update subscriber Area caches when subscribers exist", async () => {
      const { kv } = await import("../kv");

      // Mock getPointSubscribers to return subscription registry with point-to-Area mappings
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: {
          // keyed by the SOURCE POINT UUID since slice E PR 2b (was the integer index);
          // the VALUES are `ar_` TypeIDs since PR 3 (was `"{areaHandle}.{ordinal}"`)
          "0199aaaa-0000-7000-8000-00000000000a": [AREA_A, AREA_B],
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

      // Should update source device + 2 subscriber areas = 3 total hset calls
      expect(kv.hset).toHaveBeenCalledTimes(3);

      // Check source device update
      expect(kv.hset).toHaveBeenCalledWith(
        `test:latest:device:${SOURCE_DEVICE}`,
        expect.any(Object),
      );

      // Check subscriber Area updates
      expect(kv.hset).toHaveBeenCalledWith(
        `test:latest:area:${AREA_A}`,
        expect.any(Object),
      );
      expect(kv.hset).toHaveBeenCalledWith(
        `test:latest:area:${AREA_B}`,
        expect.any(Object),
      );
    });

    it("ignores a pre-PR-3 `{handle}.{ordinal}` subscriber ref rather than mis-routing it", async () => {
      const { kv } = await import("../kv");

      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: {
          "0199aaaa-0000-7000-8000-00000000000a": ["100.0", "101.0"],
        },
        lastUpdatedTimeMs: Date.now(),
      });

      await updateLatestPointValue(
        SOURCE_HANDLE,
        "0199aaaa-0000-7000-8000-00000000000a",
        "source.solar.local/power",
        5234.5,
        1731627600000,
        1731627605000,
        "W",
        "Test Point",
      );

      // Source device only — the stale refs contribute no subscriber writes.
      expect(kv.hset).toHaveBeenCalledTimes(1);
      expect(kv.hset).toHaveBeenCalledWith(
        `test:latest:device:${SOURCE_DEVICE}`,
        expect.any(Object),
      );
    });
  });

  describe("getLatestValues", () => {
    it("unions every leg the handle names, device last", async () => {
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

      // area leg (read first), then device leg — the device's own value wins a path tie
      (kv.hgetall as jest.MockedFunction<any>)
        .mockResolvedValueOnce({
          "load.hvac/power": { ...mockValues["load.hvac/power"], value: 1 },
        })
        .mockResolvedValueOnce(mockValues);

      const result = await getLatestValues(SOURCE_HANDLE);

      expect(kv.hgetall).toHaveBeenCalledWith(
        `test:latest:area:${SOURCE_AREA}`,
      );
      expect(kv.hgetall).toHaveBeenCalledWith(
        `test:latest:device:${SOURCE_DEVICE}`,
      );
      expect(result).toEqual(mockValues);
    });

    it("should return empty object when no values exist", async () => {
      const { kv } = await import("../kv");

      (kv.hgetall as jest.MockedFunction<any>).mockResolvedValue(null);

      const result = await getLatestValues(SOURCE_HANDLE);

      expect(result).toEqual({});
    });

    it("returns empty and reads nothing for a handle that names no subject", async () => {
      const { kv } = await import("../kv");

      const result = await getLatestValues(9999);

      expect(result).toEqual({});
      expect(kv.hgetall).not.toHaveBeenCalled();
    });
  });

  describe("buildSubscriptionRegistry", () => {
    // Mock getAreaBindings's query. PR 3 dropped the `legacy_handles` LEFT JOIN (the subscriber is now
    // named by `areas.id`, not its integer handle), so the chain is select→from→innerJoin×3→orderBy.
    const mockBindings = (rows: unknown[]) => {
      (mockDb.select as jest.MockedFunction<any>).mockReturnValueOnce({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({ orderBy: () => Promise.resolve(rows) }),
            }),
          }),
        }),
      });
    };

    it("builds the reverse source-device→subscriber-Area map from area_bindings", async () => {
      const { kv } = await import("../kv");

      // Area A: solar from device D6 (2 pts) + battery from device D5 (2 pts);
      // Area B: solar from D6 (1) + load from D7 (1). → three SOURCE DEVICE keys.
      const d = (n: number) => `0199f00${n}-0000-7000-8000-00000000000a`;
      mockBindings([
        {
          areaId: AREA_A_UUID,
          sourceDeviceId: d(6),
          pointUid: "uid-6-17",
          ordinal: 0,
        },
        {
          areaId: AREA_A_UUID,
          sourceDeviceId: d(6),
          pointUid: "uid-6-7",
          ordinal: 1,
        },
        {
          areaId: AREA_A_UUID,
          sourceDeviceId: d(5),
          pointUid: "uid-5-7",
          ordinal: 2,
        },
        {
          areaId: AREA_A_UUID,
          sourceDeviceId: d(5),
          pointUid: "uid-5-10",
          ordinal: 3,
        },
        {
          areaId: AREA_B_UUID,
          sourceDeviceId: d(6),
          pointUid: "uid-6-17",
          ordinal: 0,
        },
        {
          areaId: AREA_B_UUID,
          sourceDeviceId: d(7),
          pointUid: "uid-7-3",
          ordinal: 1,
        },
      ]);

      await buildSubscriptionRegistry();

      for (const n of [5, 6, 7]) {
        expect(kv.set).toHaveBeenCalledWith(
          `test:subscriptions:device:${Device.encode(d(n))}`,
          expect.objectContaining({
            pointSubscribers: expect.any(Object),
            lastUpdatedTimeMs: expect.any(Number),
          }),
        );
      }

      // The shared source point fans out to BOTH Areas, as `ar_` TypeIDs with no ordinal half.
      const d6Call = (kv.set as jest.MockedFunction<any>).mock.calls.find(
        (c: any[]) =>
          c[0] === `test:subscriptions:device:${Device.encode(d(6))}`,
      )!;
      expect(d6Call[1].pointSubscribers["uid-6-17"].sort()).toEqual(
        [AREA_A, AREA_B].sort(),
      );
    });

    it("writes no subscriptions when there are no area bindings", async () => {
      const { kv } = await import("../kv");

      mockBindings([]); // no bindings (e.g. no multi-device areas)

      await buildSubscriptionRegistry();

      expect(kv.set).not.toHaveBeenCalled();
    });

    it("deletes a stale entry the rebuild did not write, comparing WHOLE keys", async () => {
      const { kv } = await import("../kv");

      mockBindings([]);
      (kv.keys as jest.MockedFunction<any>).mockResolvedValueOnce([
        "test:subscriptions:device:dv_0000000000000000000000000",
      ]);

      await buildSubscriptionRegistry();

      expect(kv.del).toHaveBeenCalledWith(
        "test:subscriptions:device:dv_0000000000000000000000000",
      );
    });
  });
});
