import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// loadAreaForOwner authenticates via requireAuth (Clerk + isUserAdmin) then resolves the area row via
// loadAreaForAuth's drizzle select. Mock both layers with a tiny table-aware fake, mirroring
// lib/__tests__/user-preferences.test.ts.
let areaRow: Record<string, unknown> | null;
let clerkUserId: string | null = "owner_1";
let isAdmin = false;

jest.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerkUserId }),
}));
jest.mock("@/lib/auth-utils", () => ({
  isUserAdmin: () => Promise.resolve(isAdmin),
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.from = () => builder;
    // config-v4 Phase 13 PR 5: `loadAreaForAuth` LEFT-joins `legacy_handles` for the integer handle,
    // which is no longer a column on `areas`.
    builder.leftJoin = () => builder;
    builder.where = () => builder;
    builder.limit = () => Promise.resolve(areaRow ? [areaRow] : []);
    return builder;
  },
}));

import { loadAreaForOwner } from "../http";
import { Area } from "@/lib/ids";

const AREA_UUID = "00000000-0000-7000-8000-000000000001";
const AREA_ID = Area.encode(AREA_UUID);

function req(): NextRequest {
  return {
    url: "http://localhost/api/areas/x",
    method: "GET",
    headers: new Headers(),
  } as unknown as NextRequest;
}

beforeEach(() => {
  clerkUserId = "owner_1";
  isAdmin = false;
  areaRow = {
    id: AREA_UUID,
    ownerClerkUserId: "owner_1",
    legacySystemId: 7,
    status: "active",
    displayName: "Test Area",
    location: null,
  };
});

describe("loadAreaForOwner", () => {
  it("malformed id -> 400", async () => {
    const r = await loadAreaForOwner(req(), "not-an-area-id");
    if (!("error" in r)) throw new Error("expected an error result");
    expect(r.error.status).toBe(400);
  });

  it("a raw uuid (not ar_) is rejected -> 400 (strict decode, unlike the dual-accept descriptor seam)", async () => {
    const r = await loadAreaForOwner(req(), AREA_UUID);
    if (!("error" in r)) throw new Error("expected an error result");
    expect(r.error.status).toBe(400);
  });

  it("well-formed but unknown area -> 404", async () => {
    areaRow = null;
    const r = await loadAreaForOwner(req(), AREA_ID);
    if (!("error" in r)) throw new Error("expected an error result");
    expect(r.error.status).toBe(404);
  });

  it("well-formed, known, but not owned (and not admin) -> 403", async () => {
    clerkUserId = "someone_else";
    const r = await loadAreaForOwner(req(), AREA_ID);
    if (!("error" in r)) throw new Error("expected an error result");
    expect(r.error.status).toBe(403);
  });

  it("owner -> resolves with the raw uuid below the seam", async () => {
    const r = await loadAreaForOwner(req(), AREA_ID);
    if ("error" in r) throw new Error("expected a success result");
    expect(r.userId).toBe("owner_1");
    expect(r.isAdmin).toBe(false);
    expect(r.area.id).toBe(AREA_UUID);
  });

  it("admin (not owner) -> resolves too", async () => {
    clerkUserId = "admin_1";
    isAdmin = true;
    const r = await loadAreaForOwner(req(), AREA_ID);
    if ("error" in r) throw new Error("expected a success result");
    expect(r.isAdmin).toBe(true);
    expect(r.area.id).toBe(AREA_UUID);
  });

  it("unauthenticated -> the requireAuth 401 passes through", async () => {
    clerkUserId = null;
    const r = await loadAreaForOwner(req(), AREA_ID);
    if (!("error" in r)) throw new Error("expected an error result");
    expect(r.error).toBeInstanceOf(NextResponse);
    expect(r.error.status).toBe(401);
  });
});
