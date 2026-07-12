import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// allowedSystemIds maps Area uuids → legacy_system_id, and resolveDashboardReadPoints fans out to the
// point layer. Mock both so the set logic / union is driven deterministically (no DB).
jest.mock("@/lib/areas/resolve", () => ({
  getLegacySystemIdForArea: jest.fn(),
}));
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: { getInstance: jest.fn() },
}));

import {
  toReadAccess,
  allowedSystemIds,
  resolveDashboardReadPoints,
} from "@/lib/dashboard/access";
import { getLegacySystemIdForArea } from "@/lib/areas/resolve";
import { PointManager } from "@/lib/point/point-manager";
import type { DashboardV3 } from "@/lib/dashboard/v3";

const mockGetLegacy = jest.mocked(getLegacySystemIdForArea);
const mockGetInstance = jest.mocked(PointManager.getInstance);

// Build a v3 descriptor whose SECTION areaIds are the distinct areaIds of the given cards — the only
// thing the share-scope resolvers read (via descriptorAreaIds). Cards without an areaId contribute none.
function descriptor(
  cards: { type: string; id?: string; areaId?: string }[],
): DashboardV3 {
  const areaIds = [
    ...new Set(cards.map((c) => c.areaId).filter((x): x is string => !!x)),
  ];
  return {
    version: 3,
    sections: areaIds.map((areaId) => ({ areaId, cards: [] })),
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
  });

  /** Wire getActivePointsForSystem(handle) → the given points, keyed by handle. */
  function withPoints(map: Record<number, ReturnType<typeof pt>[]>) {
    const getActivePointsForSystem = jest.fn(
      async (sid: number) => map[sid] ?? [],
    );
    mockGetInstance.mockReturnValue({
      getActivePointsForSystem,
    } as unknown as ReturnType<typeof PointManager.getInstance>);
  }

  it("is empty for a descriptor with no sections", async () => {
    withPoints({});
    const out = await allowedSystemIds({ descriptor: descriptor([]) });
    expect(out).toEqual([]);
    // No Area uuids → no resolution happens at all.
    expect(mockGetLegacy).not.toHaveBeenCalled();
  });

  it("an area-of-one → just its own systemId", async () => {
    mockGetLegacy.mockResolvedValue(7); // area → real system 7
    withPoints({ 7: [pt(7, 0), pt(7, 1)] });
    const out = await allowedSystemIds({
      descriptor: descriptor([{ type: "tiles", areaId: "a7" }]),
    });
    expect(out).toEqual([7]);
  });

  it("a multi-device area → the handle AND its member systems (authorizes member-scoped cards)", async () => {
    mockGetLegacy.mockResolvedValue(1000002); // area handle
    withPoints({ 1000002: [pt(1, 0), pt(14, 0), pt(1, 5)] }); // members 1 + 14
    const out = await allowedSystemIds({
      descriptor: descriptor([{ type: "tiles", areaId: "site" }]),
    });
    expect([...out].sort((a, b) => a - b)).toEqual([1, 14, 1000002]);
  });

  it("unions distinct section areas (handles + members), deduped", async () => {
    mockGetLegacy.mockImplementation(
      async (areaId: string) =>
        (({ A: 1000002, B: 8 }) as Record<string, number>)[areaId] ?? null,
    );
    withPoints({
      1000002: [pt(1, 0), pt(14, 0)],
      8: [pt(5, 0), pt(6, 0)], // Kinkora-style child systems
    });
    const out = await allowedSystemIds({
      descriptor: descriptor([
        { type: "tiles", areaId: "A" },
        { type: "chart", id: "c1", areaId: "B" },
      ]),
    });
    expect([...out].sort((a, b) => a - b)).toEqual([1, 5, 6, 8, 14, 1000002]);
  });

  it("drops a dangling/deleted area uuid (no escalation, no throw)", async () => {
    mockGetLegacy.mockResolvedValue(null); // uuid unknown
    withPoints({});
    const out = await allowedSystemIds({
      descriptor: descriptor([{ type: "chart", id: "c1", areaId: "ghost" }]),
    });
    expect(out).toEqual([]);
  });

  it("keeps the handle even when its points can't resolve (throw caught)", async () => {
    mockGetLegacy.mockResolvedValue(1000002);
    const getActivePointsForSystem = jest.fn(async () => {
      throw new Error("System not found");
    });
    mockGetInstance.mockReturnValue({
      getActivePointsForSystem,
    } as unknown as ReturnType<typeof PointManager.getInstance>);
    const out = await allowedSystemIds({
      descriptor: descriptor([{ type: "tiles", areaId: "site" }]),
    });
    expect(out).toEqual([1000002]);
  });
});

describe("resolveDashboardReadPoints — union of points across allowed areas", () => {
  beforeEach(() => {
    mockGetLegacy.mockReset();
  });

  it("unions a composite area's child points", async () => {
    mockGetLegacy.mockResolvedValue(10001); // composite virtual-system handle
    const getActivePointsForSystem = jest.fn(async (sid: number) =>
      sid === 10001 ? [pt(5, 7), pt(6, 9), pt(6, 13)] : [],
    );
    mockGetInstance.mockReturnValue({
      getActivePointsForSystem,
    } as unknown as ReturnType<typeof PointManager.getInstance>);

    const out = await resolveDashboardReadPoints({
      descriptor: descriptor([{ type: "tiles", areaId: "composite" }]),
    });
    expect(out.systemIds).toEqual([5, 6]);
    expect(out.points).toHaveLength(3);
  });

  it("defensively skips an unresolvable system handle instead of throwing", async () => {
    mockGetLegacy.mockImplementation(async (areaId: string) =>
      areaId === "good" ? 5 : 999,
    );
    const getActivePointsForSystem = jest.fn(async (sid: number) => {
      if (sid === 5) return [pt(5, 0), pt(5, 1)];
      throw new Error(`System not found: ${sid}`); // mirrors PointManager behaviour
    });
    mockGetInstance.mockReturnValue({
      getActivePointsForSystem,
    } as unknown as ReturnType<typeof PointManager.getInstance>);

    const out = await resolveDashboardReadPoints({
      descriptor: descriptor([
        { type: "tiles", areaId: "good" },
        { type: "chart", id: "c1", areaId: "gone" },
      ]),
    });
    // sys 999 threw and was skipped; sys 5's points survive.
    expect(out.systemIds).toEqual([5]);
    expect(out.points).toHaveLength(2);
  });
});
