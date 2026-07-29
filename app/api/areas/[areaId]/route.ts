import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { mergeAreaLocation } from "@/lib/areas/location";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { DeviceRegistry } from "@/lib/registry";
import { loadAreaForOwner, locationPatchFromBody } from "@/lib/areas/http";
import {
  updateAreaMeta,
  getAreaBindingsForEditor,
  refreshAreaServing,
  AreaAliasTakenError,
} from "@/lib/areas/create";
import { Area } from "@/lib/ids";

/**
 * Owner/admin edit of a single Area (the area builder's General/Location tab), addressed by its
 * opaque `ar_` TypeID (decoded to the raw uuid at the seam, `loadAreaForOwner`).
 *   PATCH  → rename / re-alias / retime / relocate / set status.
 *   DELETE → soft-delete (`status = 'archived'`); refuses legacy real-system-handle Areas.
 * Access is area-ownership (owner or admin) — the caller must own the area to edit it.
 */

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
  const authed = await loadAreaForOwner(request, areaId);
  if ("error" in authed) return authed.error;
  const uuid = authed.area.id;

  const [row] = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.name,
      alias: areas.slug,
      timezoneOffsetMin: areas.timezoneOffsetMin,
      displayTimezone: areas.displayTimezone,
      location: areas.location,
      status: areas.status,
      legacySystemId: areas.legacySystemId,
    })
    .from(areas)
    .where(eq(areas.id, uuid))
    .limit(1);
  if (!row)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  // The editor's wire shape is still integer systemIds (its POST/DELETE bodies are too), so the uuid
  // membership converts back. The `!` is safe by the `area_members.device_id` FK.
  const memberDeviceIds = await getAreaMemberDeviceIds(uuid);
  const memberRids = await DeviceRegistry.ridsForDevices(memberDeviceIds);
  const memberSystemIds = memberDeviceIds.map((id) => memberRids.get(id)!);
  const bindings = await getAreaBindingsForEditor(uuid);
  return NextResponse.json({
    area: { ...row, id: Area.encode(row.id) },
    memberSystemIds,
    bindings,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await loadAreaForOwner(request, areaId);
  if ("error" in authed) return authed.error;
  const { area } = authed;
  const uuid = area.id;

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
    await updateAreaMeta(uuid, patch);
  } catch (err) {
    if (err instanceof AreaAliasTakenError)
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    throw err;
  }
  // Metadata edits don't change the point set, but location feeds grid-region derivation — cheap to refresh.
  await refreshAreaServing(uuid);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await loadAreaForOwner(request, areaId);
  if ("error" in authed) return authed.error;
  const { area } = authed;
  const uuid = area.id;

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

  await updateAreaMeta(uuid, { status: "archived" });
  await refreshAreaServing(uuid);
  return NextResponse.json({ ok: true });
}
