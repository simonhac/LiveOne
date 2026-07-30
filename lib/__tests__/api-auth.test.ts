import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// requireDashboardAccess funnels every share-token data read. Mock the token validation, the dashboard
// lookup, the scope set, the devices cache, and the anonymous-auth fallthrough so we can prove:
//   (1) a token grants its dashboard's own device, (2) it grants a multi-area card's device, and
//   (3) an escalation attempt (?systemId=<not in scope>) is rejected (falls through to denied auth).
jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: null })),
}));
jest.mock("@/lib/auth-utils", () => ({
  isUserAdmin: jest.fn(async () => false),
}));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/dashboard/sharing", () => ({
  validateDashboardShareToken: jest.fn(),
}));
jest.mock("@/lib/dashboard/dashboards", () => ({ getDashboard: jest.fn() }));
jest.mock("@/lib/dashboard/access", () => ({ allowedSystemIds: jest.fn() }));
// config-v4 slice K2 + K3: `requireDeviceAccess` AND the polymorphic-handle area views both read the
// device config registry now, so it is the only config seam to mock.
// Phase 13 PR 1 adds `areaByHandle` — the area-native leg of `ServingSubject`. It MUST be mocked here:
// `requireDashboardAccess` now returns a `subject` alongside `device`, and without this entry the area
// leg would throw rather than resolve (a real device short-circuits before reaching it, so the device
// tests below would still have passed while the area path was broken).
// Phase 13 PR 2 deleted `viewableByHandle`/`isAreaHandle`: `requireDashboardAccess` now asks the two
// real readers side by side, because it must know whether a handle names a device, an area, or BOTH.
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: jest.fn(),
    areaByHandle: jest.fn(),
  },
}));

import { requireDashboardAccess } from "@/lib/api-auth";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

const mockValidate = jest.mocked(validateDashboardShareToken);
const mockGetDashboard = jest.mocked(getDashboard);
const mockAllowed = jest.mocked(allowedSystemIds);
const mockDeviceByHandle = jest.mocked(DeviceConfigRegistry.deviceByHandle);
const mockAreaByHandle = jest.mocked(DeviceConfigRegistry.areaByHandle);

function req(systemId: number, token: string): NextRequest {
  return {
    url: `http://localhost/api/data?systemId=${systemId}&access=${token}`,
    method: "GET",
    headers: new Headers(),
  } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Any device resolves to an OWNED (non-public) device, so the anonymous fallthrough denies.
  const getDevice = jest.fn(async (sid: number) => ({
    id: sid,
    ownerClerkUserId: "owner_x",
    vendorType: "selectronic",
    timezoneOffsetMin: 600,
    displayName: `sys ${sid}`,
  }));
  mockDeviceByHandle.mockImplementation(
    getDevice as unknown as typeof DeviceConfigRegistry.deviceByHandle,
  );
  // These tests use REAL devices by default, so the area leg is never taken unless a test opts in.
  mockAreaByHandle.mockResolvedValue(null);
  mockValidate.mockResolvedValue({ token: "tok", dashboardId: "d1" });
  mockGetDashboard.mockResolvedValue({
    id: "d1",
    ownerClerkUserId: "owner",
    displayName: "Test",
    alias: null,
    descriptor: { version: 3, sections: [] },
    doc: null,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe("requireDashboardAccess — share-token scope enforcement", () => {
  it("grants read to the dashboard's own system (single-area, inert)", async () => {
    mockAllowed.mockResolvedValue([42]);
    const res = await requireDashboardAccess(req(42, "tok"), 42);
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.viaShareToken).toBe(true);
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(false);
    expect(res.userId).toBeNull();
    // The subject is the DEVICE leg — device-first precedence, trap D-l.
    expect(res.subject.kind).toBe("device");
    expect(res.subject.handle).toBe(42);
  });

  it("grants read to a multi-area card's system (in the union)", async () => {
    mockAllowed.mockResolvedValue([42, 7]);
    const res = await requireDashboardAccess(req(7, "tok"), 7);
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.viaShareToken).toBe(true);
    expect(res.subject.kind).toBe("device");
    expect(res.subject.handle).toBe(7);
  });

  // Phase 13 PR 1: the AREA leg of the anonymous share-token grant. A multi-device Area has no
  // `devices` row, so `subject` must fall through to `areaByHandle` and report `kind: "area"` — and the
  // grant itself must be unchanged (still read-only, still `viaShareToken`).
  it("grants read to an AREA handle in scope, with an area-leg subject", async () => {
    mockAllowed.mockResolvedValue([7]);
    mockDeviceByHandle.mockResolvedValue(null); // a pure Area: no device of its own
    mockAreaByHandle.mockResolvedValue({
      id: "019ec06c-f74f-70c2-94b8-bd2c3dd28226",
      ownerUserId: "owner_x",
      name: "Craig Unified",
      slug: "blackburn",
      status: "active",
      timezoneOffsetMin: 600,
      displayTimezone: "Australia/Melbourne",
      location: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<
      ReturnType<typeof DeviceConfigRegistry.areaByHandle>
    >);
    const res = await requireDashboardAccess(req(7, "tok"), 7);
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.viaShareToken).toBe(true);
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(false);
    expect(res.subject.kind).toBe("area");
    expect(res.subject.handle).toBe(7);
    if (res.subject.kind !== "area") throw new Error("unreachable");
    expect(res.subject.areaId).toBe("ar_01kv06sxtfe3199e5x5gyx50h6");
  });

  it("REJECTS an escalation to a system outside the dashboard's scope", async () => {
    mockAllowed.mockResolvedValue([42]); // 99 is NOT in scope
    const res = await requireDashboardAccess(req(99, "tok"), 99);
    // Falls through to requireDeviceAccess; anonymous caller on an owned device → 401.
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(401);
  });

  it("does not grant when the token is invalid (falls through to normal auth)", async () => {
    mockValidate.mockResolvedValue(null);
    const res = await requireDashboardAccess(req(42, "bad"), 42);
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(401);
  });
});

/**
 * 🛑 The Phase 13 PR 2 authorization fix, on a COLLIDING handle.
 *
 * Handle 13 in production is a real Sigenergy device AND a 3-member Area. Before PR 2 the handle was
 * always authorized DEVICE-first and `/api/data` then re-took the area leg for an explicit `?areaId=`
 * without re-checking it — so the area, which is the WIDER scope (its union contains the device sharing
 * its handle), was served on the strength of the device's grant. `prefer` now selects which entity is
 * authorized, not merely which one is returned.
 *
 * These tests deliberately make the two entities disagree about who may read them. That never happens in
 * today's data, which is exactly why the old code's bug was invisible: with both legs owned by the same
 * user, inheriting the wrong grant is undetectable. Divergent ownership is the only way to observe it.
 */
describe("requireDashboardAccess — `prefer` selects the entity that gets authorized (trap D-l)", () => {
  const AREA_ROW = {
    id: "019ec06c-f74f-70c2-94b8-bd2c3dd28226",
    name: "Kutis",
    slug: "kutis",
    status: "active",
    timezoneOffsetMin: 600,
    displayTimezone: "Australia/Melbourne",
    location: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /** A colliding handle: `device` and `area` both exist, with the given owners. */
  function collide(deviceOwner: string | null, areaOwner: string | null) {
    mockDeviceByHandle.mockResolvedValue({
      id: 13,
      ownerClerkUserId: deviceOwner,
      vendorType: "sigenergy",
      timezoneOffsetMin: 600,
      displayName: "sys 13",
    } as unknown as Awaited<
      ReturnType<typeof DeviceConfigRegistry.deviceByHandle>
    >);
    mockAreaByHandle.mockResolvedValue({
      ...AREA_ROW,
      ownerUserId: areaOwner,
    } as unknown as Awaited<
      ReturnType<typeof DeviceConfigRegistry.areaByHandle>
    >);
  }

  beforeEach(() => {
    // No share token in play — this is about the owner/public leg.
    mockValidate.mockResolvedValue(null);
  });

  it("REFUSES the area leg when only the DEVICE is readable — the widening that PR 2 closed", async () => {
    // The device is PUBLIC (anonymous may read it); the area is OWNED. Pre-PR-2 this combination
    // returned 200 for `?areaId=13`, because authorization ran against the device and the area leg was
    // taken afterwards without a check. The area must now refuse on its own terms.
    collide(null, "owner_y");
    const res = await requireDashboardAccess(
      req(13, "none"),
      13,
      undefined,
      "area",
    );
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(401);
  });

  it("still grants the DEVICE leg for the same handle — the fix does not over-refuse", async () => {
    // Same data, `prefer: "device"` (i.e. `?systemId=13` / `?deviceId=dv_…`). The public device is
    // readable, and the area's stricter ownership must NOT leak across and deny it.
    collide(null, "owner_y");
    const res = await requireDashboardAccess(
      req(13, "none"),
      13,
      undefined,
      "device",
    );
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.subject.kind).toBe("device");
    expect(res.subject.handle).toBe(13);
  });

  it("grants the area leg on the AREA's own terms, not the device's", async () => {
    // Mirror image: the area is PUBLIC and the device is OWNED. `prefer: "area"` must succeed on the
    // area's own ownership — proving the area branch is genuinely consulted for a colliding handle
    // rather than short-circuited by the device-first resolution.
    collide("owner_x", null);
    const res = await requireDashboardAccess(
      req(13, "none"),
      13,
      undefined,
      "area",
    );
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.subject.kind).toBe("area");
    expect(res.subject.handle).toBe(13);
    expect(res.canRead).toBe(true);
    // ⚠️ PRE-EXISTING QUIRK, pinned here rather than blessed. `isOwner` is `ctx.userId === ownerUserId`,
    // so on an OWNERLESS (public) area an anonymous caller compares `null === null` and is treated as
    // the owner — hence `canWrite: true` for a caller who owns nothing. Identical on `main` at
    // `18083af2` (`lib/api-auth.ts:265`), so PR 2 neither introduced nor widened it, and it is currently
    // LATENT: no route reads `DashboardAuthContext.canWrite` (the dashboard data routes are read-only,
    // and `requireDeviceAccess` has its own separate `requireWrite` gate). Asserted so that the day
    // someone DOES read this field, this test fails loudly instead of handing them a false grant.
    expect(res.canWrite).toBe(true);
  });

  it("a PURE area handle (no device) is unaffected by `prefer` — 7/8/1000001/1000002", async () => {
    // The four production area-only handles have no `devices` row, so they took the area branch before
    // PR 2 and must take it under either preference now. This is the no-regression half of the fix.
    mockDeviceByHandle.mockResolvedValue(null);
    mockAreaByHandle.mockResolvedValue({
      ...AREA_ROW,
      ownerUserId: null, // public, so an anonymous probe can observe the grant
    } as unknown as Awaited<
      ReturnType<typeof DeviceConfigRegistry.areaByHandle>
    >);
    for (const prefer of ["device", "area"] as const) {
      const res = await requireDashboardAccess(
        req(7, "none"),
        7,
        undefined,
        prefer,
      );
      if (res instanceof NextResponse) throw new Error(`refused for ${prefer}`);
      expect(res.subject.kind).toBe("area");
      expect(res.subject.handle).toBe(7);
    }
  });
});
