/**
 * Handle dispatch for `memberDevices` — the DEVICE-FIRST lock.
 *
 * This is the sibling of `lib/point/__tests__/point-manager-handle-dispatch.test.ts`, and it exists
 * because the two used to disagree. A handle can name BOTH a device and an area;
 * `DeviceRegistry.resolveHandle` returns both legs and states no precedence, so every consumer makes
 * the choice itself. `_resolvePointsForHandle` chose device-first and pinned it with a test.
 * `memberDevices` chose area-first and pinned nothing — it simply read the area leg and never saw the
 * device leg at all.
 *
 * 🛑 The collision case below is the load-bearing one, and it is not hypothetical — it is the shape
 * that exists on production. The old implementation guarded itself with a comment claiming the
 * area-of-one is always empty, so the area branch would harmlessly fall through to the device. A
 * re-homed device leaves that area behind holding the area's OWN derived helper, membership is not
 * empty, the fall-through never fires, and the answer is a member set that does not contain the
 * device the handle names. Downstream, `getRunDetectorForDevices` then matched no detector and the EV
 * panel reported "no charge sessions" on a page whose chart was bracketing those very sessions.
 *
 * A comment cannot be wrong at build time. This file is the replacement for that comment.
 * See `docs/plans/exact-resolution-or-refuse.md`.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const deviceByHandle =
  jest.fn<(h: number) => Promise<{ deviceId: string } | null>>();
const areaByHandle = jest.fn<(h: number) => Promise<{ id: string } | null>>();
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle, areaByHandle },
}));

const getAreaMemberDeviceIds = jest.fn<(areaId: string) => Promise<string[]>>();
jest.mock("@/lib/areas/members", () => ({
  getAreaMemberDeviceIds: (areaId: string) => getAreaMemberDeviceIds(areaId),
}));

// The fake ids encode their own rid so the uuid→rid conversion stays honest rather than collapsing
// to a constant — same trick as the point-manager dispatch test.
jest.mock("@/lib/registry", () => ({
  DeviceRegistry: {
    ridsForDevices: async (ids: string[]) =>
      new Map(ids.map((id) => [id, Number(id.replace("dv_fake_", ""))])),
  },
}));

// The rest of the module's imports are inert for these tests but must not touch a database.
jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: null,
  requirePlanetscaleDb: () => ({}),
}));

import { memberDevices } from "../server";

const dev = (rid: number) => `dv_fake_${rid}`;

describe("memberDevices — device-first handle dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deviceByHandle.mockResolvedValue(null);
    areaByHandle.mockResolvedValue(null);
    getAreaMemberDeviceIds.mockResolvedValue([]);
  });

  it("a handle naming only a device answers with that device", async () => {
    deviceByHandle.mockResolvedValue({ deviceId: dev(13) });
    expect(await memberDevices(13)).toEqual([{ deviceId: dev(13), rid: 13 }]);
    expect(getAreaMemberDeviceIds).not.toHaveBeenCalled();
  });

  it("a handle naming only an area answers with the area's members", async () => {
    areaByHandle.mockResolvedValue({ id: "area-uuid" });
    getAreaMemberDeviceIds.mockResolvedValue([dev(5), dev(6)]);
    expect(await memberDevices(8)).toEqual([
      { deviceId: dev(5), rid: 5 },
      { deviceId: dev(6), rid: 6 },
    ]);
  });

  it("🛑 a COLLIDING handle answers with its own device, never the area's members", async () => {
    // Exactly the production shape: handle 13 names the device AND the area-of-one it has since been
    // re-homed out of — an area that is NOT empty, because it still holds its own derived helper.
    deviceByHandle.mockResolvedValue({ deviceId: dev(13) });
    areaByHandle.mockResolvedValue({ id: "stale-area-of-one" });
    getAreaMemberDeviceIds.mockResolvedValue([dev(16)]); // the helper — not the device

    expect(await memberDevices(13)).toEqual([{ deviceId: dev(13), rid: 13 }]);
    // Not merely "the right answer came out": the area leg must not be consulted at all, so no
    // future change to membership can reintroduce the widening.
    expect(getAreaMemberDeviceIds).not.toHaveBeenCalled();
  });

  it("a colliding handle whose area IS empty still answers with the device", async () => {
    // The case the old comment assumed was universal. It must keep working — it just must not be
    // what makes the answer correct.
    deviceByHandle.mockResolvedValue({ deviceId: dev(1) });
    areaByHandle.mockResolvedValue({ id: "empty-area-of-one" });
    getAreaMemberDeviceIds.mockResolvedValue([]);
    expect(await memberDevices(1)).toEqual([{ deviceId: dev(1), rid: 1 }]);
  });

  it("a handle naming an area with no members answers empty, not the handle itself", async () => {
    areaByHandle.mockResolvedValue({ id: "area-uuid" });
    getAreaMemberDeviceIds.mockResolvedValue([]);
    expect(await memberDevices(1000003)).toEqual([]);
  });

  it("a handle naming neither answers empty", async () => {
    expect(await memberDevices(999)).toEqual([]);
  });
});
