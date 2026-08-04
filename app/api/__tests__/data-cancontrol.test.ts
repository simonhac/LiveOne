/**
 * `/api/data` emits `canControl` — the field that drives the EV charge-control cog
 * (`components/dashboard/v4/node-view.tsx` → `canControl`, via `datumCanControl`).
 *
 * 🛑 It is the viewer's OWNERSHIP of the subject, NOT `canWrite` (owner OR admin). The control
 * routes are owner-only (`requireDeviceAccess({requireOwner:true})`), so emitting `canWrite` would
 * render a cog that 403s on press for a non-owner admin — case (c) is that case, and it is the
 * one the client/server agreement turns on. Case (b) pins the share-token viewer: a share token
 * must never be able to command a car.
 *
 * Collaborators are mocked and the exported handler is called directly, per
 * `app/api/v4/__tests__/point-action.test.ts`. `lib/json` and `lib/server-timing` run for real so
 * the assertions are made against the ACTUAL serialized body.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({
  requireDashboardAccess: jest.fn(),
}));
jest.mock("@/lib/dashboard/serve-data", () => ({
  buildDevicePayload: jest.fn(),
}));
jest.mock("@/lib/dashboard/subject", () => ({
  resolveWireAddress: jest.fn(),
  subjectForHandle: jest.fn(),
  subjectTimezoneOffsetMin: () => 600,
}));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn() },
}));

import { GET } from "@/app/api/data/route";
import { requireDashboardAccess } from "@/lib/api-auth";
import { buildDevicePayload } from "@/lib/dashboard/serve-data";
import { resolveWireAddress } from "@/lib/dashboard/subject";
import {
  datumCanControl,
  datumCanControlPoint,
} from "@/lib/control/ownership";
import { TESLA_CHARGE_CONTROL_PATHS } from "@/lib/control/point-ref";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

const mockAuth = requireDashboardAccess as jest.MockedFunction<
  typeof requireDashboardAccess
>;
const mockBuild = buildDevicePayload as jest.MockedFunction<
  typeof buildDevicePayload
>;
const mockAddress = resolveWireAddress as jest.MockedFunction<
  typeof resolveWireAddress
>;

const SUBJECT = { kind: "device", handle: 10 };

/**
 * Who owns what, for `viewerControllableDevices`. Device 10 is the CAR (owned by `user_owner`);
 * device 11 is the house inverter, owned by `user_area_owner` — who also owns the AREA that files
 * both. That split is the whole point of the per-device leg.
 */
const DEVICE_OWNERS: Record<number, string | null> = {
  10: "user_owner",
  11: "user_area_owner",
  12: null,
};
const mockDeviceByHandle = jest.mocked(DeviceConfigRegistry.deviceByHandle);

const PAYLOAD = {
  device: { id: 10, deviceId: "dv_test", vendorType: "tesla" },
  latest: {
    "ev.battery/soc": {
      value: 62,
      logicalPath: "ev.battery/soc",
      metricUnit: "%",
      displayName: "Battery",
      pointReference: "pt_01k9abcdefghjkmnpqrstvwxyz",
      sourceSystemId: 10,
    },
  },
};

/**
 * An AREA payload: the car's control points (device 10) and the house inverter's (device 11) in one
 * `latest` map, exactly as an area's fan-out produces. `sourceSystemId` is the field that tells them
 * apart — it is already on every entry (`lib/latest-values-store.ts`), which is why the per-device
 * ownership leg needs no second authorization path.
 */
const AREA_PAYLOAD = {
  area: { id: 1000002, areaId: "ar_test" },
  latest: {
    "ev.battery/soc": {
      value: 62,
      logicalPath: "ev.battery/soc",
      metricUnit: "%",
      displayName: "Battery",
      sourceSystemId: 10,
    },
    "ev.charge/active": {
      value: false,
      logicalPath: "ev.charge/active",
      metricUnit: "bool",
      displayName: "Charging",
      pointReference: "pt_01k9abcdefghjkmnpqrstvwxyz",
      sourceSystemId: 10,
    },
    "bidi.grid/power": {
      value: 1200,
      logicalPath: "bidi.grid/power",
      metricUnit: "W",
      displayName: "Grid",
      sourceSystemId: 11,
    },
  },
};

/** The auth context shape `requireDashboardAccess` returns, with per-case overrides. */
function ctx(over: {
  userId: string | null;
  canWrite: boolean;
  /** `DashboardAuthContext.isOwner` — strict ownership; defaults to false (admin/grantee/guest). */
  isOwner?: boolean;
  via?: boolean;
}) {
  return {
    subject: SUBJECT,
    userId: over.userId,
    canRead: true,
    canWrite: over.canWrite,
    isOwner: over.isOwner ?? false,
    viaShareToken: over.via ?? false,
  } as unknown as Awaited<ReturnType<typeof requireDashboardAccess>>;
}

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/data?${query}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAddress.mockResolvedValue({ ok: true, handle: 10, prefer: "device" });
  mockBuild.mockResolvedValue(
    PAYLOAD as unknown as Awaited<ReturnType<typeof buildDevicePayload>>,
  );
  mockDeviceByHandle.mockImplementation(
    async (handle: number) =>
      ({
        id: handle,
        ownerClerkUserId: DEVICE_OWNERS[handle] ?? null,
      }) as never,
  );
});

describe("GET /api/data — canControl on the wire", () => {
  it("a. the OWNER gets canControl:true, and the payload is unchanged", async () => {
    mockAuth.mockResolvedValue(
      ctx({ userId: "user_owner", canWrite: true, isOwner: true }),
    );

    const res = await GET(req("systemId=10"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.canControl).toBe(true);
    // Purely additive: the discriminated subject block and `latest` still ride as before.
    expect(body.device).toEqual(PAYLOAD.device);
    expect(body.latest["ev.battery/soc"].value).toBe(62);
    expect(body.latest["ev.battery/soc"].pointReference).toBe(
      "pt_01k9abcdefghjkmnpqrstvwxyz",
    );
  });

  it("b. 🛑 a SHARE-TOKEN viewer gets canControl:false — a share token never commands a car", async () => {
    mockAuth.mockResolvedValue(
      ctx({ userId: null, canWrite: false, via: true }),
    );

    const res = await GET(req("systemId=10&access=shr_sometoken"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.canControl).toBe(false);
    // Read access is undisturbed — the viewer still sees the data, just no controls.
    expect(body.device).toEqual(PAYLOAD.device);
  });

  it("c. 🛑 a non-owner ADMIN gets canControl:false even though canWrite is true", async () => {
    // THE case the client/server agreement turns on. The action route would refuse this caller
    // (`requireOwner`), so showing the cog would only produce a 403 on press.
    mockAuth.mockResolvedValue(
      ctx({ userId: "user_admin", canWrite: true, isOwner: false }),
    );

    const res = await GET(req("systemId=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canControl).toBe(false);
    // Read access is untouched — the admin still sees everything.
    expect(body.device).toEqual(PAYLOAD.device);
  });

  it("c2. 🛑 an ANONYMOUS caller on an ownerless subject is false (the null === null quirk)", async () => {
    // The shape `lib/__tests__/api-auth.test.ts` pins: the helper's raw `canWrite` is true for a
    // caller who owns nothing, because `null === null`. `isOwner` is strict, so it is false.
    mockAuth.mockResolvedValue(
      ctx({ userId: null, canWrite: true, isOwner: false }),
    );

    const res = await GET(req("systemId=10"));
    expect(res.status).toBe(200);
    expect((await res.json()).canControl).toBe(false);
  });

  it("d. an authed grantee (read-only) gets canControl:false", async () => {
    mockAuth.mockResolvedValue(ctx({ userId: "user_x", canWrite: false }));

    const res = await GET(req("systemId=10"));
    expect((await res.json()).canControl).toBe(false);
  });

  it("e. an auth refusal is returned verbatim and no payload is built", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "No access" }, { status: 403 }),
    );

    const res = await GET(req("systemId=10"));
    expect(res.status).toBe(403);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("f. the batch leg carries canControl INSIDE each per-id entry", async () => {
    // Each entry is a `queryKeys.data(id)` cache-seed value, so it must have the identical shape
    // to a single-subject fetch — the field rides in the entry, never on the envelope.
    mockAuth.mockImplementation(async (_request, systemId) =>
      systemId === 10
        ? ctx({ userId: "user_owner", canWrite: true, isOwner: true })
        : ctx({ userId: null, canWrite: false, via: true }),
    );

    const res = await GET(req("systemId=10,11"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.canControl).toBeUndefined();
    expect(body.data["10"].canControl).toBe(true);
    expect(body.data["11"].canControl).toBe(false);
    expect(body.data["10"].device).toEqual(PAYLOAD.device);
  });

  it("f2. a batch id whose auth refuses is omitted entirely", async () => {
    mockAuth.mockImplementation(async (_request, systemId) =>
      systemId === 10
        ? ctx({ userId: "user_owner", canWrite: true, isOwner: true })
        : NextResponse.json({ error: "No access" }, { status: 403 }),
    );

    const body = await (await GET(req("systemId=10,11"))).json();
    expect(body.data["10"].canControl).toBe(true);
    expect(body.data["11"]).toBeUndefined();
  });

  it("g. 🛑 the CLIENT gate agrees: the non-owner admin's payload renders no controls", async () => {
    // `components/dashboard/v4/node-view.tsx` gates the EV cog on `datumCanControl(datum)` — the
    // very function called here, against the very body the route emitted. So this closes the
    // client/server loop without rendering: server says no, client shows nothing.
    mockAuth.mockResolvedValue(
      ctx({ userId: "user_admin", canWrite: true, isOwner: false }),
    );
    const adminDatum = await (await GET(req("systemId=10"))).json();
    expect(datumCanControl(adminDatum)).toBe(false);

    mockAuth.mockResolvedValue(
      ctx({ userId: "user_owner", canWrite: true, isOwner: true }),
    );
    const ownerDatum = await (await GET(req("systemId=10"))).json();
    expect(datumCanControl(ownerDatum)).toBe(true);
  });
});

/**
 * 🛑 The per-DEVICE control leg — `canControlDevices`, and the client gate it feeds.
 *
 * The seam this closes: an EV tile filed inside a multi-device AREA fetches the AREA, so the
 * subject-level `canControl` answers about the area. An area owner who does not own the car would
 * therefore be shown a cog that 403s on press — client and server disagreeing, which is a defect
 * even though it fails safe. The fix keeps ONE authorization rule (`ownsSubject`, the same one
 * `requireDeviceAccess({requireOwner:true})` applies) and simply reports it per device, off the
 * `sourceSystemId` every latest entry already carries.
 *
 * `components/` is not a jest root, so the rendered cog cannot be asserted directly; but
 * `node-view.tsx` gates it on exactly `datumCanControlPoint(datum, plugin.controlPaths)`, called
 * here against the ACTUAL emitted body. Server and client are proved to agree.
 */
describe("GET /api/data — canControlDevices (the tile commands a DEVICE, not the subject)", () => {
  function areaCtx(userId: string | null, isOwner: boolean) {
    return {
      subject: { kind: "area", handle: 1000002 },
      userId,
      canRead: true,
      canWrite: isOwner,
      isOwner,
      viaShareToken: false,
    } as unknown as Awaited<ReturnType<typeof requireDashboardAccess>>;
  }

  beforeEach(() => {
    mockAddress.mockResolvedValue({
      ok: true,
      handle: 1000002,
      prefer: "area",
    });
    mockBuild.mockResolvedValue(
      AREA_PAYLOAD as unknown as Awaited<ReturnType<typeof buildDevicePayload>>,
    );
  });

  it("🛑 the AREA owner who does NOT own the car: canControl:true, but the cog does NOT render", async () => {
    mockAuth.mockResolvedValue(areaCtx("user_area_owner", true));
    const body = await (await GET(req("areaId=ar_test"))).json();

    // The subject-level flag is honestly true — they DO own the area.
    expect(body.canControl).toBe(true);
    // …but only the inverter is theirs to command. The car is not in the list.
    expect(body.canControlDevices).toEqual([11]);
    // The client gate, on the real body: no cog. Previously this was `true` and 403ed on press.
    expect(datumCanControlPoint(body, TESLA_CHARGE_CONTROL_PATHS)).toBe(false);
  });

  it("the CAR's owner, viewing the same area, does get the cog", async () => {
    mockAuth.mockResolvedValue(areaCtx("user_owner", false));
    const body = await (await GET(req("areaId=ar_test"))).json();

    // Not the area's owner — the subject-level flag is false — yet the car IS theirs.
    expect(body.canControl).toBe(false);
    expect(body.canControlDevices).toEqual([10]);
    expect(datumCanControlPoint(body, TESLA_CHARGE_CONTROL_PATHS)).toBe(true);
  });

  it("🛑 a non-owner ADMIN owns nothing in the area, so commands nothing", async () => {
    mockAuth.mockResolvedValue(areaCtx("user_admin", false));
    const body = await (await GET(req("areaId=ar_test"))).json();
    expect(body.canControlDevices).toEqual([]);
    expect(datumCanControlPoint(body, TESLA_CHARGE_CONTROL_PATHS)).toBe(false);
  });

  it("🛑 an anonymous / share-token viewer never reaches the registry at all", async () => {
    mockAuth.mockResolvedValue(areaCtx(null, false));
    const body = await (await GET(req("areaId=ar_test"))).json();
    expect(body.canControlDevices).toEqual([]);
    expect(datumCanControlPoint(body, TESLA_CHARGE_CONTROL_PATHS)).toBe(false);
    expect(mockDeviceByHandle).not.toHaveBeenCalled();
  });

  it("🛑 an OWNERLESS device in the area is commandable by nobody (null === null)", async () => {
    mockBuild.mockResolvedValue({
      ...AREA_PAYLOAD,
      latest: {
        "ev.charge/active": {
          ...AREA_PAYLOAD.latest["ev.charge/active"],
          sourceSystemId: 12,
        },
      },
    } as unknown as Awaited<ReturnType<typeof buildDevicePayload>>);
    mockAuth.mockResolvedValue(areaCtx("user_area_owner", true));
    const body = await (await GET(req("areaId=ar_test"))).json();
    expect(body.canControlDevices).toEqual([]);
    expect(datumCanControlPoint(body, TESLA_CHARGE_CONTROL_PATHS)).toBe(false);
  });

  it("the DEVICE leg is unchanged: the car's owner on the car's own page still gets the cog", async () => {
    mockAddress.mockResolvedValue({ ok: true, handle: 10, prefer: "device" });
    mockBuild.mockResolvedValue({
      ...PAYLOAD,
      latest: {
        ...PAYLOAD.latest,
        "ev.charge/active": {
          value: false,
          logicalPath: "ev.charge/active",
          metricUnit: "bool",
          displayName: "Charging",
          sourceSystemId: 10,
        },
      },
    } as unknown as Awaited<ReturnType<typeof buildDevicePayload>>);
    mockAuth.mockResolvedValue(
      ctx({ userId: "user_owner", canWrite: true, isOwner: true }),
    );
    const body = await (await GET(req("systemId=10"))).json();
    expect(body.canControl).toBe(true);
    expect(body.canControlDevices).toEqual([10]);
    expect(datumCanControlPoint(body, TESLA_CHARGE_CONTROL_PATHS)).toBe(true);
  });

  it("the batch leg carries canControlDevices inside each entry too", async () => {
    mockAddress.mockResolvedValue({ ok: true, handle: 10, prefer: "device" });
    mockBuild.mockResolvedValue(
      AREA_PAYLOAD as unknown as Awaited<ReturnType<typeof buildDevicePayload>>,
    );
    mockAuth.mockImplementation(async (_request, systemId) =>
      systemId === 10
        ? ctx({ userId: "user_owner", canWrite: true, isOwner: true })
        : ctx({ userId: null, canWrite: false, via: true }),
    );
    const body = await (await GET(req("systemId=10,11"))).json();
    expect(body.data["10"].canControlDevices).toEqual([10]);
    expect(body.data["11"].canControlDevices).toEqual([]);
  });
});
