/**
 * Handle-dispatch and area-of-one parity for `PointManager._resolvePointsForHandle`.
 *
 * ## Why this file changed shape in config-v4 Phase 13 PR 2
 *
 * PR 2 deleted `DeviceConfigRegistry.isAreaHandle`, which this gate used to stub as a single boolean —
 * it could simply *assert* "treat this handle as an area" and compare the two resolution strategies.
 * The dispatch is now derived from the two real readers (`deviceByHandle`, then `areaByHandle` only if
 * there is no device), so the seam is two mocks rather than one flag.
 *
 * That is not a cosmetic re-stub, and these are deliberately not the old tests re-pointed:
 *
 * - The parity invariant SURVIVES and still earns its keep. A device resolves its own `point_info`
 *   (`_loadOwnPoints`); a binding-less area resolves to the UNION of its members' own points. For N=1
 *   those must be element-for-element identical, which is what makes it safe to ever route a device
 *   read through the union path. A future dedup/sort/filter in the union loop still breaks this.
 * - The `[]`-on-empty-membership case survives — a DATA hazard fixed by the membership heal
 *   (scripts/temp/heal-area-of-one-members.sql), documented here so the heal's importance stays explicit.
 * - **The COLLISION case is new, and it is now the load-bearing assertion.** A handle can name BOTH a
 *   device and an area (handle 13: a real Sigenergy device AND a 3-member Area). Under the old boolean
 *   seam this could not be expressed here at all — `isAreaHandle` had already collapsed the collision to
 *   `false` before this function was reached, so device-first precedence was pinned one layer away. The
 *   precedence now lives HERE, so it is pinned HERE: a colliding handle must resolve the DEVICE's own
 *   points and must never consult the area's bindings. That is trap D-l — resolving area-first would
 *   widen handle 13 from its own 12 points to the area's union, on a shared dashboard, in the direction
 *   that GRANTS access.
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

// config-v4 Phase 13 PR 2: the dispatch reads the two real registry readers instead of the deleted
// `isAreaHandle` boolean. Both are stubbed so a test can present a handle as a device, an area, BOTH
// (the collision), or neither.
const deviceByHandle =
  jest.fn<(id: number) => Promise<{ rid: number } | null>>();
const areaByHandle = jest.fn<(id: number) => Promise<{ id: string } | null>>();
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle, areaByHandle },
}));

const getAreaBindingRefs = jest.fn<(id: number) => Promise<unknown[]>>();
jest.mock("@/lib/areas/bindings", () => ({
  getAreaBindingRefs: (id: number) => getAreaBindingRefs(id),
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

describe("PointManager._resolvePointsForHandle — device-first dispatch + area-of-one parity", () => {
  const ownPoints: FakePoint[] = [
    { systemId: 1, pointId: 0 },
    { systemId: 1, pointId: 1 },
  ];

  let pm: PointManager;

  beforeEach(() => {
    jest.clearAllMocks();
    pm = PointManager.getInstance();
    // Default: the handle names neither, so each test opts in to what it needs.
    deviceByHandle.mockResolvedValue(null);
    areaByHandle.mockResolvedValue(null);
    jest
      .spyOn(
        pm as unknown as { _loadOwnPoints: (id: number) => Promise<unknown[]> },
        "_loadOwnPoints",
      )
      .mockImplementation(async (id: number) =>
        id === 1 ? [...ownPoints] : [],
      );
  });

  function resolve(handle: number): Promise<FakePoint[]> {
    return (
      pm as unknown as {
        _resolvePointsForHandle: (h: number) => Promise<FakePoint[]>;
      }
    )._resolvePointsForHandle(handle);
  }

  /** Present `handle` as a real device (no area, or an area that must be ignored). */
  function asDevice(handle: number) {
    deviceByHandle.mockResolvedValue({ rid: handle });
  }

  /** Present `handle` as a binding-less area with the given member rids. */
  function asBindinglessArea(memberRids: number[]) {
    areaByHandle.mockResolvedValue({ id: "area-a" });
    getAreaBindingRefs.mockResolvedValue([]);
    getAreaMemberDeviceIds.mockResolvedValue(memberRids.map(deviceIdFor));
  }

  it("a real device loads its own points directly", async () => {
    asDevice(1);
    const points = await resolve(1);
    expect(points.map(ref)).toEqual(["1.0", "1.1"]);
  });

  it("the same device as an area-of-one (1 member, no bindings) resolves to the IDENTICAL set", async () => {
    asBindinglessArea([1]);
    const viaUnion = await resolve(1);

    jest.clearAllMocks();
    areaByHandle.mockResolvedValue(null);
    asDevice(1);
    const viaOwn = await resolve(1);

    expect(viaUnion.map(ref)).toEqual(viaOwn.map(ref));
    expect(viaUnion.map(ref)).toEqual(["1.0", "1.1"]);
  });

  it("a member-less area-of-one resolves to [] — the data hazard the membership heal fixes", async () => {
    asBindinglessArea([]); // zero members → union-of-nothing
    const points = await resolve(1);
    expect(points).toEqual([]);
  });

  // 🛑 Trap D-l. This is the assertion that keeps handle 13 at its own 12 points.
  it("a COLLIDING handle (a device AND an area) resolves the DEVICE's own points, never the area's", async () => {
    asDevice(1);
    // An area also exists at this handle, with a DIFFERENT member set. If precedence ever flips, the
    // union would be consulted and this handle's point set would widen.
    areaByHandle.mockResolvedValue({ id: "area-a" });
    getAreaBindingRefs.mockResolvedValue([{ pointUid: "should-not-be-read" }]);
    getAreaMemberDeviceIds.mockResolvedValue([deviceIdFor(1), deviceIdFor(2)]);

    const points = await resolve(1);

    expect(points.map(ref)).toEqual(["1.0", "1.1"]);
    // The area legs must not even be CONSULTED for a colliding handle — asserting the result alone
    // would still pass if the code resolved the area and then happened to discard it.
    expect(areaByHandle).not.toHaveBeenCalled();
    expect(getAreaBindingRefs).not.toHaveBeenCalled();
    expect(getAreaMemberDeviceIds).not.toHaveBeenCalled();
  });

  it("a handle that names neither a device nor an area owns no points", async () => {
    const points = await resolve(99);
    expect(points).toEqual([]);
  });
});
