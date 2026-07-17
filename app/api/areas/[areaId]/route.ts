import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { mergeAreaLocation } from "@/lib/areas/location";
import { getAreaDeviceSystemIds } from "@/lib/areas/devices";
import { loadAreaForAuth, locationPatchFromBody } from "@/lib/areas/http";
import {
  updateAreaMeta,
  getAreaBindingsForEditor,
  refreshAreaServing,
  AreaAliasTakenError,
} from "@/lib/areas/create";

/**
 * Owner/admin edit of a single Area (the area builder's General/Location tab), addressed by uuid.
 *   PATCH  → rename / re-alias / retime / relocate / set status.
 *   DELETE → soft-delete (`status = 'archived'`); refuses legacy real-system-handle Areas.
 * Access is area-ownership (owner or admin) — the caller must own the area to edit it.
 */

/** Resolve the area + authorize owner/admin. Returns the row, or a NextResponse to short-circuit. */
async function requireAreaOwner(
  request: NextRequest,
  areaId: string,
): Promise<
  | {
      userId: string;
      isAdmin: boolean;
      area: NonNullable<Awaited<ReturnType<typeof loadAreaForAuth>>>;
    }
  | NextResponse
> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const area = await loadAreaForAuth(areaId);
  if (!area)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });
  const canWrite = auth.isAdmin || area.ownerClerkUserId === auth.userId;
  if (!canWrite)
    return NextResponse.json(
      { error: "Write access required" },
      { status: 403 },
    );
  return { userId: auth.userId, isAdmin: auth.isAdmin, area };
}

/**
 * GET → the area builder's edit payload for one area: its metadata, member systemIds, and current
 * role→point bindings. Owner/admin only. Member display names are joined client-side against
 * /api/areas/candidate-systems.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await requireAreaOwner(request, areaId);
  if (authed instanceof NextResponse) return authed;

  const [row] = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.displayName,
      alias: areas.alias,
      timezoneOffsetMin: areas.timezoneOffsetMin,
      displayTimezone: areas.displayTimezone,
      location: areas.location,
      status: areas.status,
      legacySystemId: areas.legacySystemId,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  if (!row)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  const memberSystemIds = await getAreaDeviceSystemIds(areaId);
  const bindings = await getAreaBindingsForEditor(areaId);
  return NextResponse.json({ area: row, memberSystemIds, bindings });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await requireAreaOwner(request, areaId);
  if (authed instanceof NextResponse) return authed;
  const { area } = authed;

  const body = await request.json().catch(() => null);
  const patch: Parameters<typeof updateAreaMeta>[1] = {};
  if (typeof body?.displayName === "string" && body.displayName.trim())
    patch.displayName = body.displayName.trim();
  if (typeof body?.alias === "string" || body?.alias === null)
    patch.alias = body.alias ? String(body.alias).trim() : null;
  if (typeof body?.timezoneOffsetMin === "number")
    patch.timezoneOffsetMin = body.timezoneOffsetMin;
  if (typeof body?.displayTimezone === "string" && body.displayTimezone)
    patch.displayTimezone = body.displayTimezone;
  if (typeof body?.status === "string") patch.status = body.status;
  if (body?.location !== undefined) {
    patch.location = mergeAreaLocation(
      area.location,
      locationPatchFromBody(body.location),
    );
  }

  try {
    await updateAreaMeta(areaId, patch);
  } catch (err) {
    if (err instanceof AreaAliasTakenError)
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    throw err;
  }
  // Metadata edits don't change the point set, but location feeds grid-region derivation — cheap to refresh.
  await refreshAreaServing(areaId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await requireAreaOwner(request, areaId);
  if (authed instanceof NextResponse) return authed;
  const { area } = authed;

  // A legacy Area addressed by a real systems.id may still be load-bearing — never delete it here.
  if (
    area.legacySystemId != null &&
    (await SystemsManager.getInstance().getSystem(area.legacySystemId))
  ) {
    return NextResponse.json(
      { error: "This is a device's own area and cannot be deleted" },
      { status: 409 },
    );
  }

  await updateAreaMeta(areaId, { status: "archived" });
  await refreshAreaServing(areaId);
  return NextResponse.json({ ok: true });
}
