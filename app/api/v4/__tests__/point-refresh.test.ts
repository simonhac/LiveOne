/**
 * ROUTE-level tests for `POST /api/v4/points/{pt_…}/refresh` — the control dialog's
 * stale-data remedy.
 *
 * Same resolution/authorization skeleton as the action route (a point id names its device;
 * `requireOwner` alone is the gate), so this suite pins the same three seams plus the one
 * behaviour that is its own: a 202 that schedules the re-poll and promises nothing else.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Point } from "@/lib/ids";

const POINT = Point.generate();
const POINT_UUID = Point.toUuid(POINT);

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/control/point-actions", () => ({
  loadPointByUuid: jest.fn(),
}));
jest.mock("@/lib/control/repoll", () => ({ scheduleRepoll: jest.fn() }));

import { requireDeviceAccess } from "@/lib/api-auth";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { loadPointByUuid } from "@/lib/control/point-actions";
import { scheduleRepoll } from "@/lib/control/repoll";
import { POST } from "../points/[id]/refresh/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockLoad = jest.mocked(loadPointByUuid);
const mockRepoll = jest.mocked(scheduleRepoll);

const device = {
  id: 10,
  vendorType: "tesla",
  ownerClerkUserId: "user_owner",
} as unknown as DeviceConfigView;

function call(id: string = POINT) {
  const request = new NextRequest("http://localhost/api/v4/points/x/refresh", {
    method: "POST",
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue({
    point: { id: POINT_UUID } as any,
    deviceRid: 10,
  });
  mockAuth.mockResolvedValue({
    userId: "user_owner",
    device: device as any,
    isOwner: true,
    canRead: true,
    canWrite: true,
  } as any);
});

describe("POST /api/v4/points/[id]/refresh", () => {
  it("schedules the re-poll and answers 202 {scheduled:true}", async () => {
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ scheduled: true });
    expect(mockRepoll).toHaveBeenCalledWith(device);
  });

  it("400s a malformed point id, without touching the DB", async () => {
    const res = await call("not-a-typeid");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid point id");
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockRepoll).not.toHaveBeenCalled();
  });

  it("404s an unknown point", async () => {
    mockLoad.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockRepoll).not.toHaveBeenCalled();
  });

  it("🛑 passes an authorization response straight through and schedules nothing", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    );
    const res = await call();
    expect(res.status).toBe(403);
    expect(mockRepoll).not.toHaveBeenCalled();
  });

  it("🛑 authorizes the point's DEVICE on OWNERSHIP — `requireOwner` alone", async () => {
    // A refresh spends the owner's vendor read and can wake their hardware, so it is gated
    // exactly like commanding the device. Exact `toEqual` pins the lone flag (the action
    // route's rationale).
    await call();
    expect(mockAuth.mock.calls[0][1]).toBe(10);
    expect(mockAuth.mock.calls[0][2]).toEqual({ requireOwner: true });
  });
});
