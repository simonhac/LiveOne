/**
 * ROUTE-level tests for `/api/v4/dashboards*` (config-v4 Phase 14 STEP 0).
 *
 * The v4 HELPER libs were already well covered (`lib/dashboard/__tests__/v4-{routes,seed,validate}`),
 * but every one of those mocks its dependencies and never constructs a request or imports a route
 * module — so nothing exercised the handlers themselves. These do: they stub only the DB/auth seams
 * (`@/lib/api-auth`, the dashboards DAO, the readable-area/device lists, the seeder) and run the REAL
 * route exports through REAL `NextRequest`s, so request parsing, `If-Match` branching, the §8.4
 * reference check and the whole error map are under test.
 *
 * Companion: `scripts/utils/v4-surface-smoke.ts` drives the same handlers end-to-end against a live
 * dev server + Postgres. This file covers what only a mock can reach — the 403-not-owner branch, the
 * 503 device-mapping branch, and a DAO that throws.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Area, Device } from "@/lib/ids";

const OWNER = "user_owner";
const OTHER = "user_other";
const DASHBOARD_ID = "db_00000000000000000000000001";

jest.mock("@/lib/api-auth", () => ({
  requireAuth: jest.fn(),
}));
jest.mock("@/lib/areas/list", () => ({ listReadableAreas: jest.fn() }));
jest.mock("@/lib/devices/list", () => ({ listReadableDevices: jest.fn() }));
jest.mock("@/lib/areas/http", () => ({ findReadableArea: jest.fn() }));
jest.mock("@/lib/dashboard/v4-seed", () => {
  class MissingDeviceMappingError extends Error {
    constructor(public readonly handles: number[]) {
      super("missing mapping");
      this.name = "MissingDeviceMappingError";
    }
  }
  return {
    MissingDeviceMappingError,
    buildPersistableSeedDoc: jest.fn(),
    buildSeedGroupPreview: jest.fn(),
  };
});
jest.mock("@/lib/dashboard/dashboards", () => {
  class DashboardAliasTakenError extends Error {
    constructor() {
      super("alias already in use");
      this.name = "DashboardAliasTakenError";
    }
  }
  return {
    DashboardAliasTakenError,
    getDashboard: jest.fn(),
    createDashboard: jest.fn(),
    updateDashboard: jest.fn(),
    updateDashboardDoc: jest.fn(),
    deleteDashboard: jest.fn(),
    listAccessibleDashboards: jest.fn(),
  };
});

import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { listReadableDevices } from "@/lib/devices/list";
import { findReadableArea } from "@/lib/areas/http";
import {
  buildPersistableSeedDoc,
  MissingDeviceMappingError,
} from "@/lib/dashboard/v4-seed";
import {
  getDashboard,
  createDashboard,
  updateDashboard,
  updateDashboardDoc,
  deleteDashboard,
  listAccessibleDashboards,
  DashboardAliasTakenError,
} from "@/lib/dashboard/dashboards";
import { GET as listGET, POST as collectionPOST } from "../dashboards/route";
import { GET, PUT, PATCH, DELETE } from "../dashboards/[id]/route";
import { POST as VALIDATE } from "../dashboards/[id]/validate/route";

const mockAuth = jest.mocked(requireAuth);
const mockAreas = jest.mocked(listReadableAreas);
const mockDevices = jest.mocked(listReadableDevices);
const mockFindArea = jest.mocked(findReadableArea);
const mockSeed = jest.mocked(buildPersistableSeedDoc);
const mockGet = jest.mocked(getDashboard);
const mockCreate = jest.mocked(createDashboard);
const mockUpdate = jest.mocked(updateDashboard);
const mockUpdateDoc = jest.mocked(updateDashboardDoc);
const mockDelete = jest.mocked(deleteDashboard);
const mockList = jest.mocked(listAccessibleDashboards);

const params = { params: Promise.resolve({ id: DASHBOARD_ID }) };

function req(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost/api/v4/dashboards/${DASHBOARD_ID}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function dashboardRow(over: Record<string, unknown> = {}) {
  return {
    id: DASHBOARD_ID,
    ownerClerkUserId: OWNER,
    displayName: "Home",
    alias: "home",
    doc: { version: 4, root: { id: "n_0", kind: "group", children: [] } },
    revision: 7,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as any;
}

const AREA = Area.generate();
const DEVICE = Device.generate();

function docBoundTo(areaId: string = AREA) {
  return {
    version: 4,
    root: {
      kind: "group",
      children: [
        {
          kind: "group",
          area: areaId,
          heading: true,
          children: [{ kind: "card", type: "sankey" }],
        },
      ],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    userId: OWNER,
    isAdmin: false,
    isCron: false,
    isClaudeDev: false,
  } as any);
  mockGet.mockResolvedValue(dashboardRow());
  mockAreas.mockResolvedValue([
    { id: Area.toUuid(AREA), displayName: "Area", legacySystemId: 1 },
  ]);
  mockDevices.mockResolvedValue([
    {
      id: DEVICE,
      name: "Device",
      systemId: 1,
      vendor: "test",
      status: "active",
    },
  ]);
  mockUpdateDoc.mockImplementation(async (_id, doc) => ({
    ok: true,
    revision: 8,
    doc,
  }));
});

// ---------------------------------------------------------------------------
describe("auth + ownership (shared loader, every /dashboards/{id} handler)", () => {
  it("propagates the 401 from requireAuth without touching the DAO", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as any,
    );
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("404s an unknown / undecodable id", async () => {
    mockGet.mockResolvedValue(null);
    for (const run of [
      () => GET(req("GET"), params),
      () => PUT(req("PUT", { doc: docBoundTo() }), params),
      () => PATCH(req("PATCH", { name: "x" }), params),
      () => DELETE(req("DELETE"), params),
      () => VALIDATE(req("POST", { doc: docBoundTo() }), params),
    ]) {
      expect((await run()).status).toBe(404);
    }
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("403s a non-owner who is not an admin, and never mutates", async () => {
    mockAuth.mockResolvedValue({
      userId: OTHER,
      isAdmin: false,
      isCron: false,
      isClaudeDev: false,
    } as any);
    expect((await GET(req("GET"), params)).status).toBe(403);
    expect((await DELETE(req("DELETE"), params)).status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("lets a platform admin through on the auth context alone (no second admin lookup)", async () => {
    mockAuth.mockResolvedValue({
      userId: OTHER,
      isAdmin: true,
      isCron: false,
      isClaudeDev: false,
    } as any);
    expect((await GET(req("GET"), params)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/dashboards/{id}", () => {
  it("returns the v4 wire shape and an ETag matching the revision", async () => {
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"7"');
    const body = await res.json();
    // `slug`/`name`, NOT the DAO's `alias`/`displayName` — PATCH takes {name, slug}, so echoing the
    // legacy keys made GET→edit→PATCH impossible. Nothing called this surface, so nothing noticed.
    expect(body).toEqual({
      id: DASHBOARD_ID,
      name: "Home",
      slug: "home",
      revision: 7,
      doc: { version: 4, root: { id: "n_0", kind: "group", children: [] } },
    });
    expect(body).not.toHaveProperty("alias");
    expect(body).not.toHaveProperty("displayName");
  });
});

// ---------------------------------------------------------------------------
describe("PUT /api/v4/dashboards/{id}", () => {
  it("validates, checks refs, writes, and echoes the normalized doc + ETag", async () => {
    const res = await PUT(req("PUT", { doc: docBoundTo() }), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"8"');
    const body = await res.json();
    expect(body.revision).toBe(8);
    // Normalization ran: every node came back with a server-assigned id.
    expect(body.doc.root.id).toMatch(/^n_/);
    expect(body.doc.root.children[0].children[0].id).toMatch(/^n_/);
    expect(body.warnings).toEqual([]);
  });

  it("422s an invalid doc and persists nothing", async () => {
    const res = await PUT(req("PUT", { doc: { version: 4 } }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).errors.length).toBeGreaterThan(0);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("422s a missing/malformed body rather than throwing", async () => {
    expect((await PUT(req("PUT", {}), params)).status).toBe(422);
    const raw = new NextRequest(
      `http://localhost/api/v4/dashboards/${DASHBOARD_ID}`,
      {
        method: "PUT",
        body: "not json",
        headers: { "content-type": "application/json" },
      },
    );
    expect((await PUT(raw, params)).status).toBe(422);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("403s a ref the OWNER cannot read — even when an admin is doing the writing (§8.4)", async () => {
    mockAuth.mockResolvedValue({
      userId: OTHER,
      isAdmin: true,
      isCron: false,
      isClaudeDev: false,
    } as any);
    mockAreas.mockResolvedValue([]); // owner reads nothing
    const res = await PUT(req("PUT", { doc: docBoundTo() }), params);
    expect(res.status).toBe(403);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    // The readability question is asked about the OWNER, not the admin actor — otherwise an admin
    // save would silently widen the doc's scope beyond what its owner may read.
    expect(mockAreas).toHaveBeenCalledWith(OWNER);
  });

  it("403s an unreadable DEVICE ref carried on a card envelope", async () => {
    mockDevices.mockResolvedValue([]);
    const doc: any = docBoundTo();
    doc.root.children[0].children[0].device = DEVICE;
    expect((await PUT(req("PUT", { doc }), params)).status).toBe(403);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("passes a matching If-Match through as the expected revision", async () => {
    await PUT(req("PUT", { doc: docBoundTo() }, { "if-match": '"7"' }), params);
    expect(mockUpdateDoc).toHaveBeenCalledWith(
      DASHBOARD_ID,
      expect.anything(),
      7,
    );
  });

  it("omits the expected revision when If-Match is absent (last-write-wins)", async () => {
    await PUT(req("PUT", { doc: docBoundTo() }), params);
    expect(mockUpdateDoc).toHaveBeenCalledWith(
      DASHBOARD_ID,
      expect.anything(),
      undefined,
    );
  });

  it("412s a revision conflict, reporting the current revision", async () => {
    mockUpdateDoc.mockResolvedValue({ ok: false, conflict: 9 } as any);
    const res = await PUT(
      req("PUT", { doc: docBoundTo() }, { "if-match": '"7"' }),
      params,
    );
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({
      error: "revision-conflict",
      current: 9,
    });
  });

  it("400s a malformed If-Match instead of silently ignoring it", async () => {
    const res = await PUT(
      req("PUT", { doc: docBoundTo() }, { "if-match": 'W/"7"' }),
      params,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid-if-match");
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("PATCH /api/v4/dashboards/{id}", () => {
  it("maps {name, slug} onto the DAO's {displayName, alias}", async () => {
    const res = await PATCH(
      req("PATCH", { name: " Home ", slug: " home " }),
      params,
    );
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(DASHBOARD_ID, {
      displayName: "Home",
      alias: "home",
    });
  });

  it("treats an empty/absent slug as an explicit clear, but leaves it alone when omitted", async () => {
    await PATCH(req("PATCH", { slug: "" }), params);
    expect(mockUpdate).toHaveBeenCalledWith(DASHBOARD_ID, { alias: null });
    mockUpdate.mockClear();
    await PATCH(req("PATCH", { slug: null }), params);
    expect(mockUpdate).toHaveBeenCalledWith(DASHBOARD_ID, { alias: null });
    mockUpdate.mockClear();
    await PATCH(req("PATCH", { name: "x" }), params);
    expect(mockUpdate).toHaveBeenCalledWith(DASHBOARD_ID, { displayName: "x" });
  });

  it("400s a whitespace-only name", async () => {
    const res = await PATCH(req("PATCH", { name: "   " }), params);
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("409s an alias collision instead of 500ing", async () => {
    // 🛑 The Phase 14 STEP 0 regression: the DAO's unique-violation predicate could not see the
    // SQLSTATE through drizzle's wrapper, so this threw past the route and became a bare 500.
    mockUpdate.mockRejectedValue(new DashboardAliasTakenError() as any);
    const res = await PATCH(req("PATCH", { slug: "taken" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already in use/);
  });

  it("rethrows a DAO error that is not an alias collision", async () => {
    mockUpdate.mockRejectedValue(new Error("boom") as any);
    await expect(PATCH(req("PATCH", { name: "x" }), params)).rejects.toThrow(
      "boom",
    );
  });
});

// ---------------------------------------------------------------------------
describe("DELETE /api/v4/dashboards/{id}", () => {
  it("deletes and returns success", async () => {
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledWith(DASHBOARD_ID);
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/v4/dashboards/{id}/validate", () => {
  it("never persists — it only reports", async () => {
    const res = await VALIDATE(req("POST", { doc: docBoundTo() }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.normalized.root.id).toMatch(/^n_/);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("reports an invalid doc as 200 valid:false with normalized:null", async () => {
    const res = await VALIDATE(req("POST", { doc: { version: 3 } }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.normalized).toBeNull();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("warns (does not reject) an unknown card type and keeps its opaque config (§8.4)", async () => {
    const res = await VALIDATE(
      req("POST", {
        doc: {
          version: 4,
          root: {
            kind: "group",
            children: [
              { kind: "card", type: "card-from-the-future", config: { k: 1 } },
            ],
          },
        },
      }),
      params,
    );
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.warnings[0].code).toBe("unknown-card-type");
    expect(body.normalized.root.children[0].config).toEqual({ k: 1 });
  });

  it("does NOT run the reference-readability check (dry-run is shape-only)", async () => {
    mockAreas.mockResolvedValue([]);
    const res = await VALIDATE(req("POST", { doc: docBoundTo() }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/dashboards", () => {
  it("projects the DAO summary onto v4 vocabulary", async () => {
    mockList.mockResolvedValue([
      {
        id: DASHBOARD_ID,
        displayName: "Home",
        alias: "home",
        cardCount: 3,
        revision: 7,
        updatedAt: new Date(0),
        access: "owner",
      },
    ]);
    const res = await listGET(
      new NextRequest("http://localhost/api/v4/dashboards"),
    );
    expect(res.status).toBe(200);
    const [row] = (await res.json()).dashboards;
    expect(row).toMatchObject({
      id: DASHBOARD_ID,
      name: "Home",
      slug: "home",
      revision: 7,
      cardCount: 3,
      access: "owner",
    });
    expect(row).not.toHaveProperty("displayName");
    expect(row).not.toHaveProperty("alias");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/v4/dashboards", () => {
  const post = (body: unknown) =>
    collectionPOST(
      new NextRequest("http://localhost/api/v4/dashboards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  beforeEach(() => {
    mockCreate.mockResolvedValue(DASHBOARD_ID);
    mockFindArea.mockResolvedValue({
      ok: true,
      area: {
        id: Area.toUuid(AREA),
        displayName: "Seeded Area",
        legacySystemId: 1,
      },
    } as any);
    mockSeed.mockResolvedValue(docBoundTo() as any);
  });

  it("400s with neither name nor seedArea", async () => {
    expect((await post({})).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("400s when seedArea and doc are both supplied", async () => {
    const res = await post({ seedArea: AREA, doc: docBoundTo() });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a bare dashboard at revision 1 when no doc is supplied", async () => {
    const res = await post({ name: "Home" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: DASHBOARD_ID, revision: 1 });
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("validates + ref-checks an explicit doc BEFORE creating the row", async () => {
    expect((await post({ name: "Home", doc: { version: 4 } })).status).toBe(
      422,
    );
    mockAreas.mockResolvedValue([]);
    expect((await post({ name: "Home", doc: docBoundTo() })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("writes the doc through the same DAO the PUT uses and reports its revision", async () => {
    const res = await post({ name: "Home", doc: docBoundTo() });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: DASHBOARD_ID, revision: 8 });
    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
  });

  it("defaults the name to the seed area's display name", async () => {
    await post({ seedArea: AREA });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Seeded Area" }),
    );
  });

  // config-v4 Phase 14 stage 15: this route used to pass `descriptor: emptyDashboardV3()`, purely
  // because the column was NOT NULL. It is the last thing that made a *v4* route touch the v3 shape.
  // Asserted on the exact argument (not `objectContaining`) so a re-added key fails here.
  it("passes NO descriptor to createDashboard — the v4 route never names the v3 shape", async () => {
    await post({ name: "Home", doc: docBoundTo() });
    expect(mockCreate).toHaveBeenCalledWith({
      ownerClerkUserId: OWNER,
      displayName: "Home",
      alias: null,
    });
  });

  it("maps a bad seedArea onto the loader's own status (400 malformed / 403 unreadable)", async () => {
    mockFindArea.mockResolvedValue({
      ok: false,
      status: 400,
      message: "Invalid area id",
    } as any);
    expect((await post({ seedArea: "nope" })).status).toBe(400);
    mockFindArea.mockResolvedValue({
      ok: false,
      status: 403,
      message: "Area not found or not readable",
    } as any);
    expect((await post({ seedArea: AREA })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("503s when the seeder cannot resolve a stable device mapping", async () => {
    mockSeed.mockRejectedValue(new MissingDeviceMappingError([42]) as any);
    const res = await post({ seedArea: AREA });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("device-mapping-incomplete");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("409s an alias collision instead of 500ing", async () => {
    mockCreate.mockRejectedValue(new DashboardAliasTakenError() as any);
    const res = await post({ name: "Home", slug: "taken" });
    expect(res.status).toBe(409);
  });
});
