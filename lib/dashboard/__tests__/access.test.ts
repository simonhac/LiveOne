import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Area, Device, newUuidV7, type DeviceId } from "@/lib/ids";
import type { DeviceAddr, DeviceRid } from "@/lib/registry";

// dashboardAreaUuids requires an envelope `area` ref to be an `ar_` TypeID (STRICT as of Phase 14)
// — short mnemonic labels ("site", "A", "ghost") no longer decode. Mint one real uuid per mnemonic so
// the fixtures below can keep their readable labels while satisfying the decode.
const AREA = new Proxy({} as Record<string, string>, {
  get: (cache, label: string) => (cache[label] ??= newUuidV7()),
});

// allowedSystemIds maps Area uuids → legacy_system_id, and resolveDashboardReadPoints fans out to the
// point layer. Mock both so the set logic / union is driven deterministically (no DB).
jest.mock("@/lib/areas/resolve", () => ({
  getLegacySystemIdForArea: jest.fn(),
}));
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: { getInstance: jest.fn() },
}));
const mockAddrsForDevices =
  jest.fn<(ids: DeviceId[]) => Promise<Map<DeviceId, DeviceAddr>>>();
jest.mock("@/lib/registry", () => ({
  DeviceRegistry: { addrsForDevices: mockAddrsForDevices },
}));

import {
  toReadAccess,
  allowedSystemIds,
  resolveDashboardReadPoints,
} from "@/lib/dashboard/access";
import { getLegacySystemIdForArea } from "@/lib/areas/resolve";
import { PointManager } from "@/lib/point/point-manager";

const mockGetLegacy = jest.mocked(getLegacySystemIdForArea);
const mockGetInstance = jest.mocked(PointManager.getInstance);

// Build a v4 document holding one area-scoped group per distinct area — the only thing the
// share-scope resolvers read (the §8.3 envelope refs, via `collectRefs`).
//
// config-v4 Phase 14 stage 15: this was a v3 `descriptor` builder until `dashboards.descriptor` went
// inert. Every assertion below is unchanged, because the scope has always been "the distinct Areas
// the dashboard references" — only the shape carrying them moved.
//
// Decode is STRICT, so a stored `area` must be `ar_`. Encode HERE rather than minting `ar_` in the
// AREA proxy, because the mocks above (getLegacySystemIdForArea) are keyed on the RAW uuid — the form
// that travels below the seam. Encoding at exactly this boundary is what the real write path does.
function doc(areaUuids: string[]): unknown {
  return {
    version: 4,
    root: {
      kind: "group",
      children: [...new Set(areaUuids)].map((areaId) => ({
        kind: "group",
        area: Area.encode(areaId),
        children: [],
      })),
    },
  };
}

/** A fake PointInfo whose getReference() returns the given ref (the only method the resolver uses). */
function pt(systemId: number, pointId: number) {
  return { getReference: () => ({ systemId, pointId }) };
}

describe("toReadAccess — dashboard read-scope shaping", () => {
  it("passes through a single system's points", () => {
    const out = toReadAccess([
      { systemId: 1, pointId: 0 },
      { systemId: 1, pointId: 5 },
    ]);
    expect(out.systemIds).toEqual([1]);
    expect(out.points).toEqual([
      { systemId: 1, pointId: 0 },
      { systemId: 1, pointId: 5 },
    ]);
  });

  it("dedups systemIds across a composite's child systems (preserves point order)", () => {
    const out = toReadAccess([
      { systemId: 5, pointId: 7 }, // Kinkora-style: battery soc on sys 5
      { systemId: 6, pointId: 9 }, // battery power on sys 6
      { systemId: 6, pointId: 13 }, // grid power on sys 6
      { systemId: 9, pointId: 1 }, // amber rate on sys 9
    ]);
    expect(out.systemIds).toEqual([5, 6, 9]);
    expect(out.points).toHaveLength(4);
  });

  it("returns empty for a dashboard with no resolvable points", () => {
    expect(toReadAccess([])).toEqual({ systemIds: [], points: [] });
  });
});

describe("allowedSystemIds — the share-scope system set (handles + member systems)", () => {
  beforeEach(() => {
    mockGetLegacy.mockReset();
    mockGetInstance.mockReset();
    mockAddrsForDevices.mockReset();
    mockAddrsForDevices.mockResolvedValue(new Map());
  });

  /** Wire getActivePointsForDevice(handle) → the given points, keyed by handle. */
  function withPoints(map: Record<number, ReturnType<typeof pt>[]>) {
    const getActivePointsForDevice = jest.fn(
      async (sid: number) => map[sid] ?? [],
    );
    mockGetInstance.mockReturnValue({
      getActivePointsForDevice,
    } as unknown as ReturnType<typeof PointManager.getInstance>);
  }

  it("is empty for a document with no area refs", async () => {
    withPoints({});
    const out = await allowedSystemIds({ doc: doc([]) });
    expect(out).toEqual([]);
    // No Area uuids → no resolution happens at all.
    expect(mockGetLegacy).not.toHaveBeenCalled();
  });

  it("an area-of-one → just its own systemId", async () => {
    mockGetLegacy.mockResolvedValue(7); // area → real device 7
    withPoints({ 7: [pt(7, 0), pt(7, 1)] });
    const out = await allowedSystemIds({
      doc: doc([AREA.a7]),
    });
    expect(out).toEqual([7]);
  });

  it("a multi-device area → the handle AND its member systems (authorizes member-scoped cards)", async () => {
    mockGetLegacy.mockResolvedValue(1000002); // area handle
    withPoints({ 1000002: [pt(1, 0), pt(14, 0), pt(1, 5)] }); // members 1 + 14
    const out = await allowedSystemIds({
      doc: doc([AREA.site]),
    });
    expect([...out].sort((a, b) => a - b)).toEqual([1, 14, 1000002]);
  });

  it("unions distinct section areas (handles + members), deduped", async () => {
    mockGetLegacy.mockImplementation(
      async (areaId: string) =>
        (({ [AREA.A]: 1000002, [AREA.B]: 8 }) as Record<string, number>)[
          areaId
        ] ?? null,
    );
    withPoints({
      1000002: [pt(1, 0), pt(14, 0)],
      8: [pt(5, 0), pt(6, 0)], // Kinkora-style child devices
    });
    const out = await allowedSystemIds({
      doc: doc([AREA.A, AREA.B]),
    });
    expect([...out].sort((a, b) => a - b)).toEqual([1, 5, 6, 8, 14, 1000002]);
  });

  it("drops a dangling/deleted area uuid (no escalation, no throw)", async () => {
    mockGetLegacy.mockResolvedValue(null); // uuid unknown
    withPoints({});
    const out = await allowedSystemIds({
      doc: doc([AREA.ghost]),
    });
    expect(out).toEqual([]);
  });

  it("keeps the handle even when its points can't resolve (throw caught)", async () => {
    mockGetLegacy.mockResolvedValue(1000002);
    const getActivePointsForDevice = jest.fn(async () => {
      throw new Error("System not found");
    });
    mockGetInstance.mockReturnValue({
      getActivePointsForDevice,
    } as unknown as ReturnType<typeof PointManager.getInstance>);
    const out = await allowedSystemIds({
      doc: doc([AREA.site]),
    });
    expect(out).toEqual([1000002]);
  });

  it("includes a directly referenced v4 device and its points", async () => {
    const device = Device.generate();
    mockAddrsForDevices.mockResolvedValue(
      new Map([
        [
          device,
          {
            deviceId: device,
            uuid: Device.toUuid(device),
            rid: 14 as DeviceRid,
            handle: 14,
          },
        ],
      ]),
    );
    withPoints({ 14: [pt(14, 0), pt(14, 1)] });
    const out = await allowedSystemIds({
      doc: {
        version: 4,
        root: {
          kind: "group",
          children: [{ kind: "card", type: "oe-grid", device }],
        },
      },
    });
    expect(out).toEqual([14]);
  });

  // config-v4 Phase 14 stage 15: there is no `descriptor` fallback left, so a doc that fails the v4
  // shape guard resolves to NOTHING rather than to a second, divergent document. Fail-closed: an
  // unreadable dashboard authorizes no device at all.
  it("a doc that is not valid v4 → empty scope, and nothing is resolved", async () => {
    withPoints({});
    for (const bad of [null, undefined, {}, { version: 3, sections: [] }]) {
      expect(await allowedSystemIds({ doc: bad })).toEqual([]);
    }
    expect(mockGetLegacy).not.toHaveBeenCalled();
  });
});

describe("resolveDashboardReadPoints — union of points across allowed areas", () => {
  beforeEach(() => {
    mockGetLegacy.mockReset();
  });

  it("unions a composite area's child points", async () => {
    mockGetLegacy.mockResolvedValue(10001); // composite virtual-device handle
    const getActivePointsForDevice = jest.fn(async (sid: number) =>
      sid === 10001 ? [pt(5, 7), pt(6, 9), pt(6, 13)] : [],
    );
    mockGetInstance.mockReturnValue({
      getActivePointsForDevice,
    } as unknown as ReturnType<typeof PointManager.getInstance>);

    const out = await resolveDashboardReadPoints({
      doc: doc([AREA.composite]),
    });
    expect(out.systemIds).toEqual([5, 6]);
    expect(out.points).toHaveLength(3);
  });

  it("defensively skips an unresolvable system handle instead of throwing", async () => {
    mockGetLegacy.mockImplementation(async (areaId: string) =>
      areaId === AREA.good ? 5 : 999,
    );
    const getActivePointsForDevice = jest.fn(async (sid: number) => {
      if (sid === 5) return [pt(5, 0), pt(5, 1)];
      throw new Error(`System not found: ${sid}`); // mirrors PointManager behaviour
    });
    mockGetInstance.mockReturnValue({
      getActivePointsForDevice,
    } as unknown as ReturnType<typeof PointManager.getInstance>);

    const out = await resolveDashboardReadPoints({
      doc: doc([AREA.good, AREA.gone]),
    });
    // sys 999 threw and was skipped; sys 5's points survive.
    expect(out.systemIds).toEqual([5]);
    expect(out.points).toHaveLength(2);
  });
});
