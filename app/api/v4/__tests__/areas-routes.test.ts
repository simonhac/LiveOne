/**
 * ROUTE-level tests for the `/api/v4/areas*` reads (config-v4 Phase 14 STEP 0).
 *
 * Covers the branches a live smoke run cannot reach on real data: the `MissingDeviceMappingError` →
 * 503 mapping, `eligibility`'s per-member best-effort degradation, and the 400-vs-403 split the shared
 * `loadReadableArea` loader owns. `GET /api/v4/areas/{id}` itself is deliberately NOT covered here —
 * it is a drizzle query-builder chain over four tables, so a route test would assert the mock; its pure
 * wire serializer is covered by `lib/areas/__tests__/v4-shapes.test.ts` and its real behaviour by
 * `scripts/utils/v4-surface-smoke.ts`.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Area, Device } from "@/lib/ids";

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/areas/list", () => ({ listReadableAreas: jest.fn() }));
jest.mock("@/lib/areas/http", () => ({ loadReadableArea: jest.fn() }));
jest.mock("@/lib/areas/members", () => ({ getAreaMemberDeviceIds: jest.fn() }));
jest.mock("@/lib/areas/resolution", () => ({ resolveAreaSlots: jest.fn() }));
jest.mock("@/lib/capabilities/server", () => ({
  capabilitiesForDevice: jest.fn(),
}));
jest.mock("@/lib/registry", () => ({
  DeviceRegistry: { ridsForDevices: jest.fn() },
}));
jest.mock("@/lib/dashboard/v4-seed", () => {
  class MissingDeviceMappingError extends Error {
    constructor(public readonly handles: number[]) {
      super("missing mapping");
      this.name = "MissingDeviceMappingError";
    }
  }
  return {
    MissingDeviceMappingError,
    buildSeedGroupPreview: jest.fn(),
    buildPersistableSeedDoc: jest.fn(),
  };
});

import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { loadReadableArea } from "@/lib/areas/http";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { resolveAreaSlots } from "@/lib/areas/resolution";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { DeviceRegistry } from "@/lib/registry";
import {
  buildSeedGroupPreview,
  MissingDeviceMappingError,
} from "@/lib/dashboard/v4-seed";
import { GET as areasGET } from "../areas/route";
import { GET as defaultGroupGET } from "../areas/[id]/default-group/route";
import { GET as eligibilityGET } from "../areas/[id]/eligibility/route";
import { GET as resolutionGET } from "../areas/[id]/resolution/route";

const mockAuth = jest.mocked(requireAuth);
const mockListAreas = jest.mocked(listReadableAreas);
const mockLoad = jest.mocked(loadReadableArea);
const mockMembers = jest.mocked(getAreaMemberDeviceIds);
const mockResolve = jest.mocked(resolveAreaSlots);
const mockCaps = jest.mocked(capabilitiesForDevice);
const mockRids = jest.mocked(DeviceRegistry.ridsForDevices);
const mockSeedGroup = jest.mocked(buildSeedGroupPreview);

const AREA = Area.generate();
const AREA_UUID = Area.toUuid(AREA);
const DEVICE_A = Device.generate();
const DEVICE_B = Device.generate();

const req = (path = `http://localhost/api/v4/areas/${AREA}`) =>
  new NextRequest(path);
const params = { params: Promise.resolve({ id: AREA }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    userId: "user_1",
    isAdmin: false,
    isCron: false,
    isClaudeDev: false,
  } as any);
  mockLoad.mockResolvedValue({
    area: { id: AREA_UUID, displayName: "Area", legacySystemId: 1 },
    userId: "user_1",
  } as any);
  mockMembers.mockResolvedValue([DEVICE_A]);
  mockRids.mockResolvedValue(new Map([[DEVICE_A, 1]]) as any);
  mockCaps.mockResolvedValue(new Set(["solar/power"]) as any);
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/areas", () => {
  it("encodes ids as ar_ TypeIDs and defaults chartCapable to false", async () => {
    mockListAreas.mockResolvedValue([
      {
        id: AREA_UUID,
        displayName: "Alpha",
        legacySystemId: 1,
        chartCapable: true,
      },
      {
        id: Area.toUuid(Area.generate()),
        displayName: "Beta",
        legacySystemId: 2,
      },
    ] as any);
    const res = await areasGET(
      new NextRequest("http://localhost/api/v4/areas"),
    );
    expect(res.status).toBe(200);
    const { areas } = await res.json();
    // 🛑 `legacySystemId` is load-bearing: `clientShellResolver` turns it into the handle every card
    // fetches `/api/data?systemId=` with. It was missing, and because the surface was dark and
    // `fetchJson<T>` is an unchecked cast, its absence would have surfaced only as a dashboard of
    // permanent skeletons. Pinned as an exact-shape equality so a future "tidy-up" cannot drop it.
    expect(areas[0]).toEqual({
      id: AREA,
      displayName: "Alpha",
      legacySystemId: 1,
      chartCapable: true,
    });
    // `chartCapable` is always PRESENT — a client greying out chart cards must not have to
    // distinguish "false" from "the enrichment was not requested".
    expect(areas[1].chartCapable).toBe(false);
    expect(areas[1].id).toMatch(/^ar_/);
    expect(areas[1].legacySystemId).toBe(2);
  });

  it("asks for the chart-capability enrichment (the picker needs it)", async () => {
    mockListAreas.mockResolvedValue([]);
    await areasGET(new NextRequest("http://localhost/api/v4/areas"));
    expect(mockListAreas).toHaveBeenCalledWith("user_1", {
      withChartCapability: true,
    });
  });

  it("propagates a 401 from requireAuth", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as any,
    );
    const res = await areasGET(
      new NextRequest("http://localhost/api/v4/areas"),
    );
    expect(res.status).toBe(401);
    expect(mockListAreas).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("the shared loadReadableArea short-circuit", () => {
  it("returns the loader's own response verbatim on every {id} route", async () => {
    mockLoad.mockResolvedValue({
      error: NextResponse.json({ error: "Invalid area id" }, { status: 400 }),
    } as any);
    for (const run of [
      () => defaultGroupGET(req(), params),
      () => eligibilityGET(req(), params),
      () => resolutionGET(req(), params),
    ]) {
      const res = await run();
      expect(res.status).toBe(400);
    }
    expect(mockSeedGroup).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/areas/{id}/default-group", () => {
  it("wraps the seeder's group node", async () => {
    mockSeedGroup.mockResolvedValue({
      id: "n_1",
      kind: "group",
      area: AREA,
      heading: true,
      children: [],
    } as any);
    const res = await defaultGroupGET(req(), params);
    expect(res.status).toBe(200);
    expect((await res.json()).group.kind).toBe("group");
    expect(mockSeedGroup).toHaveBeenCalledWith(AREA_UUID, 1);
  });

  it("503s device-mapping-incomplete rather than 500ing", async () => {
    mockSeedGroup.mockRejectedValue(new MissingDeviceMappingError([7]) as any);
    const res = await defaultGroupGET(req(), params);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("device-mapping-incomplete");
  });

  it("rethrows any other seeder failure (a 503 must mean what it says)", async () => {
    mockSeedGroup.mockRejectedValue(new Error("boom") as any);
    await expect(defaultGroupGET(req(), params)).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/areas/{id}/eligibility", () => {
  it("keys deviceCards by `deviceId` carrying a dv_ TypeID", async () => {
    const res = await eligibilityGET(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.areaCards)).toBe(true);
    expect(Array.isArray(body.tiles)).toBe(true);
    expect(body.deviceCards).toHaveLength(1);
    expect(body.deviceCards[0].deviceId).toBe(DEVICE_A);
    expect(body.deviceCards[0]).not.toHaveProperty("systemId");
  });

  it("degrades one failing member to `cards: []` without failing the route", async () => {
    mockMembers.mockResolvedValue([DEVICE_A, DEVICE_B]);
    mockRids.mockResolvedValue(
      new Map([
        [DEVICE_A, 1],
        [DEVICE_B, 2],
      ]) as any,
    );
    mockCaps.mockImplementation(async (handle: unknown) => {
      if (handle === 2) throw new Error("capability lookup failed");
      return new Set(["solar/power"]) as any;
    });
    const res = await eligibilityGET(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deviceCards).toHaveLength(2);
    expect(body.deviceCards[1]).toEqual({ deviceId: DEVICE_B, cards: [] });
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v4/areas/{id}/resolution", () => {
  it("returns the resolver's report unchanged", async () => {
    mockResolve.mockResolvedValue({ areaId: AREA, slots: [] } as any);
    const res = await resolutionGET(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ areaId: AREA, slots: [] });
    expect(mockResolve).toHaveBeenCalledWith(AREA_UUID, 1);
  });
});
