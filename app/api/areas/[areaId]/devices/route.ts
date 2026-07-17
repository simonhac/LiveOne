import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { loadAreaForAuth } from "@/lib/areas/http";
import {
  addMember,
  removeMember,
  assertMembersReadable,
  refreshAreaServing,
  AreaAccessError,
  AreaValidationError,
} from "@/lib/areas/create";

/**
 * Member-device membership of an Area (the area builder's Members tab).
 *   POST   { systemId } → add a member (must be readable by the caller).
 *   DELETE { systemId } → remove a member (+ its orphaned bindings; refused on the last member).
 */

async function requireAreaOwner(request: NextRequest, areaId: string) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const area = await loadAreaForAuth(areaId);
  if (!area)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });
  if (!(auth.isAdmin || area.ownerClerkUserId === auth.userId))
    return NextResponse.json(
      { error: "Write access required" },
      { status: 403 },
    );
  return { userId: auth.userId, isAdmin: auth.isAdmin, area };
}

function parseSystemId(body: unknown): number | null {
  const v = (body as { systemId?: unknown })?.systemId;
  return Number.isInteger(v) ? (v as number) : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await requireAreaOwner(request, areaId);
  if (authed instanceof NextResponse) return authed;
  const { userId, isAdmin, area } = authed;

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
    (await SystemsManager.getInstance().getSystem(area.legacySystemId))
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

  await addMember(areaId, systemId);
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

  const systemId = parseSystemId(await request.json().catch(() => null));
  if (systemId == null)
    return NextResponse.json(
      { error: "systemId is required" },
      { status: 400 },
    );

  try {
    await removeMember(areaId, systemId);
  } catch (err) {
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  await refreshAreaServing(areaId);
  return NextResponse.json({ ok: true });
}
