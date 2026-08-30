/**
 * ROUTE-level tests for the SIX `/api/v4/areas*` mutation handlers.
 *
 * Companion to `scripts/utils/v4-surface-smoke.ts`, which drives the same handlers end-to-end against a
 * live dev server and a real Postgres. This file covers what only a mock can reach cheaply — every
 * body-validation branch, a DAO that throws, and the three assertions below that a green smoke run
 * cannot make:
 *
 *  1. 🛑 **`refreshAreaServing` fires on EVERY path that changes membership, bindings or metadata.**
 *     It rebuilds the KV subscription registry (the persisted derived store keyed off exactly this
 *     state). A handler that skipped it would pass every status/payload assertion in the smoke run and
 *     leave the area serving its PREVIOUS point set — no error, no 404, nothing to grep for.
 *  2. 🛑 **`PATCH {status:"archived"}` still answers 200 with the aggregate.** The echo is built
 *     directly, NOT by re-entering `GET`, whose loader resolves through `listReadableAreas` and filters
 *     `status='active'` — re-entering it would have 403'd the row the handler had just written.
 *  3. The 400/404/403 split the shared `loadAreaForOwner` owns, per handler.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Area, Device, Point } from "@/lib/ids";

const AREA = Area.generate();
const AREA_UUID = Area.toUuid(AREA);
const DEVICE_A = Device.generate();
const DEVICE_B = Device.generate();
const POINT = Point.generate();

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/areas/list", () => ({ listReadableAreas: jest.fn() }));
jest.mock("@/lib/areas/v4-load", () => ({
  loadAreaMembers: jest.fn(),
  loadAreaBindings: jest.fn(),
}));
jest.mock("@/lib/capabilities/server", () => ({
  capabilitiesForDevice: jest.fn(),
}));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn() },
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: jest.fn(),
}));
jest.mock("@/lib/areas/http", () => {
  const actual = jest.requireActual("@/lib/areas/http") as object;
  return {
    ...actual,
    loadAreaForOwner: jest.fn(),
    loadReadableArea: jest.fn(),
    resolveMemberDeviceRefs: jest.fn(),
  };
});
jest.mock("@/lib/areas/create", () => {
  class AreaAliasTakenError extends Error {
    constructor() {
      super("alias already in use");
      this.name = "AreaAliasTakenError";
    }
  }
  class AreaValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AreaValidationError";
    }
  }
  class AreaAccessError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AreaAccessError";
    }
  }
  return {
    AreaAliasTakenError,
    AreaValidationError,
    AreaAccessError,
    createArea: jest.fn(),
    updateAreaMeta: jest.fn(),
    replaceMembers: jest.fn(),
    replaceBindings: jest.fn(),
    refreshAreaServing: jest.fn(),
    assertMembersReadable: jest.fn(),
  };
});

import { requireAuth } from "@/lib/api-auth";
import { loadAreaForOwner, resolveMemberDeviceRefs } from "@/lib/areas/http";
import { loadAreaMembers, loadAreaBindings } from "@/lib/areas/v4-load";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import {
  createArea,
  updateAreaMeta,
  replaceMembers,
  replaceBindings,
  refreshAreaServing,
  AreaAliasTakenError,
  AreaValidationError,
} from "@/lib/areas/create";
import { POST as areasPOST } from "../areas/route";
import { PATCH as areaPATCH, DELETE as areaDELETE } from "../areas/[id]/route";
import { PUT as membersPUT } from "../areas/[id]/members/route";
import { PUT as bindingsPUT } from "../areas/[id]/bindings/route";

const mockAuth = jest.mocked(requireAuth);
const mockLoadOwner = jest.mocked(loadAreaForOwner);
const mockResolveMembers = jest.mocked(resolveMemberDeviceRefs);
const mockMembers = jest.mocked(loadAreaMembers);
const mockBindings = jest.mocked(loadAreaBindings);
const mockCaps = jest.mocked(capabilitiesForDevice);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockDeviceByHandle = jest.mocked(DeviceConfigRegistry.deviceByHandle);
const mockCreate = jest.mocked(createArea);
const mockUpdateMeta = jest.mocked(updateAreaMeta);
const mockReplaceMembers = jest.mocked(replaceMembers);
const mockReplaceBindings = jest.mocked(replaceBindings);
const mockRefresh = jest.mocked(refreshAreaServing);

/** The area row the aggregate reader selects — the drizzle chain is stubbed down to this one array. */
let areaRow: Record<string, unknown> | undefined;

const req = (body?: unknown) =>
  new NextRequest(`http://localhost/api/v4/areas/${AREA}`, {
    method: "POST",
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  });
const params = { params: Promise.resolve({ id: AREA }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    userId: "user_1",
    isAdmin: false,
    isCron: false,
    isClaudeDev: false,
  } as any);
  mockLoadOwner.mockResolvedValue({
    userId: "user_1",
    isAdmin: false,
    area: {
      id: AREA_UUID,
      ownerClerkUserId: "user_1",
      legacySystemId: 1000002,
      status: "active",
      displayName: "Area",
      location: { country: "AU", state: "VIC" },
    },
  } as any);
  mockResolveMembers.mockResolvedValue({
    ok: true,
    deviceIds: [DEVICE_A, DEVICE_B],
    systemIds: [1, 2],
  } as any);
  mockMembers.mockResolvedValue([
    {
      id: DEVICE_A,
      name: "A",
      vendor: "selectronic",
      status: "active",
      capabilities: [],
    },
  ] as any);
  mockBindings.mockResolvedValue([]);
  mockCaps.mockResolvedValue(new Set<string>() as any);
  mockCreate.mockResolvedValue({ id: AREA_UUID, legacySystemId: 1000009 });
  mockDeviceByHandle.mockResolvedValue(null as any);
  areaRow = {
    id: AREA_UUID,
    name: "Area",
    slug: "area",
    status: "active",
    dayOffsetMin: 600,
    timezoneOffsetMin: 600,
    displayTimezone: "Australia/Melbourne",
    location: null,
    config: null,
  };
  // Minimal drizzle stub: `select().from().where().limit()` resolves to the row array.
  mockDb.mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (areaRow ? [areaRow] : []) }),
      }),
    }),
  } as any);
});

// ---------------------------------------------------------------------------
describe("POST /api/v4/areas", () => {
  it("422s a missing name before touching the member refs", async () => {
    const res = await areasPOST(req({ members: [DEVICE_A] }));
    expect(res.status).toBe(422);
    expect(mockResolveMembers).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("propagates the member-ref resolver's own status (403 unreadable, 422 malformed)", async () => {
    for (const status of [403, 422] as const) {
      mockResolveMembers.mockResolvedValueOnce({
        ok: false,
        status,
        message: "nope",
      } as any);
      const res = await areasPOST(req({ name: "Site", members: ["x"] }));
      expect(res.status).toBe(status);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates with the resolved integer handles and 201s { id, legacySystemId }", async () => {
    const res = await areasPOST(
      req({ name: "  Site  ", slug: " my-site ", members: [DEVICE_A] }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: Area.encode(AREA_UUID),
      legacySystemId: 1000009,
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerClerkUserId: "user_1",
        displayName: "Site",
        alias: "my-site",
        memberSystemIds: [1, 2],
      }),
    );
    expect(mockRefresh).toHaveBeenCalledWith(AREA_UUID);
  });

  it("maps `dayOffsetMin` onto the one number that writes BOTH offset columns", async () => {
    await areasPOST(
      req({ name: "Site", members: [DEVICE_A], dayOffsetMin: 570 }),
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ timezoneOffsetMin: 570 }),
    );
  });

  it("409s an alias collision instead of letting it become a bare 500", async () => {
    mockCreate.mockRejectedValueOnce(new AreaAliasTakenError() as any);
    const res = await areasPOST(req({ name: "Site", members: [DEVICE_A] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/shortname/);
  });

  it("rethrows anything that is not an alias collision (a 409 must mean what it says)", async () => {
    mockCreate.mockRejectedValueOnce(new Error("boom") as any);
    await expect(
      areasPOST(req({ name: "Site", members: [DEVICE_A] })),
    ).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
describe("PATCH /api/v4/areas/{id}", () => {
  it("returns the loader's own 400/404/403 verbatim", async () => {
    for (const status of [400, 404, 403] as const) {
      mockLoadOwner.mockResolvedValueOnce({
        error: NextResponse.json({ error: "no" }, { status }),
      } as any);
      const res = await areaPATCH(req({ name: "x" }), params);
      expect(res.status).toBe(status);
    }
    expect(mockUpdateMeta).not.toHaveBeenCalled();
  });

  it.each([
    ["name", { name: "   " }],
    ["slug", { slug: 7 }],
    ["dayOffsetMin", { dayOffsetMin: "600" }],
    ["displayTimezone", { displayTimezone: "" }],
    ["status", { status: "deleted" }],
  ])("422s an invalid %s", async (_label, body) => {
    const res = await areaPATCH(req(body), params);
    expect(res.status).toBe(422);
    expect(mockUpdateMeta).not.toHaveBeenCalled();
  });

  it("translates the v4 vocabulary onto the DAO's patch keys and MERGES location", async () => {
    await areaPATCH(
      req({
        name: "New",
        slug: null,
        dayOffsetMin: 570,
        location: { postcode: "5000" },
      }),
      params,
    );
    expect(mockUpdateMeta).toHaveBeenCalledWith(AREA_UUID, {
      displayName: "New",
      alias: null,
      timezoneOffsetMin: 570,
      // the pre-existing state survives a partial location patch
      location: expect.objectContaining({
        country: "AU",
        state: "VIC",
        postcode: "5000",
      }),
    });
    expect(mockRefresh).toHaveBeenCalledWith(AREA_UUID);
  });

  it("409s an alias collision", async () => {
    mockUpdateMeta.mockRejectedValueOnce(new AreaAliasTakenError() as any);
    const res = await areaPATCH(req({ slug: "taken" }), params);
    expect(res.status).toBe(409);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("🛑 echoes the aggregate even when the patch ARCHIVED the area", async () => {
    // The regression this pins: an echo implemented as `return GET(...)` resolves the area through
    // `listReadableAreas`, which filters `status='active'` — so this exact call would have 403'd the
    // row it had just successfully written. Building the echo directly is what makes it 200.
    areaRow = { ...areaRow!, status: "archived" };
    const res = await areaPATCH(req({ status: "archived" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.area.status).toBe("archived");
    expect(body.area.id).toBe(AREA);
    expect(body).toHaveProperty("members");
    expect(body).toHaveProperty("bindings");
  });
});

// ---------------------------------------------------------------------------
describe("DELETE /api/v4/areas/{id}", () => {
  it("archives rather than deleting, and refreshes serving", async () => {
    const res = await areaDELETE(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockUpdateMeta).toHaveBeenCalledWith(AREA_UUID, {
      status: "archived",
    });
    expect(mockRefresh).toHaveBeenCalledWith(AREA_UUID);
  });

  it("409s a device's own area (its handle names a real device)", async () => {
    mockDeviceByHandle.mockResolvedValueOnce({ id: 1000002 } as any);
    const res = await areaDELETE(req(), params);
    expect(res.status).toBe(409);
    expect(mockUpdateMeta).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("PUT /api/v4/areas/{id}/members", () => {
  it("propagates the member-ref resolver's status and writes nothing", async () => {
    mockResolveMembers.mockResolvedValueOnce({
      ok: false,
      status: 403,
      message: "nope",
    } as any);
    const res = await membersPUT(req({ members: [DEVICE_A] }), params);
    expect(res.status).toBe(403);
    expect(mockReplaceMembers).not.toHaveBeenCalled();
  });

  it("full-replaces in the given ORDER and returns the new state", async () => {
    const res = await membersPUT(
      req({ members: [DEVICE_A, DEVICE_B] }),
      params,
    );
    expect(res.status).toBe(200);
    expect(mockReplaceMembers).toHaveBeenCalledWith(AREA_UUID, [
      DEVICE_A,
      DEVICE_B,
    ]);
    expect((await res.json()).members[0].id).toBe(DEVICE_A);
    expect(mockRefresh).toHaveBeenCalledWith(AREA_UUID);
  });

  it("409s an add on a device's own area, but lets an unchanged restatement through", async () => {
    mockDeviceByHandle.mockResolvedValue({ id: 1000002 } as any);
    const refused = await membersPUT(
      req({ members: [DEVICE_A, DEVICE_B] }),
      params,
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("AREA_OF_ONE_CANNOT_ADD");
    expect(mockReplaceMembers).not.toHaveBeenCalled();

    mockResolveMembers.mockResolvedValueOnce({
      ok: true,
      deviceIds: [DEVICE_A],
      systemIds: [1],
    } as any);
    const unchanged = await membersPUT(req({ members: [DEVICE_A] }), params);
    expect(unchanged.status).toBe(200);
    expect(mockReplaceMembers).toHaveBeenCalledWith(AREA_UUID, [DEVICE_A]);
  });

  it("422s the DAO's validation errors (last member, duplicate) without refreshing", async () => {
    mockReplaceMembers.mockRejectedValueOnce(
      new AreaValidationError("An area must have at least one member") as any,
    );
    const res = await membersPUT(req({ members: [DEVICE_A] }), params);
    expect(res.status).toBe(422);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("PUT /api/v4/areas/{id}/bindings", () => {
  const good = {
    role: "solar",
    metricType: "power",
    pointId: POINT,
  };

  it("422s a non-array body", async () => {
    const res = await bindingsPUT(req({ bindings: "nope" }), params);
    expect(res.status).toBe(422);
    expect(mockReplaceBindings).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing role", { metricType: "power", pointId: POINT }],
    ["a missing metricType", { role: "solar", pointId: POINT }],
    ["a non-pt_ pointId", { ...good, pointId: Area.generate() }],
    ["a negative priority", { ...good, priority: -1 }],
    ["a non-integer priority", { ...good, priority: 1.5 }],
  ])("422s %s at the seam", async (_label, entry) => {
    const res = await bindingsPUT(req({ bindings: [entry] }), params);
    expect(res.status).toBe(422);
    expect(mockReplaceBindings).not.toHaveBeenCalled();
  });

  it("accepts an EMPTY list — that is how an area returns to union-default resolution", async () => {
    const res = await bindingsPUT(req({ bindings: [] }), params);
    expect(res.status).toBe(200);
    expect(mockReplaceBindings).toHaveBeenCalledWith(AREA_UUID, []);
    expect(mockRefresh).toHaveBeenCalledWith(AREA_UUID);
  });

  it("decodes pt_ ids and passes an explicit priority through", async () => {
    const res = await bindingsPUT(
      req({ bindings: [{ ...good, priority: 2, transform: "negate" }] }),
      params,
    );
    expect(res.status).toBe(200);
    expect(mockReplaceBindings).toHaveBeenCalledWith(AREA_UUID, [
      {
        role: "solar",
        metricType: "power",
        pointId: POINT,
        priority: 2,
        transform: "negate",
      },
    ]);
  });

  it("422s the DAO's validation errors (unknown role, non-member point) without refreshing", async () => {
    mockReplaceBindings.mockRejectedValueOnce(
      new AreaValidationError("Unknown role: banana") as any,
    );
    const res = await bindingsPUT(req({ bindings: [good] }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Unknown role/);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("🛑 every mutation refreshes derived serving state", () => {
  // `refreshAreaServing` rebuilds the KV subscription registry, which is DERIVED from exactly the rows
  // these handlers write. A handler that returned before calling it would pass every payload assertion
  // and still leave the area serving its previous point set. Asserted here per handler, once, so the
  // omission cannot slip into a new one unnoticed.
  it.each([
    [
      "POST /areas",
      () => areasPOST(req({ name: "Site", members: [DEVICE_A] })),
    ],
    ["PATCH /areas/{id}", () => areaPATCH(req({ name: "New" }), params)],
    ["DELETE /areas/{id}", () => areaDELETE(req(), params)],
    [
      "PUT /areas/{id}/members",
      () => membersPUT(req({ members: [DEVICE_A] }), params),
    ],
    [
      "PUT /areas/{id}/bindings",
      () => bindingsPUT(req({ bindings: [] }), params),
    ],
  ])("%s calls refreshAreaServing", async (_label, run) => {
    await run();
    expect(mockRefresh).toHaveBeenCalledWith(AREA_UUID);
  });
});
