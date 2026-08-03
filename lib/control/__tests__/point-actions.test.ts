/**
 * `dispatchPointAction` — the one path every command takes, and the one place the
 * `point_commands` audit row is written and completed.
 *
 * What is pinned here:
 *  - the audit row is written only for attempts we actually DISPATCH. A malformed request or a
 *    vendor with no control capability never reaches the vehicle, so it leaves no row; the
 *    trail is "what we asked the car to do", not "what someone typed".
 *  - the row is always COMPLETED in place, on every exit — a permanently `pending` row would
 *    be indistinguishable from a crashed dispatch.
 *  - the status vocabulary stays inside the column's CHECK (`pending|ok|rejected|failed`) and
 *    means what the schema says: `ok` = accepted, `rejected` = refused (benign decline OR
 *    protocol), `failed` = we could not complete the dispatch.
 *  - a benign decline lands in `vendor_result`, NOT in `error` — it is not a fault.
 *  - nothing throws out of here: PR-F's evaluator calls it from a cron tick.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { PointControl, PointRow } from "@/lib/db/planetscale/schema";

/** Rows handed to `insert().values()`, in order. */
let inserted: Record<string, unknown>[] = [];
/** Patches handed to `update().set()`, in order. */
let updates: Record<string, unknown>[] = [];

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({
    insert() {
      const chain = {
        values(row: Record<string, unknown>) {
          inserted.push(row);
          return chain;
        },
        async returning() {
          return [{ id: "cmd-0001" }];
        },
      };
      return chain;
    },
    update() {
      const chain = {
        set(patch: Record<string, unknown>) {
          updates.push(patch);
          return chain;
        },
        async where() {
          return undefined;
        },
      };
      return chain;
    },
  }),
}));

const invoke = jest.fn<(ctx: any) => Promise<{ ok: boolean; reason?: string }>>();
const getControlCapability = jest.fn<(v: string) => any>();
jest.mock("@/lib/vendors/registry", () => ({
  VendorRegistry: {
    getControlCapability: (v: string) => getControlCapability(v),
  },
}));

import { dispatchPointAction } from "../point-actions";
import { ControlDispatchError, ControlRejectedError } from "../errors";

const device = {
  id: 10,
  ownerClerkUserId: "user_owner",
  vendorType: "tesla",
} as unknown as DeviceConfigView;

function point(control: PointControl | null): PointRow {
  return {
    id: "019f0000-0000-7000-8000-00000000pt80",
    deviceId: "019f0000-0000-7000-8000-0000000dev10",
    logicalPath: "ev.charge.limit",
    metricType: "current",
    control,
  } as unknown as PointRow;
}

const AMPS = point({ kind: "number", min: 0, max: 48, step: 1 });
const SWITCH_POINT = point({ kind: "switch" });

beforeEach(() => {
  inserted = [];
  updates = [];
  invoke.mockReset();
  getControlCapability.mockReset();
  getControlCapability.mockReturnValue({ invoke });
});

describe("refusals that never reach the vendor", () => {
  it("returns 'invalid' and writes NO audit row when the point is not controllable", async () => {
    const outcome = await dispatchPointAction({
      point: point(null),
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
    expect(outcome).toEqual({
      kind: "invalid",
      error: "Point is not controllable",
    });
    expect(inserted).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns 'invalid' for a value outside the descriptor's range", async () => {
    const outcome = await dispatchPointAction({
      point: AMPS,
      device,
      action: "set_value",
      value: 64,
      requestedBy: "user_owner",
    });
    expect(outcome.kind).toBe("invalid");
    expect(inserted).toHaveLength(0);
  });

  it("returns 'unavailable' 501 when the vendor has no control capability", async () => {
    getControlCapability.mockReturnValue(null);
    const outcome = await dispatchPointAction({
      point: AMPS,
      device: { ...device, vendorType: "amber" } as DeviceConfigView,
      action: "set_value",
      value: 16,
      requestedBy: "user_owner",
    });
    expect(outcome).toEqual({
      kind: "unavailable",
      httpStatus: 501,
      error: "Vendor 'amber' does not support control",
    });
    expect(inserted).toHaveLength(0);
  });
});

describe("the audit row", () => {
  it("records the point, device, action, value and requester", async () => {
    invoke.mockResolvedValue({ ok: true });
    await dispatchPointAction({
      point: AMPS,
      device,
      action: "set_value",
      value: 16,
      requestedBy: "automation:au_01j9",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      pointId: AMPS.id,
      deviceId: AMPS.deviceId,
      action: "set_value",
      value: 16,
      requestedBy: "automation:au_01j9",
      status: "pending",
    });
  });

  it("stores NULL for a valueless action", async () => {
    invoke.mockResolvedValue({ ok: true });
    await dispatchPointAction({
      point: SWITCH_POINT,
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
    expect(inserted[0].value).toBeNull();
  });
});

describe("completion", () => {
  it("marks a vendor acceptance 'ok'", async () => {
    invoke.mockResolvedValue({ ok: true });
    const outcome = await dispatchPointAction({
      point: SWITCH_POINT,
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
    expect(outcome).toEqual({
      kind: "completed",
      ok: true,
      reason: null,
      commandId: "cmd-0001",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "ok",
      vendorResult: { result: true, reason: "" },
      error: null,
    });
    expect(updates[0].completedAt).toBeInstanceOf(Date);
  });

  it("🛑 marks a BENIGN decline 'rejected' and still COMPLETES — the caller answers 200", async () => {
    invoke.mockResolvedValue({ ok: false, reason: "not_charging" });
    const outcome = await dispatchPointAction({
      point: SWITCH_POINT,
      device,
      action: "turn_off",
      requestedBy: "user_owner",
    });
    expect(outcome).toEqual({
      kind: "completed",
      ok: false,
      reason: "not_charging",
      commandId: "cmd-0001",
    });
    // A decline is data, not a fault: it belongs in vendor_result, not in `error`.
    expect(updates[0]).toMatchObject({
      status: "rejected",
      vendorResult: { result: false, reason: "not_charging" },
      error: null,
    });
  });

  it("maps ControlRejectedError to 'rejected' with its code", async () => {
    invoke.mockRejectedValue(
      new ControlRejectedError(
        "This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.",
        "vehicle_command_protocol_required",
      ),
    );
    const outcome = await dispatchPointAction({
      point: SWITCH_POINT,
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      code: "vehicle_command_protocol_required",
      commandId: "cmd-0001",
    });
    expect(updates[0]).toMatchObject({ status: "rejected" });
    expect(updates[0].error).toContain("signed commands");
  });

  it("maps ControlDispatchError to 'unavailable' carrying its HTTP status", async () => {
    invoke.mockRejectedValue(
      new ControlDispatchError(
        "Vehicle is asleep and did not wake up; try again shortly",
        503,
      ),
    );
    const outcome = await dispatchPointAction({
      point: SWITCH_POINT,
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
    expect(outcome).toMatchObject({
      kind: "unavailable",
      httpStatus: 503,
      error: "Vehicle is asleep and did not wake up; try again shortly",
      commandId: "cmd-0001",
    });
    expect(updates[0]).toMatchObject({ status: "failed" });
  });

  it("maps an unexpected error to 'failed' rather than throwing", async () => {
    invoke.mockRejectedValue(new Error("socket hang up"));
    const outcome = await dispatchPointAction({
      point: SWITCH_POINT,
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
    expect(outcome).toEqual({
      kind: "failed",
      error: "socket hang up",
      commandId: "cmd-0001",
    });
    expect(updates[0]).toMatchObject({
      status: "failed",
      error: "socket hang up",
    });
  });

  it("only ever writes statuses inside the column's CHECK vocabulary", async () => {
    const allowed = new Set(["pending", "ok", "rejected", "failed"]);
    invoke.mockResolvedValue({ ok: true });
    await dispatchPointAction({
      point: SWITCH_POINT,
      device,
      action: "turn_on",
      requestedBy: "user_owner",
    });
    for (const row of [...inserted, ...updates]) {
      expect(allowed.has(String(row.status))).toBe(true);
    }
  });
});

describe("the capability call", () => {
  it("passes the device, point, action and value through untouched", async () => {
    invoke.mockResolvedValue({ ok: true });
    await dispatchPointAction({
      point: AMPS,
      device,
      action: "set_value",
      value: 16,
      requestedBy: "user_owner",
    });
    expect(invoke).toHaveBeenCalledWith({
      device,
      point: AMPS,
      action: "set_value",
      value: 16,
    });
    // 🛑 No requester is passed: credentials come from the device owner, so an automation with
    // no session user dispatches exactly the way a request does.
    expect(Object.keys(invoke.mock.calls[0][0])).not.toContain("requestedBy");
  });
});
