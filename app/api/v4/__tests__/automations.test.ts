/**
 * ROUTE-level tests for `/api/v4/automations` and `/api/v4/automations/{au_…}`.
 *
 * The things only a route test can pin:
 *
 *  1. 🛑 **An automation is a DEFERRED action call.** At fire time the evaluator dispatches with
 *     the DEVICE OWNER's credentials and no session user at all, so creation must clear the same
 *     firewalls the synchronous action route does. Without the
 *     `requireDeviceAccess(..., {requireOwner:true})` on the ACTION point, owning — or merely
 *     ADMINISTERING — any area at all would let a caller aim a `turn_off` at someone else's car and
 *     have us execute it for them, on that owner's vendor credentials. Ownership, not write access:
 *     the area gate and `requireWrite` both admit admins, and the control plane does not.
 *  2. 🛑 **PATCH `{enabled:true}` on a disabled row resets the arming state.** A standing
 *     point-source rule disabled mid-session and re-enabled during a LATER session would otherwise
 *     evaluate armed+active against a weeks-old `armed_at` — the minutes leg fires instantly, a
 *     spurious `turn_off` at the start of the new session — against a `baselineKwh` from a
 *     different cable session. And the idempotent twin: a SAME-VALUE `enabled` write must reset
 *     nothing, or PR-G's toggle re-sending the current value wipes a live baseline.
 *  3. **An unauthorized `au_` id 404s, not 403s.** There is no area in the URL, so "unknown" and
 *     "not yours" must be indistinguishable or the route is an oracle for which ids exist.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Area, Automation, Derivation, Point } from "@/lib/ids";

const AREA = Area.generate();
const AREA_UUID = Area.toUuid(AREA);
const OTHER_AREA_UUID = Area.toUuid(Area.generate());
const DX = Derivation.generate();
const DX_UUID = Derivation.toUuid(DX);
const SRC_PT = Point.generate();
const SRC_PT_UUID = Point.toUuid(SRC_PT);
const ACT_PT = Point.generate();
const ACT_PT_UUID = Point.toUuid(ACT_PT);
const AU = Automation.generate();
const AU_UUID = Automation.toUuid(AU);

jest.mock("@/lib/api-auth", () => ({
  requireAuth: jest.fn(),
  requireDeviceAccess: jest.fn(),
}));
jest.mock("@/lib/areas/http", () => ({
  loadAreaForOwner: jest.fn(),
  loadAreaForAuth: jest.fn(),
}));
jest.mock("@/lib/control/point-actions", () => ({
  loadPointByUuid: jest.fn(),
  loadPointByStemMetric: jest.fn(),
}));
jest.mock("@/lib/automations/store", () => ({
  listForArea: jest.fn(),
  getById: jest.fn(),
  create: jest.fn(),
  patch: jest.fn(),
  remove: jest.fn(),
  derivationBelongsToArea: jest.fn(),
}));

import { requireAuth, requireDeviceAccess } from "@/lib/api-auth";
import { loadAreaForAuth, loadAreaForOwner } from "@/lib/areas/http";
import {
  loadPointByStemMetric,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import * as store from "@/lib/automations/store";
import type { AutomationRow } from "@/lib/db/planetscale/schema";
import { GET, POST } from "../automations/route";
import { DELETE, PATCH } from "../automations/[id]/route";

const mockAuth = jest.mocked(requireAuth);
const mockDeviceAccess = jest.mocked(requireDeviceAccess);
const mockAreaOwner = jest.mocked(loadAreaForOwner);
const mockAreaAuth = jest.mocked(loadAreaForAuth);
const mockLoadPoint = jest.mocked(loadPointByUuid);
const mockSibling = jest.mocked(loadPointByStemMetric);
const mockStore = jest.mocked(store);

const OWNER = "user_owner";

type AccessOpts = { requireWrite?: boolean; requireOwner?: boolean };

/** Stands in for `requireDeviceAccess` when the caller can read but owns nothing. */
const refuseUnlessOwner = (async (
  _req: unknown,
  _rid: number,
  opts?: AccessOpts,
) =>
  opts?.requireOwner
    ? NextResponse.json(
        { error: "Only the device owner can control this device" },
        { status: 403 },
      )
    : opts?.requireWrite
      ? NextResponse.json({ error: "Write access required" }, { status: 403 })
      : ({ canWrite: false } as never)) as never;

/**
 * A non-owner ADMIN: passes every config-write gate (`requireWrite`), fails the control gate.
 * If the action-point check ever slips back to `requireWrite`, this mock lets it through and the
 * tests using it go red.
 */
const adminNotOwner = (async (_req: unknown, _rid: number, opts?: AccessOpts) =>
  opts?.requireOwner
    ? NextResponse.json(
        { error: "Only the device owner can control this device" },
        { status: 403 },
      )
    : ({ canWrite: true, isAdmin: true } as never)) as never;

function row(over: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: AU_UUID,
    areaId: AREA_UUID,
    name: "Charge limit",
    enabled: true,
    mode: "standing",
    trigger: {
      kind: "charge-session",
      source: { kind: "point", pointId: SRC_PT_UUID },
      afterKwh: 20,
    },
    action: {
      kind: "point-action",
      pointId: ACT_PT_UUID,
      action: "turn_off",
    },
    armedAt: null,
    lastTriggeredAt: null,
    lastTriggeredRunStart: null,
    armedContext: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as AutomationRow;
}

const pointTrigger = {
  kind: "charge-session",
  source: { kind: "point", pointId: SRC_PT },
  afterKwh: 20,
};
const derivTrigger = {
  kind: "charge-session",
  source: { kind: "derivation", derivationId: DX },
  afterMinutes: 60,
};
const action = { kind: "point-action", pointId: ACT_PT, action: "turn_off" };

function get(url: string) {
  return GET(new NextRequest(url));
}
function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v4/automations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
function patch(body: unknown, id: string = AU) {
  return PATCH(
    new NextRequest("http://localhost/api/v4/automations/x", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
function del(id: string = AU) {
  return DELETE(
    new NextRequest("http://localhost/api/v4/automations/x", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: OWNER, isAdmin: false } as never);
  mockAreaOwner.mockResolvedValue({
    userId: OWNER,
    isAdmin: false,
    area: { id: AREA_UUID, ownerClerkUserId: OWNER },
  } as never);
  mockAreaAuth.mockResolvedValue({
    id: AREA_UUID,
    ownerClerkUserId: OWNER,
  } as never);
  mockDeviceAccess.mockResolvedValue({ canWrite: true } as never);
  mockLoadPoint.mockImplementation(async (uuid: string) => ({
    point: {
      id: uuid,
      logicalPath: "ev.charge",
      metricType: uuid === SRC_PT_UUID ? "added" : "active",
      unit: uuid === SRC_PT_UUID ? "kWh" : null,
    },
    deviceRid: 10,
  }) as never);
  mockSibling.mockResolvedValue({ id: "sibling" } as never);
  mockStore.derivationBelongsToArea.mockResolvedValue(true);
  mockStore.listForArea.mockResolvedValue([]);
  mockStore.getById.mockResolvedValue(row());
  mockStore.create.mockImplementation(async (v) => row(v as never));
  mockStore.patch.mockImplementation(async (_uuid, fields) =>
    row(fields as never),
  );
  mockStore.remove.mockResolvedValue(true);
});

describe("GET /api/v4/automations", () => {
  it("requires ?area — a cross-area listing is a later PR's call to ask for", async () => {
    const res = await get("http://localhost/api/v4/automations");
    expect(res.status).toBe(422);
    expect(mockStore.listForArea).not.toHaveBeenCalled();
  });

  it("passes a loader failure through verbatim", async () => {
    for (const status of [400, 403, 404]) {
      mockAreaOwner.mockResolvedValueOnce({
        error: NextResponse.json({ error: "nope" }, { status }),
      } as never);
      const res = await get(`http://localhost/api/v4/automations?area=${AREA}`);
      expect(res.status).toBe(status);
    }
    expect(mockStore.listForArea).not.toHaveBeenCalled();
  });

  it("lists the area's automations, wire-encoded", async () => {
    mockStore.listForArea.mockResolvedValue([row()]);
    const res = await get(`http://localhost/api/v4/automations?area=${AREA}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockStore.listForArea).toHaveBeenCalledWith(AREA_UUID);
    expect(body.automations[0].id).toBe(AU);
    expect(body.automations[0].areaId).toBe(AREA);
    expect(body.automations[0].trigger.source.pointId).toBe(SRC_PT);
  });
});

describe("POST /api/v4/automations", () => {
  const good = { areaId: AREA, mode: "once", trigger: pointTrigger, action };

  it("creates with raw uuids below the seam and a default name", async () => {
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(mockStore.create).toHaveBeenCalledWith({
      areaId: AREA_UUID,
      name: "Charge limit",
      mode: "once",
      trigger: {
        kind: "charge-session",
        source: { kind: "point", pointId: SRC_PT_UUID },
        afterKwh: 20,
      },
      action: {
        kind: "point-action",
        pointId: ACT_PT_UUID,
        action: "turn_off",
      },
      enabled: undefined,
    });
    const body = await res.json();
    expect(body.automation.areaId).toBe(AREA);
  });

  it("passes the area loader's failure through verbatim", async () => {
    mockAreaOwner.mockResolvedValueOnce({
      error: NextResponse.json({ error: "nope" }, { status: 403 }),
    } as never);
    const res = await post(good);
    expect(res.status).toBe(403);
    expect(mockStore.create).not.toHaveBeenCalled();
  });

  it("422s a bad mode", async () => {
    const res = await post({ ...good, mode: "forever" });
    expect(res.status).toBe(422);
    expect(mockStore.create).not.toHaveBeenCalled();
  });

  it("422s a non-boolean `enabled` before paying for the reference lookups", async () => {
    // Every shape check runs before `checkReferences`, so a malformed body costs no point or
    // device reads on its way to the 422.
    const res = await post({ ...good, enabled: "yes" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("enabled must be a boolean");
    expect(mockLoadPoint).not.toHaveBeenCalled();
    expect(mockDeviceAccess).not.toHaveBeenCalled();
    expect(mockStore.create).not.toHaveBeenCalled();
  });

  it("surfaces the vocabulary parse error verbatim", async () => {
    const res = await post({
      ...good,
      trigger: { ...pointTrigger, afterKwh: -1 },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(
      "trigger.afterKwh must be greater than 0",
    );
  });

  it("422s an action other than turn_off", async () => {
    const res = await post({ ...good, action: { ...action, action: "turn_on" } });
    expect(res.status).toBe(422);
    expect(mockStore.create).not.toHaveBeenCalled();
  });

  it("422s a derivation from another area", async () => {
    // Same-area scoping is what makes the area-owner check cover the trigger; without it, owning
    // any area would let a caller follow any derivation by id.
    mockStore.derivationBelongsToArea.mockResolvedValue(false);
    const res = await post({ ...good, trigger: derivTrigger });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(
      "trigger derivation must belong to this area",
    );
  });

  it("accepts a derivation trigger in this area (the EV case: cross-device action)", async () => {
    const res = await post({ ...good, trigger: derivTrigger });
    expect(res.status).toBe(201);
    expect(mockStore.derivationBelongsToArea).toHaveBeenCalledWith(
      DX_UUID,
      AREA_UUID,
    );
  });

  it("422s an unknown source point", async () => {
    mockLoadPoint.mockResolvedValueOnce(null);
    const res = await post(good);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("trigger source point not found");
  });

  it("422s an unknown action point", async () => {
    mockLoadPoint
      .mockResolvedValueOnce({
        point: { id: SRC_PT_UUID, logicalPath: "ev.charge", unit: "kWh" },
        deviceRid: 10,
      } as never)
      .mockResolvedValueOnce(null);
    const res = await post(good);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("action point not found");
  });

  it("422s a source point with no `active` sibling to signal the session", async () => {
    mockSibling.mockResolvedValue(null);
    const res = await post(good);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("ev.charge/active sibling");
  });

  it("422s afterKwh against a non-kWh point (the unit trap gets no second life)", async () => {
    mockLoadPoint.mockImplementation(async (uuid: string) => ({
      point: { id: uuid, logicalPath: "ev.charge", unit: "W" },
      deviceRid: 10,
    }) as never);
    const res = await post(good);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("afterKwh requires a kWh");
  });

  it("🛑 403s when the caller does not OWN the action point's device", async () => {
    mockDeviceAccess.mockImplementation(refuseUnlessOwner);
    const res = await post(good);
    expect(res.status).toBe(403);
    expect(mockStore.create).not.toHaveBeenCalled();
  });

  it("🛑 403s a non-owner ADMIN — a deferred command is still a command", async () => {
    // The gap this closes: `loadAreaForOwner` admits an admin, and `requireWrite` (owner OR admin)
    // admitted one too — so an admin could park a `turn_off` on someone else's car and have the
    // cron dispatch it on THAT OWNER's Tesla tokens. The action point must be gated on ownership.
    mockDeviceAccess.mockImplementation(adminNotOwner);
    const res = await post(good);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the device owner can control this device",
    );
    expect(mockStore.create).not.toHaveBeenCalled();
  });

  it("gates the ACTION point on ownership and the TRIGGER point on read only", async () => {
    // Discriminates the fix from "requireWrite everywhere": the trigger source may be a point on a
    // device you merely read (the EV cross-device case); only the thing being COMMANDED needs you
    // to own it.
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(mockDeviceAccess).toHaveBeenCalledWith(expect.anything(), 10, {
      requireOwner: true,
    });
    expect(mockDeviceAccess).toHaveBeenCalledWith(expect.anything(), 10);
  });
});

describe("PATCH /api/v4/automations/{id}", () => {
  it("400s a malformed id", async () => {
    const res = await patch({ name: "x" }, "au_nonsense");
    expect(res.status).toBe(400);
  });

  it("404s an unknown id", async () => {
    mockStore.getById.mockResolvedValue(null);
    expect((await patch({ name: "x" })).status).toBe(404);
  });

  it("🛑 404s (not 403s) when the area predicate fails", async () => {
    mockAreaAuth.mockResolvedValue({
      id: AREA_UUID,
      ownerClerkUserId: "user_someone_else",
    } as never);
    const res = await patch({ name: "x" });
    expect(res.status).toBe(404);
    expect(mockStore.patch).not.toHaveBeenCalled();
  });

  it("422s a present areaId — moving one is delete + recreate", async () => {
    expect((await patch({ areaId: Area.generate() })).status).toBe(422);
  });

  it("422s an empty patch", async () => {
    expect((await patch({})).status).toBe(422);
  });

  it("patches name and mode", async () => {
    const res = await patch({ name: "Overnight cap", mode: "once" });
    expect(res.status).toBe(200);
    expect(mockStore.patch).toHaveBeenCalledWith(AU_UUID, {
      name: "Overnight cap",
      mode: "once",
    });
  });

  it("a trigger replace clears the whole arming state", async () => {
    // A baseline snapshotted against the OLD source is meaningless against the new one, and a
    // stale anchor could suppress the first fire outright.
    const res = await patch({ trigger: derivTrigger });
    expect(res.status).toBe(200);
    expect(mockStore.patch).toHaveBeenCalledWith(AU_UUID, {
      trigger: {
        kind: "charge-session",
        source: { kind: "derivation", derivationId: DX_UUID },
        afterMinutes: 60,
      },
      armedAt: null,
      armedContext: null,
      lastTriggeredRunStart: null,
    });
  });

  it("an action replace re-checks OWNERSHIP", async () => {
    mockDeviceAccess.mockImplementation(refuseUnlessOwner);
    const res = await patch({ action });
    expect(res.status).toBe(403);
    expect(mockStore.patch).not.toHaveBeenCalled();
  });

  it("🛑 a non-owner ADMIN cannot re-point an automation at a device they don't own", async () => {
    mockDeviceAccess.mockImplementation(adminNotOwner);
    const res = await patch({ action });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the device owner can control this device",
    );
    expect(mockStore.patch).not.toHaveBeenCalled();
  });

  it("🛑 re-enabling a disabled row resets armedAt/armedContext but KEEPS lastTriggeredRunStart", async () => {
    mockStore.getById.mockResolvedValue(
      row({
        enabled: false,
        armedAt: new Date("2026-07-01T00:00:00Z"),
        armedContext: { baselineKwh: 42.5, baselineAt: 1 },
        lastTriggeredRunStart: new Date("2026-07-01T00:30:00Z"),
      }),
    );
    const res = await patch({ enabled: true });
    expect(res.status).toBe(200);
    // The exact field set: a stale `armedAt` would fire the minutes leg instantly on the NEXT
    // session, while keeping `lastTriggeredRunStart` preserves same-run suppression for a
    // derivation source re-enabled mid-run.
    expect(mockStore.patch).toHaveBeenCalledWith(AU_UUID, {
      enabled: true,
      armedAt: null,
      armedContext: null,
    });
  });

  it("🛑 a SAME-VALUE enabled write resets nothing (an idempotent UI toggle keeps the baseline)", async () => {
    mockStore.getById.mockResolvedValue(
      row({
        enabled: true,
        armedAt: new Date("2026-08-03T10:00:00Z"),
        armedContext: { baselineKwh: 42.5, baselineAt: 1 },
      }),
    );
    const res = await patch({ enabled: true });
    expect(res.status).toBe(200);
    expect(mockStore.patch).toHaveBeenCalledWith(AU_UUID, { enabled: true });
  });

  it("disabling an enabled row also clears the arming state", async () => {
    mockStore.getById.mockResolvedValue(row({ enabled: true }));
    await patch({ enabled: false });
    expect(mockStore.patch).toHaveBeenCalledWith(AU_UUID, {
      enabled: false,
      armedAt: null,
      armedContext: null,
    });
  });
});

describe("DELETE /api/v4/automations/{id}", () => {
  it("hard-deletes", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockStore.remove).toHaveBeenCalledWith(AU_UUID);
  });

  it("404s an unknown id", async () => {
    mockStore.getById.mockResolvedValue(null);
    expect((await del()).status).toBe(404);
    expect(mockStore.remove).not.toHaveBeenCalled();
  });
});
