/**
 * ROUTE-level tests for `POST /api/v4/points/{pt_…}/preflight` — the command plane's READ-ONLY
 * sibling, and the thing the generator dialog gates its Start button on.
 *
 * What only a route test can pin here:
 *
 *  1. 🛑 **It is owner-gated exactly like a command**, even though it writes nothing. It spends a
 *     round trip to someone's hardware, so it is `requireDeviceAccess(..., {requireOwner:true})` —
 *     the same rule as the sibling `../refresh` route — and combined with its deliberate absence
 *     from `shareableRoutes`/`publicRoutes` that is what stops a share-token viewer interrogating
 *     someone's generator.
 *  2. 🛑 **It never writes an audit row and never dispatches.** `point_commands` records commands;
 *     filling it with probes would bury the presses. The route does not import
 *     `dispatchPointAction` at all, which is asserted structurally below.
 *  3. **A vendor without a preflight gets 501**, not a fabricated "looks fine" — the honest answer
 *     for hardware that cannot be asked without being poked.
 *  4. **A capability's own bad news (`ok:false`) is a 200.** "The hub could not read the
 *     controller" is the ANSWER the caller asked for, not an error; upgrading it to a 5xx would
 *     make the dialog show a red box instead of the diagnosis.
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
jest.mock("@/lib/vendors/registry", () => ({
  VendorRegistry: { getControlCapability: jest.fn() },
}));

import { requireDeviceAccess } from "@/lib/api-auth";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import {
  dispatchPointAction,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import { VendorRegistry } from "@/lib/vendors/registry";
import { ControlDispatchError } from "@/lib/control/errors";
import { POST } from "../points/[id]/preflight/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockLoad = jest.mocked(loadPointByUuid);
const mockDispatch = jest.mocked(dispatchPointAction);
const mockGetCapability = jest.mocked(VendorRegistry.getControlCapability);

const device = {
  id: 14,
  vendorType: "deepsea",
  ownerClerkUserId: "user_owner",
} as unknown as DeviceConfigView;
const pointRow = {
  id: POINT_UUID,
  deviceId: "019f0000-0000-7000-8000-0000000dev14",
  logicalPath: "source.generator.control.request",
  metricType: "duration",
  control: { kind: "number", min: 0, max: 120, step: 5 },
};

const OK_RESULT = {
  ok: true,
  wouldProceed: true,
  verdict: "Ready to start",
  checks: [{ label: "Panel mode", value: "Auto", ok: true }],
  detail: { maxRuntimeSec: 7200 },
};

let preflight: jest.Mock<(ctx: unknown) => Promise<unknown>>;

function call(body?: unknown, id: string = POINT) {
  const request = new NextRequest(
    "http://localhost/api/v4/points/x/preflight",
    {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  preflight = jest.fn<(ctx: unknown) => Promise<unknown>>();
  preflight.mockResolvedValue(OK_RESULT);
  mockLoad.mockResolvedValue({ point: pointRow as any, deviceRid: 14 });
  mockAuth.mockResolvedValue({
    userId: "user_owner",
    device: device as any,
    isOwner: true,
    canRead: true,
    canWrite: true,
  } as any);
  mockGetCapability.mockReturnValue({
    invoke: jest.fn(),
    preflight,
  } as never);
});

describe("resolution and authorization", () => {
  it("400s a malformed point id, without touching the DB", async () => {
    const res = await call({}, "not-a-point-id");
    expect(res.status).toBe(400);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s an unknown point", async () => {
    mockLoad.mockResolvedValue(null);
    expect((await call({})).status).toBe(404);
  });

  it("🛑 demands OWNERSHIP — a probe spends a round trip to someone's hardware", async () => {
    await call({});
    expect(mockAuth).toHaveBeenCalledWith(expect.anything(), 14, {
      requireOwner: true,
    });
  });

  it("passes an auth rejection straight through, before any probe", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    );
    expect((await call({})).status).toBe(403);
    expect(preflight).not.toHaveBeenCalled();
  });
});

describe("the probe", () => {
  it("returns the capability's answer unchanged", async () => {
    const res = await call({ value: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_RESULT);
  });

  it("forwards the value the caller is CONSIDERING, so the verdict is about that command", async () => {
    await call({ value: 30 });
    expect(preflight).toHaveBeenCalledWith({
      device,
      point: pointRow,
      value: 30,
    });
  });

  it("accepts an empty body and asks about the vendor's default", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(preflight).toHaveBeenCalledWith({
      device,
      point: pointRow,
      value: undefined,
    });
  });

  it("400s a non-numeric value rather than passing it to a vendor", async () => {
    const res = await call({ value: "30" });
    expect(res.status).toBe(400);
    expect(preflight).not.toHaveBeenCalled();
  });

  it("400s a malformed JSON body", async () => {
    const request = new NextRequest(
      "http://localhost/api/v4/points/x/preflight",
      { method: "POST", body: "{" },
    );
    const res = await POST(request, {
      params: Promise.resolve({ id: POINT }),
    });
    expect(res.status).toBe(400);
  });

  it("🛑 answers 200 for the capability's own bad news — it is the answer, not an error", async () => {
    preflight.mockResolvedValue({
      ok: false,
      verdict:
        "The hub could not read the controller: timeout — a run would be refused too.",
    });
    const res = await call({});
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });

  it("501s a vendor that has no preflight — no fabricated 'looks fine'", async () => {
    mockGetCapability.mockReturnValue({ invoke: jest.fn() } as never);
    const res = await call({});
    expect(res.status).toBe(501);
  });

  it("501s a vendor with no control capability at all", async () => {
    mockGetCapability.mockReturnValue(null);
    expect((await call({})).status).toBe(501);
  });

  it("maps a ControlDispatchError to its own status (a config bug, not a state report)", async () => {
    preflight.mockRejectedValue(
      new ControlDispatchError("This generator has no control passkey", 501),
    );
    const res = await call({});
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/no control passkey/);
  });

  it("500s an unexpected failure", async () => {
    preflight.mockRejectedValue(new Error("boom"));
    expect((await call({})).status).toBe(500);
  });
});

describe("it is a read, not a command", () => {
  it("🛑 never dispatches, so no `point_commands` row is ever written for a probe", async () => {
    await call({ value: 30 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
