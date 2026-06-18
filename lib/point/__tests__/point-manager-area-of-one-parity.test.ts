/**
 * Area-of-one parity invariant for `PointManager._resolvePointsForViewable`.
 *
 * An Area is a grouping of 1..N member devices; a single-device area (an "area-of-one") is the N=1 case.
 * Today a real device resolves its own `point_info` directly (`_loadOwnPoints`), while a multi-device
 * area with no bindings resolves to the UNION of its members' own points. For N=1 those two must be
 * element-for-element identical — that equivalence is what makes it safe to ever route a device read
 * through the area/union path. This test pins it so a future change to the union loop (a dedup, sort, or
 * filter) can't silently diverge for the single-member case.
 *
 * NB: the OTHER N=1 hazard — a legacy area with ZERO `area_devices` members resolving to an empty set —
 * is a DATA problem fixed by the membership heal (scripts/temp/heal-area-of-one-members.sql), not by this
 * code path. The last test documents that empty-membership returns [] so the heal's importance is explicit.
 *
 * The heavy DB layer is mocked so importing the manager is cheap; `_loadOwnPoints` (the per-device
 * primitive both strategies call) is spied so we compare RESOLUTION STRATEGIES, not the DB.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: null,
  requirePlanetscaleDb: () => ({}),
}));
jest.mock("@/lib/db/planetscale/schema", () => ({ pointInfo: {} }));

const isAreaHandle = jest.fn<(id: number) => Promise<boolean>>();
jest.mock("@/lib/systems-manager", () => ({
  SystemsManager: { getInstance: () => ({ isAreaHandle }) },
}));

const getAreaBindingRefs = jest.fn<(id: number) => Promise<unknown[]>>();
jest.mock("@/lib/areas/bindings", () => ({
  getAreaBindingRefs: (id: number) => getAreaBindingRefs(id),
}));

const getAreaForSystem =
  jest.fn<(id: number) => Promise<{ id: string } | null>>();
jest.mock("@/lib/areas/resolve", () => ({
  getAreaForSystem: (id: number) => getAreaForSystem(id),
}));

const getAreaDeviceSystemIds = jest.fn<(areaId: string) => Promise<number[]>>();
jest.mock("@/lib/areas/devices", () => ({
  getAreaDeviceSystemIds: (areaId: string) => getAreaDeviceSystemIds(areaId),
}));

import { PointManager } from "../point-manager";

type FakePoint = { systemId: number; pointId: number };
const ref = (p: FakePoint) => `${p.systemId}.${p.pointId}`;

describe("PointManager._resolvePointsForViewable — area-of-one parity (union-of-one == own points)", () => {
  const ownPoints: FakePoint[] = [
    { systemId: 1, pointId: 0 },
    { systemId: 1, pointId: 1 },
  ];

  let pm: PointManager;

  beforeEach(() => {
    jest.clearAllMocks();
    pm = PointManager.getInstance();
    jest
      .spyOn(
        pm as unknown as { _loadOwnPoints: (id: number) => Promise<unknown[]> },
        "_loadOwnPoints",
      )
      .mockImplementation(async (id: number) =>
        id === 1 ? [...ownPoints] : [],
      );
  });

  function resolve(systemId: number): Promise<FakePoint[]> {
    return (
      pm as unknown as {
        _resolvePointsForViewable: (s: { id: number }) => Promise<FakePoint[]>;
      }
    )._resolvePointsForViewable({ id: systemId });
  }

  it("a real device (not an area handle) loads its own points directly", async () => {
    isAreaHandle.mockResolvedValue(false);
    const points = await resolve(1);
    expect(points.map(ref)).toEqual(["1.0", "1.1"]);
  });

  it("the same device as an area-of-one (1 member, no bindings) resolves to the IDENTICAL set", async () => {
    // Treat handle 1 as areas-backed with a single member == the device and no binding override.
    isAreaHandle.mockResolvedValue(true);
    getAreaBindingRefs.mockResolvedValue([]);
    getAreaForSystem.mockResolvedValue({ id: "area-a" });
    getAreaDeviceSystemIds.mockResolvedValue([1]);
    const viaUnion = await resolve(1);

    isAreaHandle.mockResolvedValue(false);
    const viaOwn = await resolve(1);

    expect(viaUnion.map(ref)).toEqual(viaOwn.map(ref));
    expect(viaUnion.map(ref)).toEqual(["1.0", "1.1"]);
  });

  it("a member-less area-of-one resolves to [] — the data hazard the membership heal fixes", async () => {
    isAreaHandle.mockResolvedValue(true);
    getAreaBindingRefs.mockResolvedValue([]);
    getAreaForSystem.mockResolvedValue({ id: "area-a" });
    getAreaDeviceSystemIds.mockResolvedValue([]); // zero members → union-of-nothing
    const points = await resolve(1);
    expect(points).toEqual([]);
  });
});
