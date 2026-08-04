import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Area, Device } from "@/lib/ids";
import {
  updateLatestPointValue,
  getLatestValues,
  buildSubscriptionRegistry,
  refreshServingForMintedPoints,
  isServingRebuildPending,
  __resetServingRebuildPending,
} from "../kv-cache-manager";
import type { AreaBindingRow } from "@/lib/areas/bindings";
import type { AreaMemberPointRow } from "@/lib/areas/members";

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
    hkeys: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    hdel: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  },
  kvKey: jest.fn((pattern: string) => `test:${pattern}`),
}));

// Mock the database (Postgres). Nothing under test reaches it any more — both serving legs are mocked
// at the DAO boundary below — but the import chain still resolves it. A recursive chain node
// (innerJoin/leftJoin/where return itself; orderBy resolves) answers any query shape with [].
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

// The two serving legs are mocked at the DAO boundary, not at the db-chain level: the classifier under
// test is pure TypeScript over these rows, and the SQL of each leg is pinned separately by
// `lib/areas/__tests__/members.test.ts` (rendered-SQL assertions). Row arrays are swapped per test.
let mockBindingRows: AreaBindingRow[] = [];
let mockMemberRows: AreaMemberPointRow[] = [];
/** Set to make the bindings read blow up, so a rebuild failure can be driven end to end. */
let mockBindingsThrow = false;
jest.mock("@/lib/areas/bindings", () => ({
  getAreaBindings: jest.fn(async () => {
    if (mockBindingsThrow) throw new Error("db down");
    return mockBindingRows;
  }),
}));
jest.mock("@/lib/areas/members", () => ({
  getAreaMemberPointsForServing: jest.fn(async () => mockMemberRows),
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
    const d = (n: number) => `0199f00${n}-0000-7000-8000-00000000000a`;

    const bound = (
      areaId: string,
      deviceUuid: string,
      pointUid: string,
      logicalPath: string | null,
      pointRid: number,
      metricType = "power",
    ): AreaBindingRow => ({
      areaId,
      sourceDeviceId: deviceUuid,
      pointUid,
      pointRid,
      logicalPath,
      metricType,
      ordinal: 0,
    });

    const member = (
      areaId: string,
      deviceUuid: string,
      pointUid: string,
      logicalPath: string,
      pointRid: number,
      metricType = "power",
    ): AreaMemberPointRow => ({
      areaId,
      sourceDeviceId: deviceUuid,
      pointUid,
      pointRid,
      logicalPath,
      metricType,
    });

    /** The registry entry this rebuild wrote for one source device, as the fan-out would read it. */
    const entryFor = (kv: any, deviceUuid: string) =>
      (kv.set as jest.MockedFunction<any>).mock.calls.find(
        (c: any[]) =>
          c[0] === `test:subscriptions:device:${Device.encode(deviceUuid)}`,
      )?.[1];

    let warn: any;

    beforeEach(async () => {
      const { kv } = await import("../kv");
      mockBindingRows = [];
      mockMemberRows = [];
      (kv.hkeys as jest.MockedFunction<any>).mockResolvedValue([]);
      (kv.keys as jest.MockedFunction<any>).mockResolvedValue([]);
      warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => warn.mockRestore());

    it("builds the reverse source-device→subscriber-Area map from area_bindings", async () => {
      const { kv } = await import("../kv");

      // Area A: solar from device D6 (2 pts) + battery from device D5 (2 pts);
      // Area B: solar from D6 (1) + load from D7 (1). → three SOURCE DEVICE keys.
      mockBindingRows = [
        bound(AREA_A_UUID, d(6), "uid-6-17", "source.solar", 617),
        bound(AREA_A_UUID, d(6), "uid-6-7", "source.solar.local", 607),
        bound(AREA_A_UUID, d(5), "uid-5-7", "bidi.battery", 507),
        bound(AREA_A_UUID, d(5), "uid-5-10", "bidi.battery", 510, "soc"),
        bound(AREA_B_UUID, d(6), "uid-6-17", "source.solar", 617),
        bound(AREA_B_UUID, d(7), "uid-7-3", "load", 703),
      ];

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
      expect(entryFor(kv, d(6)).pointSubscribers["uid-6-17"].sort()).toEqual(
        [AREA_A, AREA_B].sort(),
      );
    });

    it("writes no subscriptions when an area has neither bindings nor member points", async () => {
      const { kv } = await import("../kv");

      await buildSubscriptionRegistry();

      expect(kv.set).not.toHaveBeenCalled();
    });

    it("deletes a stale entry the rebuild did not write, comparing WHOLE keys", async () => {
      const { kv } = await import("../kv");

      (kv.keys as jest.MockedFunction<any>).mockResolvedValue([
        "test:subscriptions:device:dv_0000000000000000000000000",
      ]);

      await buildSubscriptionRegistry();

      expect(kv.del).toHaveBeenCalledWith(
        "test:subscriptions:device:dv_0000000000000000000000000",
      );
    });

    // ── the member leg: bindings are role resolution, not a visibility filter ────────────────────

    it("serves an unbound member point whose path nothing else in the area claims", async () => {
      const { kv } = await import("../kv");

      mockBindingRows = [bound(AREA_A_UUID, d(5), "uid-bound", "load", 5)];
      // A capability minted on a member device long after the bindings were authored.
      mockMemberRows = [
        member(AREA_A_UUID, d(6), "uid-new", "ev.charge", 169, "active"),
      ];

      const summary = await buildSubscriptionRegistry();

      expect(entryFor(kv, d(5)).pointSubscribers).toEqual({
        "uid-bound": [AREA_A],
      });
      // The unbound edge exists, and points at the right (source device, subscriber area) pair.
      expect(entryFor(kv, d(6)).pointSubscribers).toEqual({
        "uid-new": [AREA_A],
      });
      expect(summary.contested).toEqual([]);
    });

    it("excludes — and reports — an unbound member point whose path a BOUND point claims", async () => {
      const { kv } = await import("../kv");

      mockBindingRows = [bound(AREA_A_UUID, d(5), "uid-bound", "bidi.grid", 5)];
      mockMemberRows = [member(AREA_A_UUID, d(6), "uid-rival", "bidi.grid", 6)];

      const summary = await buildSubscriptionRegistry();

      expect(entryFor(kv, d(5))).toBeDefined();
      expect(entryFor(kv, d(6))).toBeUndefined();
      expect(summary.contested).toEqual([
        { areaId: AREA_A, path: "bidi.grid/power", pointRids: [5, 6] },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"bidi.grid/power" is claimed by 2 points'),
      );
    });

    it("serves neither of two unbound member points that share a path", async () => {
      const { kv } = await import("../kv");

      // Two live devices both publishing `bidi.grid/power`: serving either would make the area's
      // headline grid number flap last-write-wins between two physical meters.
      mockMemberRows = [
        member(AREA_A_UUID, d(6), "uid-a", "bidi.grid", 6),
        member(AREA_A_UUID, d(7), "uid-b", "bidi.grid", 7),
      ];

      const summary = await buildSubscriptionRegistry();

      expect(kv.set).not.toHaveBeenCalled();
      expect(summary.contested).toEqual([
        { areaId: AREA_A, path: "bidi.grid/power", pointRids: [6, 7] },
      ]);
    });

    it("🛑 withholds — and reports — an unbound point on a path the DISPLAY layer derives", async () => {
      const { kv } = await import("../kv");

      // The Kinkora shape, measured 2026-08-04: Mondo is bound for solar/battery/grid and the load
      // submeters; Fronius is a member and uniquely publishes `load/power` and `source.solar/power`,
      // which Mondo has no counterpart for. Uncontested, so the widening WOULD serve them — and the
      // tile layer prefers a real point over its own fallback, so the Load and Solar headlines would
      // silently move onto Fronius while the Sankey and every chart stayed on Mondo (they resolve
      // through `area_bindings`, which this classifier does not touch). Withheld, not dropped.
      mockBindingRows = [
        bound(AREA_A_UUID, d(6), "uid-mondo-sol-l", "source.solar.local", 65),
      ];
      mockMemberRows = [
        member(AREA_A_UUID, d(5), "uid-fronius-load", "load", 39),
        member(AREA_A_UUID, d(5), "uid-fronius-sol", "source.solar", 36),
        // a genuinely new signal on the same device still gets served — the rule is narrow
        member(AREA_A_UUID, d(5), "uid-fronius-ok", "load", 44, "energy"),
      ];

      const summary = await buildSubscriptionRegistry();

      expect(summary.suppressed).toEqual([
        { areaId: AREA_A, path: "load/power", pointRid: 39 },
        { areaId: AREA_A, path: "source.solar/power", pointRid: 36 },
      ]);
      // the uncontested, non-derived sibling is unaffected
      const entry = entryFor(kv, d(5));
      expect(entry?.pointSubscribers["uid-fronius-ok"]).toEqual([AREA_A]);
      expect(entry?.pointSubscribers["uid-fronius-load"]).toBeUndefined();
      expect(entry?.pointSubscribers["uid-fronius-sol"]).toBeUndefined();
    });

    it("🛑 a BINDING still wins a display-derived path — suppression is mechanical-leg only", async () => {
      const { kv } = await import("../kv");

      // The escape hatch that makes this a decision rather than a prohibition: bind Fronius's
      // `load/power` deliberately and it is served, carrying the charts and Sankey with it.
      mockBindingRows = [bound(AREA_A_UUID, d(5), "uid-fronius-load", "load", 39)];
      mockMemberRows = [member(AREA_A_UUID, d(5), "uid-fronius-load", "load", 39)];

      const summary = await buildSubscriptionRegistry();

      expect(summary.suppressed).toEqual([]);
      expect(entryFor(kv, d(5))?.pointSubscribers["uid-fronius-load"]).toEqual([
        AREA_A,
      ]);
    });

    it("counts a point that is both bound and a member exactly once", async () => {
      const { kv } = await import("../kv");

      // The normal case for every bound point on a member device. If the classifier counted the two
      // rows as two claimants, every bound point would contest itself out of its own path.
      mockBindingRows = [bound(AREA_A_UUID, d(5), "uid", "load", 5)];
      mockMemberRows = [member(AREA_A_UUID, d(5), "uid", "load", 5)];

      const summary = await buildSubscriptionRegistry();

      expect(entryFor(kv, d(5)).pointSubscribers).toEqual({ uid: [AREA_A] });
      expect(summary.contested).toEqual([]);
      expect(summary.edges).toBe(1);
    });

    it("serves every uniquely-pathed member point of a binding-less area (leg-2 parity)", async () => {
      const { kv } = await import("../kv");

      mockMemberRows = [
        member(AREA_A_UUID, d(6), "uid-1", "source.solar", 1),
        member(AREA_A_UUID, d(6), "uid-2", "bidi.battery", 2),
        member(AREA_A_UUID, d(6), "uid-3", "bidi.battery", 3, "soc"),
      ];

      await buildSubscriptionRegistry();

      expect(entryFor(kv, d(6)).pointSubscribers).toEqual({
        "uid-1": [AREA_A],
        "uid-2": [AREA_A],
        "uid-3": [AREA_A],
      });
    });

    it("keeps a bound stemless point's edge without letting it claim a pseudo-path", async () => {
      const { kv } = await import("../kv");

      // `logicalPath` null → no latest-hash field at all. Keyed naively as `null/power` it would
      // collide with nothing today, but it would enter the served-path set and so protect a field
      // literally named "null/power" from GC — and mask a same-metric member twin if the member leg
      // ever stopped filtering nulls.
      mockBindingRows = [bound(AREA_A_UUID, d(5), "uid-stemless", null, 5)];
      mockMemberRows = [
        member(AREA_A_UUID, d(6), "uid-real", "source.solar", 6),
      ];

      const summary = await buildSubscriptionRegistry();

      expect(entryFor(kv, d(5)).pointSubscribers).toEqual({
        "uid-stemless": [AREA_A],
      });
      expect(entryFor(kv, d(6)).pointSubscribers).toEqual({
        "uid-real": [AREA_A],
      });
      expect(summary.contested).toEqual([]);
      expect(summary.servedPathsByArea[AREA_A]).toEqual(["source.solar/power"]);
    });

    // ── area-hash GC: a value that LEAVES the serving set must disappear, not freeze ─────────────

    it("deletes area-hash fields outside the serving set and keeps the served ones", async () => {
      const { kv } = await import("../kv");

      mockBindingRows = [bound(AREA_A_UUID, d(5), "uid-bound", "load", 5)];
      mockMemberRows = [
        member(AREA_A_UUID, d(6), "uid-new", "ev.charge", 169, "active"),
      ];
      (kv.hkeys as jest.MockedFunction<any>).mockResolvedValue([
        "load/power",
        "ev.charge/active",
        "bidi.grid/power", // residue from an old binding — nothing serves it any more
      ]);

      const summary = await buildSubscriptionRegistry();

      expect(kv.hdel).toHaveBeenCalledTimes(1);
      expect(kv.hdel).toHaveBeenCalledWith(
        `test:latest:area:${AREA_A}`,
        "bidi.grid/power",
      );
      expect(summary.gcDeletedFields).toBe(1);
    });

    it("does not read or sweep the hash of an area absent from the registry", async () => {
      const { kv } = await import("../kv");

      mockBindingRows = [bound(AREA_A_UUID, d(5), "uid", "load", 5)];

      await buildSubscriptionRegistry();

      expect(kv.hkeys).toHaveBeenCalledTimes(1);
      expect(kv.hkeys).toHaveBeenCalledWith(`test:latest:area:${AREA_A}`);
      expect(kv.hkeys).not.toHaveBeenCalledWith(`test:latest:area:${AREA_B}`);
    });

    it("removes a served field once its path turns contested on a later rebuild", async () => {
      const { kv } = await import("../kv");

      // Rebuild 1: one member device owns the path → served, nothing GC'd.
      mockMemberRows = [member(AREA_A_UUID, d(6), "uid-a", "bidi.grid", 6)];
      await buildSubscriptionRegistry();
      expect(entryFor(kv, d(6))).toBeDefined();
      expect(kv.hdel).not.toHaveBeenCalled();

      // Rebuild 2: a second device starts publishing the same path. Neither is served now, and the
      // value already in the hash must be REMOVED rather than left frozen at its last reading.
      jest.clearAllMocks();
      mockMemberRows.push(member(AREA_A_UUID, d(7), "uid-b", "bidi.grid", 7));
      (kv.hkeys as jest.MockedFunction<any>).mockResolvedValue([
        "bidi.grid/power",
      ]);

      await buildSubscriptionRegistry();

      expect(kv.set).not.toHaveBeenCalled();
      expect(kv.hdel).toHaveBeenCalledWith(
        `test:latest:area:${AREA_A}`,
        "bidi.grid/power",
      );
    });

    // ── the incident, replayed end to end ────────────────────────────────────────────────────────

    it("a point minted on a device ALREADY in a bound area reaches that area's latest map", async () => {
      const { kv } = await import("../kv");

      // Kinkora Unified's shape: the area has bindings (authored before the Tesla charge points
      // existed) and handle 10's device is already a member. Before this fix the member leg fired
      // only for areas with ZERO bindings, so `ev.charge/active` fanned out to the DEVICE hash and no
      // area hash — and the dashboard's Start/Stop buttons rendered permanently disabled.
      const OLD_POINT = "0199aaaa-0000-7000-8000-000000000076";
      const MINTED_POINT = "0199aaaa-0000-7000-8000-000000000169";
      mockBindingRows = [
        bound(
          AREA_A_UUID,
          SOURCE_DEVICE_UUID,
          OLD_POINT,
          "ev.charge.limit",
          76,
          "soc",
        ),
      ];
      mockMemberRows = [
        // Both points live on the same already-member device; only the older one is bound.
        member(
          AREA_A_UUID,
          SOURCE_DEVICE_UUID,
          OLD_POINT,
          "ev.charge.limit",
          76,
          "soc",
        ),
        member(
          AREA_A_UUID,
          SOURCE_DEVICE_UUID,
          MINTED_POINT,
          "ev.charge",
          169,
          "active",
        ),
      ];

      await buildSubscriptionRegistry();

      // Hand the registry this rebuild wrote to the fan-out, exactly as KV would.
      const entry = entryFor(kv, SOURCE_DEVICE_UUID);
      expect(entry.pointSubscribers[MINTED_POINT]).toEqual([AREA_A]);
      jest.clearAllMocks();
      (kv.get as jest.MockedFunction<any>).mockResolvedValue(entry);

      await updateLatestPointValue(
        SOURCE_HANDLE,
        MINTED_POINT,
        "ev.charge/active",
        1,
        1731627600000,
        1731627605000,
        "bool",
        "Charging",
      );

      expect(kv.hset).toHaveBeenCalledWith(
        `test:latest:area:${AREA_A}`,
        expect.objectContaining({
          "ev.charge/active": expect.objectContaining({ value: 1 }),
        }),
      );
    });
  });

  describe("refreshServingForMintedPoints — the retry flag", () => {
    let warn: any;

    beforeEach(() => {
      mockBindingRows = [];
      mockMemberRows = [];
      mockBindingsThrow = false;
      __resetServingRebuildPending();
      warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      mockBindingsThrow = false;
      __resetServingRebuildPending();
      warn.mockRestore();
    });

    it("never throws, and raises the retry flag when the rebuild fails", async () => {
      mockBindingsThrow = true;

      // Must not propagate: a KV/DB hiccup may not break reading insertion.
      await expect(
        refreshServingForMintedPoints("test"),
      ).resolves.toBeUndefined();

      // ...but it must not be forgotten either. Swallowing this silently would re-create the exact
      // defect being fixed: the minted point stays invisible with nothing logged.
      expect(isServingRebuildPending()).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("refreshServingForMintedPoints(test) failed"),
        expect.anything(),
      );
    });

    it("clears the flag on the next successful rebuild", async () => {
      mockBindingsThrow = true;
      await refreshServingForMintedPoints("failing-batch");
      expect(isServingRebuildPending()).toBe(true);

      mockBindingsThrow = false;
      await refreshServingForMintedPoints("next-batch");

      expect(isServingRebuildPending()).toBe(false);
    });

    it("stays clear after a successful rebuild", async () => {
      await refreshServingForMintedPoints("steady-state");
      expect(isServingRebuildPending()).toBe(false);
    });
  });
});
