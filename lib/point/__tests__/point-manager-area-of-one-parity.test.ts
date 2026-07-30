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
 * NB: the OTHER N=1 hazard — a legacy area with ZERO `area_members` rows resolving to an empty set —
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
// config-v4 slice 1b: served points come from `points ⋈ devices`, so the schema mock carries those
// two tables as well as `point_info` (still the write-behind copy). Named columns rather than `{}`
// because the query now references `devices.rid` / `points.deviceId` by identity.
jest.mock("@/lib/db/planetscale/schema", () => ({
  pointInfo: { systemId: "pi.system_id", rid: "pi.rid" },
  points: {
    id: "p.id",
    rid: "p.rid",
    deviceId: "p.device_id",
    physicalPath: "p.physical_path",
    logicalPath: "p.logical_path",
    metricType: "p.metric_type",
    unit: "p.unit",
    name: "p.name",
    defaultName: "p.default_name",
    subsystem: "p.subsystem",
    transform: "p.transform",
    active: "p.active",
    createdAt: "p.created_at",
    updatedAt: "p.updated_at",
  },
  devices: { id: "d.id", rid: "d.rid" },
}));

// config-v4 slice K3: the polymorphic-handle discriminator moved from `SystemsManager.isAreaHandle` to
// `DeviceConfigRegistry.isAreaHandle`. This gate is unchanged in what it asserts — only the seam it stubs.
const isAreaHandle = jest.fn<(id: number) => Promise<boolean>>();
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { isAreaHandle },
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

// Membership is uuid-keyed since slice H, so the mock returns `dv_` ids and the manager converts them
// back through DeviceRegistry.ridsForDevices. Both are mocked, and the fake ids encode their own rid so
// the conversion stays honest rather than collapsing to a constant.
const getAreaMemberDeviceIds = jest.fn<(areaId: string) => Promise<string[]>>();
jest.mock("@/lib/areas/members", () => ({
  getAreaMemberDeviceIds: (areaId: string) => getAreaMemberDeviceIds(areaId),
}));

const deviceIdFor = (rid: number) => `dv_fake_${rid}`;
jest.mock("@/lib/registry", () => ({
  DeviceRegistry: {
    ridsForDevices: async (ids: string[]) =>
      new Map(ids.map((id) => [id, Number(id.replace("dv_fake_", ""))])),
  },
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
    getAreaMemberDeviceIds.mockResolvedValue([deviceIdFor(1)]);
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
    getAreaMemberDeviceIds.mockResolvedValue([]); // zero members → union-of-nothing
    const points = await resolve(1);
    expect(points).toEqual([]);
  });
});
