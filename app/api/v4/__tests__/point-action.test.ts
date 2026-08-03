/**
 * ROUTE-level tests for `POST /api/v4/points/{pt_…}/action` — the generic command plane's
 * entry point.
 *
 * Three things only a route test can pin:
 *
 *  1. 🛑 **A benign vendor decline is a 200, not an error.** Tesla answers `not_charging` when
 *     you stop an already-idle charge. Every layer below returns that as data; the route must
 *     not "helpfully" upgrade it to a 4xx/5xx.
 *  2. 🛑 **`requireDeviceAccess(..., {requireWrite:true})` is the ONLY gate, and it runs before
 *     anything dispatches.** A `NextResponse` from it is passed straight through. Combined with
 *     this route's deliberate absence from `shareableRoutes`/`publicRoutes`, that is what makes
 *     "a share token never authorizes a write" true.
 *  3. **The confirmation re-poll fires on success and ONLY on success** — a decline changed
 *     nothing, so paying for a vendor read would be pure waste. (The web tier must never write
 *     KV itself; the re-poll is the sanctioned freshness path.)
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Point } from "@/lib/ids";

const POINT = Point.generate();
const POINT_UUID = Point.toUuid(POINT);

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/control/point-actions", () => ({
  loadPointByUuid: jest.fn(),
  dispatchPointAction: jest.fn(),
}));
jest.mock("@/lib/control/repoll", () => ({ scheduleRepoll: jest.fn() }));

import { requireDeviceAccess } from "@/lib/api-auth";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import {
  dispatchPointAction,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import { scheduleRepoll } from "@/lib/control/repoll";
import { POST } from "../points/[id]/action/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockLoad = jest.mocked(loadPointByUuid);
const mockDispatch = jest.mocked(dispatchPointAction);
const mockRepoll = jest.mocked(scheduleRepoll);

const device = {
  id: 10,
  vendorType: "tesla",
  ownerClerkUserId: "user_owner",
} as unknown as DeviceConfigView;
const pointRow = {
  id: POINT_UUID,
  deviceId: "019f0000-0000-7000-8000-0000000dev10",
  logicalPath: "ev.charge",
  metricType: "active",
  control: { kind: "switch" },
};

function call(body: unknown, id: string = POINT) {
  const request = new NextRequest("http://localhost/api/v4/points/x/action", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue({ point: pointRow as any, deviceRid: 10 });
  mockAuth.mockResolvedValue({
    userId: "user_owner",
    device: device as any,
    isOwner: true,
    canRead: true,
    canWrite: true,
  } as any);
  mockDispatch.mockResolvedValue({
    kind: "completed",
    ok: true,
    reason: null,
    commandId: "cmd-1",
  });
});

describe("resolution and authorization", () => {
  it("400s a malformed point id, without touching the DB", async () => {
    const res = await call({ action: "turn_on" }, "not-a-typeid");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid point id");
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("404s an unknown point", async () => {
    mockLoad.mockResolvedValue(null);
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Point not found" });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("🛑 passes an authorization response straight through and dispatches nothing", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Write access required" }, { status: 403 }),
    );
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("authorizes the point's DEVICE, requiring write", async () => {
    await call({ action: "turn_on" });
    expect(mockAuth.mock.calls[0][1]).toBe(10);
    expect(mockAuth.mock.calls[0][2]).toEqual({ requireWrite: true });
  });
});

describe("body validation", () => {
  it("400s an action outside the closed vocabulary", async () => {
    const res = await call({ action: "toggle" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid action");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("400s a missing action", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
  });

  it("400s a non-numeric value", async () => {
    const res = await call({ action: "set_value", value: "80" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "value must be a number" });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("outcome mapping", () => {
  it("passes the authenticated user through as the audit requester", async () => {
    await call({ action: "turn_on" });
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({
      point: pointRow,
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
  });

  it("'invalid' → 400", async () => {
    mockDispatch.mockResolvedValue({
      kind: "invalid",
      error: "Point is not controllable",
    });
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Point is not controllable" });
  });

  it("'unavailable' 501 → 501 (the no-Fleet-env case, which is dev's normal state)", async () => {
    mockDispatch.mockResolvedValue({
      kind: "unavailable",
      httpStatus: 501,
      error: "Tesla charge control requires Fleet API configuration",
    });
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(501);
  });

  it("'unavailable' 503 → 503 (unwakeable vehicle)", async () => {
    mockDispatch.mockResolvedValue({
      kind: "unavailable",
      httpStatus: 503,
      error: "Vehicle is asleep and did not wake up; try again shortly",
      commandId: "cmd-1",
    });
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(503);
  });

  it("'rejected' → 422 with the code", async () => {
    mockDispatch.mockResolvedValue({
      kind: "rejected",
      error: "This vehicle requires signed commands …",
      code: "vehicle_command_protocol_required",
      commandId: "cmd-1",
    });
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("vehicle_command_protocol_required");
  });

  it("'failed' → 500", async () => {
    mockDispatch.mockResolvedValue({
      kind: "failed",
      error: "socket hang up",
      commandId: "cmd-1",
    });
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(500);
  });

  it("success → 200 {ok:true} and schedules the confirmation re-poll", async () => {
    const res = await call({ action: "turn_on" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reason: null });
    expect(mockRepoll).toHaveBeenCalledWith(device);
  });

  it("🛑 a benign decline → 200 {ok:false, reason} and NO re-poll", async () => {
    mockDispatch.mockResolvedValue({
      kind: "completed",
      ok: false,
      reason: "not_charging",
      commandId: "cmd-1",
    });
    const res = await call({ action: "turn_off" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "not_charging" });
    expect(mockRepoll).not.toHaveBeenCalled();
  });
});
