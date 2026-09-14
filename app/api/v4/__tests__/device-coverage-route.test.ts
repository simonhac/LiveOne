/**
 * ROUTE-level tests for `GET /api/v4/devices/{id}/coverage`.
 *
 * The layer that matters here is the BOUNDARY: who may read it, and what a malformed window does.
 * Both had defects that a green unit suite could not see — the readable set was resolved by a
 * different helper from the one every neighbouring device read uses, and a window that merely
 * LOOKED well-formed (`2026-02-30`, or the maximum representable date) reached the pure layer and
 * threw or spun.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { devicesVisibleByUser: jest.fn() },
}));
jest.mock("@/lib/coverage/report", () => ({ buildDeviceCoverage: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: jest.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: "0199ad1f-0000-7000-8000-000000000001",
              rid: 6,
              name: "Kinkora Fronius",
              vendor: "fusher",
              status: "archived",
              dayOffsetMin: 600,
            },
          ],
        }),
      }),
    }),
  })),
}));

import { requireAuth } from "@/lib/api-auth";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { buildDeviceCoverage } from "@/lib/coverage/report";
import { GET } from "../devices/[id]/coverage/route";

const mockAuth = jest.mocked(requireAuth);
const mockVisible = jest.mocked(DeviceConfigRegistry.devicesVisibleByUser);
const mockBuild = jest.mocked(buildDeviceCoverage);

const DV = "dv_03kdgz0000e000g000000000g1";
const params = Promise.resolve({ id: DV });
const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/v4/devices/${DV}/coverage${qs}`), {
    params,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    userId: "user_1",
    isAdmin: false,
    actingAsAdmin: false,
  } as never);
  mockVisible.mockResolvedValue([{ id: 6 }] as never);
  mockBuild.mockResolvedValue({ count: 0, points: [] } as never);
});

describe("authorization", () => {
  it("reads the SAME set as the device list — including archived, excluding nobody else", async () => {
    const res = await call("?last=30d");
    expect(res.status).toBe(200);
    // activeOnly=false (coverage is what you ask about a device that has stopped) and the admin
    // widening rides on actingAsAdmin, exactly as `device list`/`show` do.
    expect(mockVisible).toHaveBeenCalledWith("user_1", false, {
      isAdmin: false,
    });
  });

  it("🛑 does not widen for an admin who did not ask to act as one", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_1",
      isAdmin: true,
      actingAsAdmin: false,
    } as never);
    await call("?last=30d");
    expect(mockVisible).toHaveBeenCalledWith("user_1", false, {
      isAdmin: false,
    });
  });

  it("404s a device outside the readable set, indistinguishably from an unknown one", async () => {
    mockVisible.mockResolvedValue([] as never);
    const res = await call("?last=30d");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Device not found" });
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller before touching the database", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "no" }, { status: 401 }) as never,
    );
    expect((await call("?last=30d")).status).toBe(401);
    expect(mockVisible).not.toHaveBeenCalled();
  });
});

describe("the window", () => {
  it("rejects a date that is shaped right but is not a real day", async () => {
    // 🛑 `parseDate("2026-02-30")` THROWS. A regex-only check let it reach the pure layer as a 500.
    const res = await call("?start=2026-02-30&end=2026-03-01");
    expect(res.status).toBe(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("caps an explicit window, not only the relative one", async () => {
    const res = await call("?start=1000-01-01&end=2026-01-01");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/maximum is 3660/);
  });

  it("rejects a backwards window", async () => {
    expect((await call("?start=2026-02-01&end=2026-01-01")).status).toBe(400);
  });

  it("rejects a sub-daily `last`, rather than rounding it", async () => {
    expect((await call("?last=3h")).status).toBe(400);
  });

  it("rejects `last` together with an explicit window", async () => {
    expect(
      (await call("?last=7d&start=2026-01-01&end=2026-01-07")).status,
    ).toBe(400);
  });

  it("passes a valid explicit window straight through", async () => {
    expect((await call("?start=2026-01-01&end=2026-01-31")).status).toBe(200);
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 6, dayOffsetMin: 600 }),
      { start: "2026-01-01", end: "2026-01-31" },
      undefined,
      null,
    );
  });

  it("rejects a cadence override that is not a sane number of minutes", async () => {
    for (const c of ["0", "-5", "2000", "abc", "5.5"])
      expect((await call(`?last=7d&cadence=${c}`)).status).toBe(400);
  });
});
