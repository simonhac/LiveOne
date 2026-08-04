/**
 * 🛑 **Only the device OWNER may command a device** — proved at the WIRE, on EVERY route that can
 * reach `dispatchPointAction`: the v4 action route, the legacy Tesla shim, and automation creation
 * (a command with a delay).
 *
 * Unlike the per-route suites (`app/api/v4/__tests__/point-action.test.ts`,
 * `app/api/devices/[systemId]/tesla/command/__tests__/route.test.ts`), `@/lib/api-auth` is NOT
 * mocked here: Clerk, the admin check and the device registry are, and the real
 * `requireDeviceAccess` runs. That is what makes these cases discriminate — a route that forgot
 * `requireOwner`, or a helper that stopped enforcing it, goes red here and nowhere else.
 *
 * The legacy shim is tested identically and deliberately: it must not be a way around the rule.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest } from "next/server";
import { Area, Automation, Derivation, Point } from "@/lib/ids";

const POINT = Point.generate();
const AREA = Area.generate();
const DX = Derivation.generate();

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: null as string | null })),
}));
jest.mock("@/lib/auth-utils", () => ({
  isUserAdmin: jest.fn(async () => false),
}));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: jest.fn(),
    areaByHandle: jest.fn(),
  },
}));
jest.mock("@/lib/control/point-actions", () => ({
  loadPointByUuid: jest.fn(),
  loadPointByStemMetric: jest.fn(),
  dispatchPointAction: jest.fn(),
}));
jest.mock("@/lib/control/repoll", () => ({ scheduleRepoll: jest.fn() }));
// The AUTOMATIONS path: a deferred command. Everything except the ownership gate is stubbed, so
// what these cases exercise is the real `requireDeviceAccess` inside `checkReferences`.
jest.mock("@/lib/areas/http", () => ({
  loadAreaForOwner: jest.fn(),
  loadAreaForAuth: jest.fn(),
}));
jest.mock("@/lib/automations/store", () => ({
  create: jest.fn(),
  getById: jest.fn(),
  patch: jest.fn(),
  remove: jest.fn(async () => true),
  derivationBelongsToArea: jest.fn(async () => true),
}));

import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import {
  dispatchPointAction,
  loadPointByStemMetric,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import { loadAreaForAuth, loadAreaForOwner } from "@/lib/areas/http";
import * as automationStore from "@/lib/automations/store";
import { POST as pointAction } from "@/app/api/v4/points/[id]/action/route";
import { POST as teslaCommand } from "@/app/api/devices/[systemId]/tesla/command/route";
import { POST as createAutomation } from "@/app/api/v4/automations/route";
import {
  DELETE as deleteAutomation,
  PATCH as patchAutomation,
} from "@/app/api/v4/automations/[id]/route";

const mockClerk = jest.mocked(auth) as unknown as jest.Mock;
const mockIsAdmin = jest.mocked(isUserAdmin);
const mockDeviceByHandle = jest.mocked(DeviceConfigRegistry.deviceByHandle);
const mockDispatch = jest.mocked(dispatchPointAction);

function signIn(userId: string | null, admin = false) {
  mockClerk.mockImplementation(async () => ({ userId }));
  mockIsAdmin.mockImplementation(async () => admin);
}

function device(owner: string | null) {
  mockDeviceByHandle.mockResolvedValue({
    id: 10,
    ownerClerkUserId: owner,
    vendorType: "tesla",
    displayName: "Tez",
    timezoneOffsetMin: 600,
  } as unknown as Awaited<
    ReturnType<typeof DeviceConfigRegistry.deviceByHandle>
  >);
}

const pointRow = {
  id: Point.toUuid(POINT),
  deviceId: "019f0000-0000-7000-8000-0000000dev10",
  logicalPath: "ev.charge",
  metricType: "active",
  control: { kind: "switch" },
};

const AU = Automation.generate();

/** An automation the OWNER authored, on the owner's own car. `enabled` is the variable. */
function storedRow(enabled: boolean): Record<string, unknown> {
  return {
    id: Automation.toUuid(AU),
    areaId: Area.toUuid(AREA),
    name: "Charge limit",
    enabled,
    mode: "once",
    trigger: {
      kind: "charge-session",
      source: { kind: "derivation", derivationId: Derivation.toUuid(DX) },
      afterMinutes: 60,
    },
    action: {
      kind: "point-action",
      pointId: Point.toUuid(POINT),
      action: "turn_off",
    },
    armedAt: null,
    lastTriggeredAt: null,
    lastTriggeredRunStart: null,
    armedContext: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** `POST /api/v4/points/{pt_}/action` — the control plane's entry point. */
function callV4() {
  const request = new NextRequest("http://localhost/api/v4/points/x/action", {
    method: "POST",
    body: JSON.stringify({ action: "turn_on" }),
  });
  return pointAction(request, { params: Promise.resolve({ id: POINT }) });
}

/** `POST /api/devices/{id}/tesla/command` — the legacy shim over the same plane. */
function callLegacy() {
  const request = new NextRequest(
    "http://localhost/api/devices/10/tesla/command",
    { method: "POST", body: JSON.stringify({ command: "charge_start" }) },
  );
  return teslaCommand(request, { params: Promise.resolve({ systemId: "10" }) });
}

const ROUTES = [
  ["v4 point action", callV4],
  ["legacy tesla command shim", callLegacy],
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  device("user_owner");
  signIn(null);
  jest.mocked(loadPointByUuid).mockResolvedValue({
    point: pointRow as never,
    deviceRid: 10,
  });
  jest.mocked(loadPointByStemMetric).mockResolvedValue(pointRow as never);
  mockDispatch.mockResolvedValue({
    kind: "completed",
    ok: true,
    reason: null,
    commandId: "cmd-1",
  });
  // The area gate the automations routes use is owner-OR-ADMIN; pass it, so what the cases below
  // discriminate is purely the device-ownership gate on the ACTION point.
  jest.mocked(loadAreaForOwner).mockResolvedValue({
    area: { id: Area.toUuid(AREA) },
  } as never);
  jest.mocked(automationStore.derivationBelongsToArea).mockResolvedValue(true);
  // The PATCH path: the area gate there is owner-OR-ADMIN too (collapsed to 404), so again the
  // only thing left to discriminate is the device-ownership gate on the action point.
  jest.mocked(loadAreaForAuth).mockResolvedValue({
    id: Area.toUuid(AREA),
    ownerClerkUserId: "user_owner",
  } as never);
  jest
    .mocked(automationStore.getById)
    .mockResolvedValue(storedRow(false) as never);
  jest
    .mocked(automationStore.patch)
    .mockImplementation(async (_id, fields) =>
      ({ ...storedRow(false), ...(fields as object) }) as never,
    );
  jest.mocked(automationStore.remove).mockResolvedValue(true);
  jest.mocked(automationStore.create).mockImplementation(
    async (values) =>
      ({
        ...values,
        id: Automation.toUuid(Automation.generate()),
        enabled: true,
        armedAt: null,
        lastTriggeredAt: null,
        lastTriggeredRunStart: null,
        armedContext: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }) as never,
  );
});

describe.each(ROUTES)("%s — owner-only", (_name, call) => {
  it("the OWNER can command (the happy path still works)", async () => {
    signIn("user_owner");
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("🛑 a non-owner ADMIN is refused 403 and NOTHING is dispatched", async () => {
    signIn("user_admin", true);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the device owner can control this device",
    );
    // The real proof: no vehicle command was attempted on the owner's credentials.
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("🛑 an OWNERLESS device is refused for an ANONYMOUS caller (null === null)", async () => {
    device(null);
    signIn(null);
    const res = await call();
    expect(res.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("🛑 an OWNERLESS device is refused for an ADMIN too", async () => {
    device(null);
    signIn("user_admin", true);
    expect((await call()).status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("a signed-in stranger is refused", async () => {
    signIn("user_stranger");
    expect((await call()).status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("automations — the DEFERRED command path", () => {
  // 🛑 The third way to reach `dispatchPointAction`. An automation is a command with a delay: the
  // cron evaluator fires it later with NO session and on the DEVICE OWNER's vendor credentials.
  // The area gate (`loadAreaForOwner`) admits admins, so if the action point were merely
  // write-gated a non-owner admin could park a `turn_off` on someone else's car and have us
  // execute it — the owner-only rule undone by a route it never guarded.
  function createLimit() {
    return createAutomation(
      new NextRequest("http://localhost/api/v4/automations", {
        method: "POST",
        body: JSON.stringify({
          areaId: AREA,
          mode: "once",
          trigger: {
            kind: "charge-session",
            source: { kind: "derivation", derivationId: DX },
            afterMinutes: 60,
          },
          action: { kind: "point-action", pointId: POINT, action: "turn_off" },
        }),
      }),
    );
  }

  it("the OWNER can create one (the happy path still works)", async () => {
    signIn("user_owner");
    expect((await createLimit()).status).toBe(201);
    expect(automationStore.create).toHaveBeenCalledTimes(1);
  });

  it("🛑 a non-owner ADMIN is refused 403 and NOTHING is stored", async () => {
    signIn("user_admin", true);
    const res = await createLimit();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the device owner can control this device",
    );
    expect(automationStore.create).not.toHaveBeenCalled();
  });

  it("🛑 nobody can aim one at an OWNERLESS device — not an admin, not an anonymous caller", async () => {
    device(null);
    for (const who of [
      () => signIn("user_admin", true),
      () => signIn(null),
    ] as const) {
      jest.mocked(automationStore.create).mockClear();
      who();
      expect((await createLimit()).status).toBe(403);
      expect(automationStore.create).not.toHaveBeenCalled();
    }
  });

  it("a signed-in stranger is refused", async () => {
    signIn("user_stranger");
    expect((await createLimit()).status).toBe(403);
    expect(automationStore.create).not.toHaveBeenCalled();
  });
});

describe("automations — RE-ENABLING is causing a command too", () => {
  // 🛑 The fourth way to reach `dispatchPointAction`, and the one that was open: an automation the
  // OWNER wrote and then DISABLED is a parked command. Flipping `enabled` back to true (or widening
  // `mode`) hands it back to the cron evaluator, which fires it with no session, on the device
  // OWNER's vendor credentials. The area gate collapses to 404 for a stranger but ADMITS a non-owner
  // admin, so the ownership gate on the action point is the only thing between an admin and a
  // `turn_off` at someone else's car. Here the REAL `requireDeviceAccess` decides.
  function callPatch(body: unknown) {
    return patchAutomation(
      new NextRequest(`http://localhost/api/v4/automations/${AU}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: AU }) },
    );
  }

  it("the OWNER can re-enable their own automation (the happy path still works)", async () => {
    signIn("user_owner");
    expect((await callPatch({ enabled: true })).status).toBe(200);
    expect(automationStore.patch).toHaveBeenCalledTimes(1);
  });

  it("🛑 a non-owner ADMIN cannot re-enable it — 403 and NOTHING is stored", async () => {
    signIn("user_admin", true);
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the device owner can control this device",
    );
    expect(automationStore.patch).not.toHaveBeenCalled();
  });

  it("🛑 …nor change its mode, nor rename it", async () => {
    signIn("user_admin", true);
    for (const body of [{ mode: "standing" }, { name: "Renamed" }]) {
      jest.mocked(automationStore.patch).mockClear();
      expect((await callPatch(body)).status).toBe(403);
      expect(automationStore.patch).not.toHaveBeenCalled();
    }
  });

  it("🛑 nobody can re-enable one aimed at an OWNERLESS device", async () => {
    // An ownerless device is commandable by NOBODY, so even an admin gets the control 403. An
    // anonymous caller never reaches the control gate at all — `requireAuth` 401s the route first.
    device(null);
    for (const [who, status] of [
      [() => signIn("user_admin", true), 403],
      [() => signIn(null), 401],
    ] as const) {
      jest.mocked(automationStore.patch).mockClear();
      who();
      expect((await callPatch({ enabled: true })).status).toBe(status);
      expect(automationStore.patch).not.toHaveBeenCalled();
    }
  });

  it("DELETE is administration: a non-owner ADMIN may remove one (pinned decision)", async () => {
    // Deleting can only cause FEWER commands. See the DELETE note in the route.
    signIn("user_admin", true);
    const res = await deleteAutomation(
      new NextRequest(`http://localhost/api/v4/automations/${AU}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: AU }) },
    );
    expect(res.status).toBe(200);
    expect(automationStore.remove).toHaveBeenCalledTimes(1);
  });
});

describe("share-token viewers (pinned — must not regress)", () => {
  it("🛑 a share-token viewer cannot command — a share token carries no session at all", async () => {
    // `?access=` is a READ grant. Neither control route consults it (they call
    // `requireDeviceAccess`, not `requireDashboardAccess`), and neither is in `publicRoutes` or
    // `shareableRoutes`, so the Clerk middleware rewrites the POST to a 404 before the handler
    // even runs. Here, one layer in, such a caller is simply anonymous — and refused 401 on an
    // OWNED device, because it cannot even read it.
    signIn(null);
    const request = new NextRequest(
      "http://localhost/api/v4/points/x/action?access=shr_sometoken",
      { method: "POST", body: JSON.stringify({ action: "turn_on" }) },
    );
    const res = await pointAction(request, {
      params: Promise.resolve({ id: POINT }),
    });
    expect(res.status).toBe(401);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("🛑 …and on a PUBLIC device, where it CAN read, the owner gate is what refuses it", async () => {
    // The discriminating half: an ownerless device is publicly readable, so the read gate lets
    // this caller through and the refusal comes from the control gate itself — 403, not 401.
    device(null);
    signIn(null);
    const request = new NextRequest(
      "http://localhost/api/v4/points/x/action?access=shr_sometoken",
      { method: "POST", body: JSON.stringify({ action: "turn_on" }) },
    );
    const res = await pointAction(request, {
      params: Promise.resolve({ id: POINT }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the device owner can control this device",
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
