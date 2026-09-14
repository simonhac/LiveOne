import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import {
  mergeAreaLocation,
  type AreaLocationPatch,
} from "@/lib/areas/location";
import { nemRegionForLocation } from "@/lib/vendors/openelectricity/region";
import type { AreaLocation } from "@/lib/areas/types";

/**
 * Owner-facing editor for a SITE's physical location. Location lives on the **Area** when the handle is
 * a real Area (a multi-device site, or a single-device Area like Kutis). A bare device has no site
 * location; group it into an Area first. The Area location DERIVES the NEM grid region for the Local
 * Grid card (lib/grid/context.ts). Never mints an Area — areas are explicit.
 *
 * Keyed on `systemId` (all addressing is still integer-systemId today).
 * GET: read access. PUT: owner/admin write — merge-patches the location and returns the derived region.
 */

/**
 * The current location of the site `systemId` is IN (null when it is in none). Read-only.
 *
 * 🛑 `devices.area_id`, not `getAreaForDevice` — see the PUT. The read and the write have to name the
 * same area or this editor shows one value and saves another.
 */
async function readLocation(systemId: number): Promise<AreaLocation | null> {
  const device = await DeviceConfigRegistry.deviceByHandle(systemId);
  if (!device?.areaId) return null;
  const [row] = await requirePlanetscaleDb()
    .select({ location: areas.location })
    .from(areas)
    .where(eq(areas.id, device.areaId))
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
  const auth = await requireDeviceAccess(request, systemId);
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
  const auth = await requireDeviceAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  // Location is an Area/site property. Never mint an Area here — areas are explicit.
  //
  // 🛑 The device's CURRENT area (`devices.area_id`), not `getAreaForDevice`, which resolves
  // `legacy_handles.handle → area_id` — the eagerly-minted area-of-one. Once placement READS moved to
  // `devices.area_id`, writing the shell here made this endpoint answer 200 with the new location
  // while both `device-config` and the actual site kept the old one. A device with no area is
  // AMBIENT and has nowhere to put a location, which is exactly what the message below says.
  const device = await DeviceConfigRegistry.deviceByHandle(systemId);
  if (!device?.areaId)
    return NextResponse.json(
      {
        error:
          "This device isn't part of a site — create a site and add the device to it to set a location.",
      },
      { status: 422 },
    );
  const area = { id: device.areaId };

  // 🛑 Write access to the DEVICE is not write access to its SITE. A site can hold devices belonging
  // to several owners, so without this the owner of any member could re-place a site they do not own
  // — and a location move re-derives the NEM region, which re-prices everything the site reports.
  const [owner] = await requirePlanetscaleDb()
    .select({ ownerUserId: areas.ownerUserId })
    .from(areas)
    .where(eq(areas.id, area.id))
    .limit(1);
  if (!(auth.isAdmin || owner?.ownerUserId === auth.userId))
    return NextResponse.json(
      { error: "This site belongs to someone else" },
      { status: 403 },
    );

  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({ location: areas.location })
    .from(areas)
    .where(eq(areas.id, area.id))
    .limit(1);
  const merged = mergeAreaLocation(
    row?.location ?? null,
    toPatch(await request.json().catch(() => ({}))),
  );
  await db
    .update(areas)
    .set({ location: merged, updatedAt: new Date() })
    .where(eq(areas.id, area.id));

  // Loaded fresh per request, so the edit is reflected on the next read with nothing to invalidate.
  return NextResponse.json({
    location: merged,
    region: nemRegionForLocation(merged),
  });
}
