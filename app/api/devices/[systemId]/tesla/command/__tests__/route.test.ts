/**
 * The legacy Tesla command route, now a SHIM over the generic command plane.
 *
 * This file exists for one reason: the route's external contract is frozen while
 * `components/TeslaControlDialog.tsx` still calls it, and the rewrite moved every behaviour it
 * used to implement inline (env check, owner credentials, wake dance, protocol refusal) into
 * `lib/control` + the Tesla capability. So the contract has to be pinned HERE, at the wire,
 * where the dialog sees it — status codes, body shapes and the exact legacy message strings.
 *
 * The two shapes the dialog actually reads:
 *   ok      → `{ success, command, reason }`   (`success:false` + reason = a benign decline)
 *   not ok  → `{ error }`  (+ `code` on the 422 signed-commands case)
 *
 * The one deliberate narrowing is called out in its own case below: amps > 48 now 400s at the
 * descriptor instead of being sent and clamped by the car.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/control/point-actions", () => ({
  loadPointByStemMetric: jest.fn(),
  dispatchPointAction: jest.fn(),
}));
jest.mock("@/lib/control/repoll", () => ({ scheduleRepoll: jest.fn() }));

import { requireDeviceAccess } from "@/lib/api-auth";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import {
  dispatchPointAction,
  loadPointByStemMetric,
} from "@/lib/control/point-actions";
import { scheduleRepoll } from "@/lib/control/repoll";
import { POST } from "../route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockLoad = jest.mocked(loadPointByStemMetric);
const mockDispatch = jest.mocked(dispatchPointAction);
const mockRepoll = jest.mocked(scheduleRepoll);

const device = {
  id: 10,
  vendorType: "tesla",
  ownerClerkUserId: "user_owner",
} as unknown as DeviceConfigView;
const pointRow = {
  id: "019f0000-0000-7000-8000-00000000pt78",
  deviceId: "019f0000-0000-7000-8000-0000000dev10",
  logicalPath: "ev.charge",
  metricType: "active",
  control: { kind: "switch" },
};

function call(body: unknown, systemId = "10") {
  const request = new NextRequest(
    "http://localhost/api/devices/10/tesla/command",
    { method: "POST", body: JSON.stringify(body) },
  );
  return POST(request, { params: Promise.resolve({ systemId }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    userId: "user_owner",
    device: device as any,
    isOwner: true,
    canRead: true,
    canWrite: true,
  } as any);
  mockLoad.mockResolvedValue(pointRow as any);
  mockDispatch.mockResolvedValue({
    kind: "completed",
    ok: true,
    reason: null,
    commandId: "cmd-1",
  });
});

describe("guards (unchanged from the pre-shim route)", () => {
  it("400s a non-numeric system id", async () => {
    const res = await call({ command: "charge_start" }, "abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid system ID" });
  });

  it("passes an authorization response through", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Write access required" }, { status: 403 }),
    );
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("400s a non-Tesla device", async () => {
    mockAuth.mockResolvedValue({
      userId: "u",
      device: { ...device, vendorType: "amber" } as any,
      isOwner: true,
      canRead: true,
      canWrite: true,
    } as any);
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "System is not a Tesla system" });
  });
});

describe("legacy body validation — exact messages", () => {
  it("400s an unknown or missing command", async () => {
    for (const body of [{}, { command: "open_frunk" }]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "Invalid command. Expected one of: charge_start, charge_stop, set_charge_limit, set_charging_amps",
      );
    }
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("400s set_charge_limit with a missing / out-of-band percent", async () => {
    for (const body of [
      { command: "set_charge_limit" },
      { command: "set_charge_limit", percent: 49 },
      { command: "set_charge_limit", percent: 101 },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "set_charge_limit requires percent (50–100)",
      );
    }
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("400s set_charging_amps with a missing / negative amps", async () => {
    for (const body of [
      { command: "set_charging_amps" },
      { command: "set_charging_amps", amps: -1 },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "set_charging_amps requires amps (>= 0)",
      );
    }
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("legacy command → point action", () => {
  const cases: Array<
    [Record<string, unknown>, string, string, string, number | undefined]
  > = [
    [{ command: "charge_start" }, "ev.charge", "active", "turn_on", undefined],
    [{ command: "charge_stop" }, "ev.charge", "active", "turn_off", undefined],
    [
      { command: "set_charge_limit", percent: 80 },
      "ev.charge.limit",
      "soc",
      "set_value",
      80,
    ],
    [
      { command: "set_charging_amps", amps: 16 },
      "ev.charge.limit",
      "current",
      "set_value",
      16,
    ],
  ];

  for (const [body, stem, metric, action, value] of cases) {
    it(`${body.command} → ${stem}/${metric} ${action}`, async () => {
      await call(body);
      expect(mockLoad).toHaveBeenCalledWith(10, stem, metric);
      expect(mockDispatch.mock.calls[0][0]).toMatchObject({
        point: pointRow,
        device,
        action,
        value,
        requestedBy: "user_owner",
      });
    });
  }

  it("404s when the device has no such point yet (never polled since it existed)", async () => {
    mockLoad.mockResolvedValue(null);
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Charge-control point not found for this system",
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("outcome → legacy wire shape", () => {
  it("success → 200 {success:true, command, reason:null} and a confirmation re-poll", async () => {
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      command: "charge_start",
      reason: null,
    });
    expect(mockRepoll).toHaveBeenCalledWith(device);
  });

  it("🛑 a benign decline → 200 {success:false, reason} — NOT a 500", async () => {
    mockDispatch.mockResolvedValue({
      kind: "completed",
      ok: false,
      reason: "not_charging",
      commandId: "cmd-1",
    });
    const res = await call({ command: "charge_stop" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: false,
      command: "charge_stop",
      reason: "not_charging",
    });
    expect(mockRepoll).not.toHaveBeenCalled();
  });

  it("🛑 a protocol refusal → 422 vehicle_command_protocol_required", async () => {
    mockDispatch.mockResolvedValue({
      kind: "rejected",
      error:
        "This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.",
      code: "vehicle_command_protocol_required",
      commandId: "cmd-1",
    });
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error:
        "This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.",
      code: "vehicle_command_protocol_required",
    });
  });

  it("no Fleet API config → 501 with the legacy message", async () => {
    mockDispatch.mockResolvedValue({
      kind: "unavailable",
      httpStatus: 501,
      error: "Tesla charge control requires Fleet API configuration",
      commandId: "cmd-1",
    });
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "Tesla charge control requires Fleet API configuration",
    });
  });

  it("unwakeable vehicle → 503 with the legacy message", async () => {
    mockDispatch.mockResolvedValue({
      kind: "unavailable",
      httpStatus: 503,
      error: "Vehicle is asleep and did not wake up; try again shortly",
      commandId: "cmd-1",
    });
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(
      "Vehicle is asleep and did not wake up; try again shortly",
    );
  });

  it("vehicle missing → 404 with the legacy message", async () => {
    mockDispatch.mockResolvedValue({
      kind: "unavailable",
      httpStatus: 404,
      error: "Vehicle 12345 not found",
      commandId: "cmd-1",
    });
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Vehicle 12345 not found");
  });

  it("device without an owner → 400 with the legacy message", async () => {
    mockDispatch.mockResolvedValue({
      kind: "unavailable",
      httpStatus: 400,
      error: "System has no owner",
      commandId: "cmd-1",
    });
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("System has no owner");
  });

  it("unexpected failure → 500 {error}", async () => {
    mockDispatch.mockResolvedValue({
      kind: "failed",
      error: "socket hang up",
      commandId: "cmd-1",
    });
    const res = await call({ command: "charge_start" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "socket hang up" });
  });

  it("documented NARROWING: amps above the descriptor's 48 A ceiling now 400s", async () => {
    // Legacy accepted any amps >= 0 and let the car clamp. The control descriptor caps at 48,
    // which the only caller's UI already does, so the change is invisible in practice — but it
    // IS a change, and this is where it is recorded.
    mockDispatch.mockResolvedValue({
      kind: "invalid",
      error: "Value 64 is out of range (0–48)",
    });
    const res = await call({ command: "set_charging_amps", amps: 64 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("out of range");
  });
});
