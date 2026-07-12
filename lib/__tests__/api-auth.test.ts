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
jest.mock("@/lib/systems-manager", () => ({
  SystemsManager: { getInstance: jest.fn() },
}));

import { requireDashboardAccess } from "@/lib/api-auth";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { SystemsManager } from "@/lib/systems-manager";

const mockValidate = jest.mocked(validateDashboardShareToken);
const mockGetDashboard = jest.mocked(getDashboard);
const mockAllowed = jest.mocked(allowedSystemIds);
const mockGetInstance = jest.mocked(SystemsManager.getInstance);

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
  mockGetInstance.mockReturnValue({
    getSystem,
    // These tests use REAL systems, so the area-handle branch is never taken and a viewable
    // system resolves to the system itself.
    getViewableSystem: getSystem,
    isAreaHandle: jest.fn(async () => false),
  } as unknown as ReturnType<typeof SystemsManager.getInstance>);
  mockValidate.mockResolvedValue({ token: "tok", dashboardId: 1 });
  mockGetDashboard.mockResolvedValue({
    id: 1,
    ownerClerkUserId: "owner",
    displayName: "Test",
    alias: null,
    descriptor: { version: 3, sections: [] },
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
  });

  it("grants read to a multi-area card's system (in the union)", async () => {
    mockAllowed.mockResolvedValue([42, 7]);
    const res = await requireDashboardAccess(req(7, "tok"), 7);
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.viaShareToken).toBe(true);
    expect(res.system.id).toBe(7);
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
