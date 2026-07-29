import { NextRequest, NextResponse } from "next/server";
import { SystemsManager } from "@/lib/systems-manager";
import { loadAreaForOwner } from "@/lib/areas/http";
import {
  addMember,
  removeMember,
  assertMembersReadable,
  refreshAreaServing,
  AreaAccessError,
  AreaValidationError,
} from "@/lib/areas/create";
import { DeviceConfigRegistry } from "\@/lib/registry/device-config";

/**
 * Member-device membership of an Area (the area builder's Members tab), addressed by its opaque `ar_`
 * TypeID (decoded to the raw uuid at the seam, `loadAreaForOwner`).
 *   POST   { systemId } → add a member (must be readable by the caller).
 *   DELETE { systemId } → remove a member (+ its orphaned bindings; refused on the last member).
 */

function parseSystemId(body: unknown): number | null {
  const v = (body as { systemId?: unknown })?.systemId;
  return Number.isInteger(v) ? (v as number) : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await loadAreaForOwner(request, areaId);
  if ("error" in authed) return authed.error;
  const { userId, isAdmin, area } = authed;
  const uuid = area.id;

  const systemId = parseSystemId(await request.json().catch(() => null));
  if (systemId == null)
    return NextResponse.json(
      { error: "systemId is required" },
      { status: 400 },
    );

  // A legacy Area addressed by a real systems.id can't gain members without re-keying — create a new
  // synthetic-handle Area instead.
  if (
    area.legacySystemId != null &&
    (await DeviceConfigRegistry.deviceByHandle(area.legacySystemId))
  ) {
    return NextResponse.json(
      {
        error:
          "This is a single-device area. Create a site to combine it with other devices.",
        code: "AREA_OF_ONE_CANNOT_ADD",
      },
      { status: 409 },
    );
  }

  try {
    await assertMembersReadable(userId, isAdmin, [systemId]);
  } catch (err) {
    if (err instanceof AreaAccessError)
      return NextResponse.json({ error: err.message }, { status: 403 });
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  await addMember(uuid, systemId);
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
  const uuid = authed.area.id;

  const systemId = parseSystemId(await request.json().catch(() => null));
  if (systemId == null)
    return NextResponse.json(
      { error: "systemId is required" },
      { status: 400 },
    );

  try {
    await removeMember(uuid, systemId);
  } catch (err) {
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  await refreshAreaServing(uuid);
  return NextResponse.json({ ok: true });
}
