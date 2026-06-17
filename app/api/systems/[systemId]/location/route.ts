import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSystemAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { ensureIdentityArea } from "@/lib/areas/sync";
import {
  mergeAreaLocation,
  type AreaLocationPatch,
} from "@/lib/areas/location";
import { nemRegionForLocation } from "@/lib/vendors/openelectricity/region";
import type { AreaLocation } from "@/lib/areas/types";

/**
 * Owner-facing editor for a SITE's physical location. Location is a property of the **Area** (the
 * semantic site), not of a dashboard — a dashboard can show cards from multiple Areas (per-card
 * `area_id` override), so it has no single location. Stored on `areas.location`; DERIVES the NEM grid
 * region for the Local Grid card (lib/grid/context.ts), which itself resolves region per-Area.
 *
 * Keyed on `systemId` (all addressing is still integer-systemId today): resolves the system's Area
 * (identity or composite) and, for a physical system that predates the runtime identity-Area seam,
 * heals it via `ensureIdentityArea`.
 *
 * GET: read access. PUT: owner/admin write — merge-patches the location and returns the derived region.
 */

/** The current location for `systemId`'s Area (null if none/un-backfilled). Read-only — never mutates. */
async function readLocation(systemId: number): Promise<AreaLocation | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ location: areas.location })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  return row?.location ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const systemId = parseInt(s, 10);
  if (isNaN(systemId)) {
    return NextResponse.json({ error: "Invalid system id" }, { status: 400 });
  }
  const auth = await requireSystemAccess(request, systemId);
  if (auth instanceof NextResponse) return auth;

  const location = await readLocation(systemId);
  return NextResponse.json({
    location,
    region: nemRegionForLocation(location),
  });
}

/** Coerce an untyped JSON body into a typed location patch (string fields trimmed downstream). */
function toPatch(body: unknown): AreaLocationPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null | undefined =>
    v === null ? null : typeof v === "string" ? v : undefined;
  const num = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === "number" ? v : undefined;
  return {
    country: str(b.country),
    state: str(b.state),
    postcode: str(b.postcode),
    lat: num(b.lat),
    lng: num(b.lng),
  };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const systemId = parseInt(s, 10);
  if (isNaN(systemId)) {
    return NextResponse.json({ error: "Invalid system id" }, { status: 400 });
  }
  // Setting a site's location is an owner action → require write access.
  const auth = await requireSystemAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  // Resolve the Area to write. A physical system that predates the runtime identity-Area seam may
  // not have one yet — heal it here. A composite always has its Area (createCompositeArea).
  const existingArea = await getAreaForSystem(systemId);
  let areaId: string;
  if (existingArea) {
    areaId = existingArea.id;
  } else if (auth.system.vendorType === "composite") {
    return NextResponse.json(
      { error: "Composite Area not found" },
      { status: 500 },
    );
  } else {
    areaId = await ensureIdentityArea(auth.system);
  }

  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({ location: areas.location })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  const merged = mergeAreaLocation(
    row?.location ?? null,
    toPatch(await request.json().catch(() => ({}))),
  );
  await db
    .update(areas)
    .set({ location: merged, updatedAt: new Date() })
    .where(eq(areas.id, areaId));

  // A composite's synthesized virtual system copies areas.location; it's loaded fresh per request,
  // so the edit is reflected on the next read with nothing to invalidate.
  return NextResponse.json({
    location: merged,
    region: nemRegionForLocation(merged),
  });
}
