/**
 * ROUTE-level tests for the four reads that were the last to get a `/api/v4` address:
 *
 *   GET /api/v4/devices                              ← GET /api/areas/candidate-devices
 *   GET /api/v4/areas/by-handle/{handle}             ← GET /api/areas/by-handle/{legacySystemId}
 *   GET /api/v4/areas/{ar_…}/provenance-daily        ← GET /api/areas/{areaId}/provenance-daily
 *   GET /api/v4/areas/{ar_…}/provenance-summary      ← GET /api/areas/{areaId}/provenance-summary
 *
 * These pin the parts a live smoke run cannot reach: the auth SWITCH inside provenance-daily (share-
 * token gate for a handled area vs owner/admin/cron for an unhandled one), the date-window clamps and
 * their error/empty split, and — the one that matters most — the exact key mapping `/api/v4/devices`
 * applies to its legacy twin's rows. `scripts/utils/v4-surface-smoke.ts` proves the same four against a
 * real database and their real legacy twins, value-by-value; this file proves the branches that need a
 * database state nobody has.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Area, Device } from "@/lib/ids";

jest.mock("@/lib/api-auth", () => ({
  requireAuth: jest.fn(),
  getAuthContext: jest.fn(),
  requireDashboardAccess: jest.fn(),
}));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { devicesVisibleByUser: jest.fn() },
}));
jest.mock("@/lib/areas/provenance-auth", () => {
  const actual = jest.requireActual(
    "@/lib/areas/provenance-auth",
  ) as typeof import("@/lib/areas/provenance-auth");
  return {
    loadProvenanceArea: jest.fn(),
    forbidUnlessOwnerAdminOrCron: actual.forbidUnlessOwnerAdminOrCron,
  };
});
jest.mock("@/lib/battery-provenance/reads", () => {
  const actual = jest.requireActual(
    "@/lib/battery-provenance/reads",
  ) as typeof import("@/lib/battery-provenance/reads");
  return {
    ...actual,
    readProvenanceDaily: jest.fn(),
    readProvenanceSummary: jest.fn(),
  };
});

import {
  requireAuth,
  getAuthContext,
  requireDashboardAccess,
} from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { loadProvenanceArea } from "@/lib/areas/provenance-auth";
import {
  readProvenanceDaily,
  readProvenanceSummary,
} from "@/lib/battery-provenance/reads";
import { GET as devicesGET } from "../devices/route";
import { GET as byHandleGET } from "../areas/by-handle/[handle]/route";
import { GET as dailyGET } from "../areas/[id]/provenance-daily/route";
import { GET as summaryGET } from "../areas/[id]/provenance-summary/route";

const mockRequireAuth = jest.mocked(requireAuth);
const mockAuthContext = jest.mocked(getAuthContext);
const mockDashboardAccess = jest.mocked(requireDashboardAccess);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockVisible = jest.mocked(DeviceConfigRegistry.devicesVisibleByUser);
const mockLoadArea = jest.mocked(loadProvenanceArea);
const mockReadDaily = jest.mocked(readProvenanceDaily);
const mockReadSummary = jest.mocked(readProvenanceSummary);

const AREA = Area.generate();
const AREA_UUID = Area.toUuid(AREA);
const DEVICE = Device.generate();
const DEVICE_UUID = Device.toUuid(DEVICE);

/** A drizzle select chain that resolves to `rows` however many links are chained onto it. */
function selectChain(rows: unknown[]) {
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then")
          return (...a: any[]) => Promise.resolve(rows).then(...(a as [any]));
        return () => chain;
      },
    },
  );
  return { select: () => chain };
}

const anonAuth = {
  userId: null,
  isAdmin: false,
  isCron: false,
  isClaudeDev: false,
};
const ownerAuth = { ...anonAuth, userId: "user_1" };
const cronAuth = { ...anonAuth, isCron: true };
const adminAuth = { ...ownerAuth, userId: "user_other", isAdmin: true };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAuth.mockResolvedValue(ownerAuth as any);
  mockAuthContext.mockResolvedValue(ownerAuth as any);
  mockDb.mockReturnValue(selectChain([]) as any);
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/devices — the candidate-devices twin", () => {
  const legacyRow = {
    id: 7,
    displayName: "Kinkora Fronius",
    vendorSiteId: "site-99",
    vendorType: "fronius",
    status: "active",
    ownerClerkUserId: "user_1",
    alias: "kink",
  };

  it("maps EVERY legacy key across — nothing dropped, id becomes a dv_ TypeID", async () => {
    mockVisible.mockResolvedValue([legacyRow] as any);
    mockDb.mockReturnValue(selectChain([{ rid: 7, id: DEVICE_UUID }]) as any);
    const res = await devicesGET(
      new NextRequest("http://localhost/api/v4/devices"),
    );
    expect(res.status).toBe(200);
    const { devices } = await res.json();
    // 🛑 An exact-shape equality, deliberately: STEP 0's defect D2 was a v4 read that silently
    // narrowed its payload, which no status-code assertion can see. Every legacy key has a home here
    // and the integer `id` is carried, not replaced.
    expect(devices).toEqual([
      {
        id: DEVICE,
        legacySystemId: 7,
        name: "Kinkora Fronius",
        slug: "kink",
        vendor: "fronius",
        vendorSiteId: "site-99",
        status: "active",
        ownerUserId: "user_1",
      },
    ]);
  });

  it("asks only for ACTIVE devices — the same visible set the legacy twin picks from", async () => {
    mockVisible.mockResolvedValue([]);
    await devicesGET(new NextRequest("http://localhost/api/v4/devices"));
    expect(mockVisible).toHaveBeenCalledWith("user_1", true);
  });

  it("skips the rid→uuid query entirely when nothing is visible", async () => {
    mockVisible.mockResolvedValue([]);
    const res = await devicesGET(
      new NextRequest("http://localhost/api/v4/devices"),
    );
    expect(await res.json()).toEqual({ devices: [] });
    expect(mockDb).not.toHaveBeenCalled();
  });

  it("degrades a missing rid→uuid mapping to a null id, never a 500", async () => {
    mockVisible.mockResolvedValue([legacyRow] as any);
    mockDb.mockReturnValue(selectChain([]) as any);
    const res = await devicesGET(
      new NextRequest("http://localhost/api/v4/devices"),
    );
    expect(res.status).toBe(200);
    const { devices } = await res.json();
    expect(devices[0].id).toBeNull();
    expect(devices[0].legacySystemId).toBe(7);
  });

  it("propagates a 401 from requireAuth without touching the registry", async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as any,
    );
    const res = await devicesGET(
      new NextRequest("http://localhost/api/v4/devices"),
    );
    expect(res.status).toBe(401);
    expect(mockVisible).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/areas/by-handle/{handle}", () => {
  const areaRow = {
    id: AREA_UUID,
    ownerClerkUserId: "user_1",
    legacySystemId: 1000002,
    displayName: "Daylesford",
    alias: "dayl",
  };
  const call = (handle: string) =>
    byHandleGET(
      new NextRequest(`http://localhost/api/v4/areas/by-handle/${handle}`),
      { params: Promise.resolve({ handle }) },
    );

  it("resolves the handle to the area's ar_ TypeID, carrying the twin's keys verbatim", async () => {
    mockDb.mockReturnValue(selectChain([areaRow]) as any);
    const res = await call("1000002");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      areaId: AREA,
      systemId: 1000002,
      displayName: "Daylesford",
      alias: "dayl",
    });
  });

  it("400s a non-integer handle before hitting the database", async () => {
    const res = await call("ar_01k9fahd43fkbb2ge7dwsjhzqf");
    expect(res.status).toBe(400);
    expect(mockDb).not.toHaveBeenCalled();
  });

  it("404s an unknown handle", async () => {
    mockDb.mockReturnValue(selectChain([]) as any);
    expect((await call("999")).status).toBe(404);
  });

  it("401s a caller who is neither signed in nor cron, before the lookup", async () => {
    mockAuthContext.mockResolvedValue(anonAuth as any);
    const res = await call("1000002");
    expect(res.status).toBe(401);
    expect(mockDb).not.toHaveBeenCalled();
  });

  it("403s a signed-in non-owner, non-admin", async () => {
    mockAuthContext.mockResolvedValue({
      ...ownerAuth,
      userId: "someone_else",
    } as any);
    mockDb.mockReturnValue(selectChain([areaRow]) as any);
    expect((await call("1000002")).status).toBe(403);
  });

  // 🛑 The reason this route is in publicRoutes at all: a headless CRON_SECRET bearer has no userId.
  it.each([
    ["a CRON_SECRET bearer", cronAuth],
    ["an admin", adminAuth],
  ])("authorizes %s", async (_label, auth) => {
    mockAuthContext.mockResolvedValue(auth as any);
    mockDb.mockReturnValue(selectChain([areaRow]) as any);
    expect((await call("1000002")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
const handledArea = {
  uuid: AREA_UUID,
  ownerClerkUserId: "user_1",
  legacySystemId: 8,
  timezoneOffsetMin: 600,
};
const unhandledArea = { ...handledArea, legacySystemId: null };

const dailyCall = (qs = "") =>
  dailyGET(
    new NextRequest(
      `http://localhost/api/v4/areas/${AREA}/provenance-daily${qs}`,
    ),
    { params: Promise.resolve({ id: AREA }) },
  );

describe("GET /api/v4/areas/{ar_…}/provenance-daily", () => {
  beforeEach(() => {
    mockLoadArea.mockResolvedValue({ area: handledArea } as any);
    mockDashboardAccess.mockResolvedValue({ canRead: true } as any);
    mockReadDaily.mockResolvedValue({ days: ["2026-07-30"] } as any);
  });

  // 🛑 THE AUTH SWITCH. A handled area takes the share-token-aware dashboard gate — that leg is the
  // entire reason this route lives in `shareableRoutes` rather than `publicRoutes`, and it is what an
  // anonymous `?access=` viewer's history panel depends on.
  it("gates a HANDLED area through requireDashboardAccess (the share-token leg)", async () => {
    const res = await dailyCall();
    expect(res.status).toBe(200);
    expect(mockDashboardAccess).toHaveBeenCalledWith(expect.anything(), 8);
    expect(mockAuthContext).not.toHaveBeenCalled();
  });

  it("returns requireDashboardAccess's own rejection verbatim", async () => {
    mockDashboardAccess.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }) as any,
    );
    expect((await dailyCall()).status).toBe(403);
    expect(mockReadDaily).not.toHaveBeenCalled();
  });

  it("falls back to the owner/admin/cron gate for an UNHANDLED area", async () => {
    mockLoadArea.mockResolvedValue({ area: unhandledArea } as any);
    mockAuthContext.mockResolvedValue({
      ...ownerAuth,
      userId: "someone_else",
    } as any);
    expect((await dailyCall()).status).toBe(403);
    expect(mockDashboardAccess).not.toHaveBeenCalled();
  });

  it("short-circuits on the loader's own 400/404", async () => {
    mockLoadArea.mockResolvedValue({
      error: NextResponse.json({ error: "Invalid area id" }, { status: 400 }),
    } as any);
    expect((await dailyCall()).status).toBe(400);
    expect(mockReadDaily).not.toHaveBeenCalled();
  });

  it("400s malformed date params", async () => {
    const res = await dailyCall("?last=nonsense");
    expect(res.status).toBe(400);
    expect(mockReadDaily).not.toHaveBeenCalled();
  });

  it("400s a caller's own start-after-end", async () => {
    expect((await dailyCall("?start=2026-03-01&end=2026-02-01")).status).toBe(
      400,
    );
  });

  // The clamp order matters: a window entirely before the birthdate is EMPTY, not an error.
  it("returns an empty dense payload for a window entirely before the LiveOne birthdate", async () => {
    const res = await dailyCall("?start=2024-01-01&end=2024-06-01");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toEqual([]);
    expect(body.areaId).toBe(AREA);
    expect(body.systemId).toBe(8);
    expect(Object.values(body.fields).every((v) => Array.isArray(v))).toBe(
      true,
    );
    expect(mockReadDaily).not.toHaveBeenCalled();
  });

  it("caps the span at 400 days by clamping START up, keeping the caller's end", async () => {
    // 683 days, all of it after the birthdate — so the SPAN cap, not the birthdate clamp, is what bites.
    await dailyCall("?start=2025-08-16&end=2027-06-30");
    const [, , , window] = mockReadDaily.mock.calls[0] as any;
    expect(window.end.toString()).toBe("2027-06-30");
    expect(window.start.toString()).toBe("2026-05-27"); // end − 399 days
  });

  it("clamps a pre-birthdate start UP to the birthdate", async () => {
    await dailyCall("?start=2025-01-01&end=2025-09-01");
    const [, , , window] = mockReadDaily.mock.calls[0] as any;
    expect(window.start.toString()).toBe("2025-08-16");
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/areas/{ar_…}/provenance-summary", () => {
  const summaryCall = (qs = "") =>
    summaryGET(
      new NextRequest(
        `http://localhost/api/v4/areas/${AREA}/provenance-summary${qs}`,
      ),
      { params: Promise.resolve({ id: AREA }) },
    );

  beforeEach(() => {
    mockLoadArea.mockResolvedValue({ area: handledArea } as any);
    mockReadSummary.mockResolvedValue([]);
  });

  it("carries the twin's keys verbatim (ok/areaId/systemId/range/sources)", async () => {
    mockReadSummary.mockResolvedValue([{ sourcePath: "source.grid" }] as any);
    const res = await summaryCall("?start=2026-01-01&end=2026-01-31");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      areaId: AREA,
      systemId: 8,
      range: { start: "2026-01-01", end: "2026-01-31" },
      sources: [{ sourcePath: "source.grid" }],
    });
  });

  it("defaults to FULL HISTORY from the birthdate (not the daily route's trailing year)", async () => {
    await summaryCall("?end=2026-07-30");
    const [, , window] = mockReadSummary.mock.calls[0] as any;
    expect(window.start.toString()).toBe("2025-08-16");
    expect(window.end.toString()).toBe("2026-07-30");
  });

  it("401s before the lookup when the caller is neither signed in nor cron", async () => {
    mockAuthContext.mockResolvedValue(anonAuth as any);
    expect((await summaryCall()).status).toBe(401);
    expect(mockLoadArea).not.toHaveBeenCalled();
  });

  it("403s a signed-in non-owner", async () => {
    mockAuthContext.mockResolvedValue({
      ...ownerAuth,
      userId: "someone_else",
    } as any);
    expect((await summaryCall()).status).toBe(403);
    expect(mockReadSummary).not.toHaveBeenCalled();
  });

  it("authorizes a CRON_SECRET bearer (the publicRoutes rationale)", async () => {
    mockAuthContext.mockResolvedValue(cronAuth as any);
    expect((await summaryCall()).status).toBe(200);
  });

  it("400s malformed date params and start-after-end", async () => {
    expect((await summaryCall("?last=0d")).status).toBe(400);
    expect((await summaryCall("?start=2026-03-01&end=2026-02-01")).status).toBe(
      400,
    );
    expect(mockReadSummary).not.toHaveBeenCalled();
  });
});
