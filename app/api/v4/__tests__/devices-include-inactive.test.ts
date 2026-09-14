/**
 * `?includeInactive=true` on the device reads.
 *
 * 🛑 Why it exists. `devicesVisibleByUser` is `activeOnly` by default, and a CLI ref is matched
 * against the LIST — so a non-active device could not be named at all, not even by its literal
 * `dv_…` id. Meanwhile an area aggregate DOES return its archived members on purpose
 * (`lib/areas/v4-shapes.ts`), so anything that walked an area's members into a per-device read hit
 * a 404: `liveone area role list` on an area whose devices had been retired answered
 * `error: Device not found` and exited 1, losing the readable part of the answer with it.
 *
 * 🛑 And the invariant that keeps it safe: this widens WHICH STATUSES you see, never WHOSE devices.
 * It is a separate opt-in from `x-liveone-admin`, and neither implies the other.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { devicesVisibleByUser: jest.fn() },
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: jest.fn(() => ({
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: async () => [] }),
        where: () => ({ limit: async () => [] }),
      }),
    }),
  })),
}));

import { requireAuth } from "@/lib/api-auth";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { GET as devicesGET } from "../devices/route";

const mockAuth = jest.mocked(requireAuth);
const mockVisible = jest.mocked(DeviceConfigRegistry.devicesVisibleByUser);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    userId: "user_1",
    isAdmin: false,
    actingAsAdmin: false,
  } as never);
  mockVisible.mockResolvedValue([]);
});

/** The second positional arg of `devicesVisibleByUser` is `activeOnly`. */
const activeOnlyArg = () => mockVisible.mock.calls[0][1];
const optsArg = () => mockVisible.mock.calls[0][2];

describe("GET /api/v4/devices", () => {
  it("lists ACTIVE devices only by default", async () => {
    await devicesGET(new NextRequest("http://localhost/api/v4/devices"));
    expect(activeOnlyArg()).toBe(true);
  });

  it("includes non-active devices when asked", async () => {
    await devicesGET(
      new NextRequest("http://localhost/api/v4/devices?includeInactive=true"),
    );
    expect(activeOnlyArg()).toBe(false);
  });

  it("takes only the literal `true` — no truthy-string widening", async () => {
    for (const v of ["1", "yes", "", "TRUE"]) {
      mockVisible.mockClear();
      await devicesGET(
        new NextRequest(`http://localhost/api/v4/devices?includeInactive=${v}`),
      );
      expect(activeOnlyArg()).toBe(true);
    }
  });

  it("🛑 does NOT infer includeInactive from admin — admin widens WHOSE, not WHICH STATUSES", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_1",
      isAdmin: true,
      actingAsAdmin: true,
    } as never);
    await devicesGET(new NextRequest("http://localhost/api/v4/devices"));
    expect(activeOnlyArg()).toBe(true);
    expect(optsArg()).toEqual({ isAdmin: true });
  });

  it("🛑 and includeInactive does NOT confer admin — it widens WHICH STATUSES, not WHOSE", async () => {
    await devicesGET(
      new NextRequest("http://localhost/api/v4/devices?includeInactive=true"),
    );
    expect(optsArg()).toEqual({ isAdmin: false });
  });

  it("refuses an unauthenticated caller before reading anything", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "no" }, { status: 401 }) as never,
    );
    const res = await devicesGET(
      new NextRequest("http://localhost/api/v4/devices?includeInactive=true"),
    );
    expect(res.status).toBe(401);
    expect(mockVisible).not.toHaveBeenCalled();
  });
});
