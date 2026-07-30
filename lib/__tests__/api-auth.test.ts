import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// requireDashboardAccess funnels every share-token data read. Mock the token validation, the dashboard
// lookup, the scope set, the systems cache, and the anonymous-auth fallthrough so we can prove:
//   (1) a token grants its dashboard's own system, (2) it grants a multi-area card's system, and
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
// config-v4 slice K2 + K3: `requireSystemAccess` AND the polymorphic-handle area views both read the
// device config registry now, so it is the only config seam to mock.
// Phase 13 PR 1 adds `areaByHandle` — the area-native leg of `ServingSubject`. It MUST be mocked here:
// `requireDashboardAccess` now returns a `subject` alongside `system`, and without this entry the area
// leg would throw rather than resolve (a real device short-circuits before reaching it, so the device
// tests below would still have passed while the area path was broken).
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: jest.fn(),
    areaByHandle: jest.fn(),
    viewableByHandle: jest.fn(),
    isAreaHandle: jest.fn(),
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
const mockViewableByHandle = jest.mocked(DeviceConfigRegistry.viewableByHandle);
const mockIsAreaHandle = jest.mocked(DeviceConfigRegistry.isAreaHandle);

function req(systemId: number, token: string): NextRequest {
  return {
    url: `http://localhost/api/data?systemId=${systemId}&access=${token}`,
    method: "GET",
    headers: new Headers(),
  } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Any system resolves to an OWNED (non-public) system, so the anonymous fallthrough denies.
  const getSystem = jest.fn(async (sid: number) => ({
    id: sid,
    ownerClerkUserId: "owner_x",
    vendorType: "selectronic",
    timezoneOffsetMin: 600,
    displayName: `sys ${sid}`,
  }));
  mockDeviceByHandle.mockImplementation(
    getSystem as unknown as typeof DeviceConfigRegistry.deviceByHandle,
  );
  // These tests use REAL devices, so the area-handle branch is never taken and a viewable system
  // resolves to the device itself.
  mockViewableByHandle.mockImplementation(
    getSystem as unknown as typeof DeviceConfigRegistry.viewableByHandle,
  );
  mockIsAreaHandle.mockResolvedValue(false);
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
    expect(res.system.id).toBe(42);
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
    expect(res.system.id).toBe(7);
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
    // Falls through to requireSystemAccess; anonymous caller on an owned system → 401.
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
