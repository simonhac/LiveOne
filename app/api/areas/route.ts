import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAuth, requireSystemAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { SystemsManager } from "@/lib/systems-manager";
import { mergeAreaLocation } from "@/lib/areas/location";
import {
  createArea,
  assertMembersReadable,
  refreshAreaServing,
  AreaAliasTakenError,
  AreaAccessError,
  AreaValidationError,
} from "@/lib/areas/create";
import { locationPatchFromBody } from "@/lib/areas/http";

/**
 * GET /api/areas?systemId=N — the P3 Area for a system, read-only.
 *
 * Returns the Area whose view is `systemId` — a single-device Area (a 1:1 wrapper over the physical
 * system) or a multi-device Area (points drawn across its `area_devices` members), plus the typed
 * `area_bindings`. A single-device Area carries NO bindings — its points are the system's own points
 * (resolved from `point_info`), so `bindings` is empty for it; multi-device Areas return their
 * role→point edges.
 *
 * Access is system-granular (`requireSystemAccess`) — Areas are organisational, not the access
 * boundary, until P4. This is a NEW endpoint; the legacy `/api/data` payload stays frozen. Returns
 * `{ area: null, bindings: [] }` when no Area has been backfilled for the system yet, so the
 * surface degrades gracefully.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const systemIdStr = searchParams.get("systemId");
  const systemId = systemIdStr ? parseInt(systemIdStr, 10) : NaN;
  if (isNaN(systemId)) {
    return NextResponse.json(
      { error: "Invalid systemId", details: "systemId must be numeric" },
      { status: 400 },
    );
  }

  // Authenticate and authorize (owner, viewer, or admin) on the underlying system.
  const auth = await requireSystemAccess(request, systemId);
  if (auth instanceof NextResponse) return auth;

  const resolved = await getAreaForSystem(systemId);
  if (!resolved) {
    return NextResponse.json({ area: null, bindings: [] });
  }

  const db = requirePlanetscaleDb();
  const [area] = await db
    .select({
      id: areas.id,
      sourceSystemId: areas.sourceSystemId,
      legacySystemId: areas.legacySystemId,
      displayName: areas.displayName,
      alias: areas.alias,
      status: areas.status,
    })
    .from(areas)
    .where(eq(areas.id, resolved.id))
    .limit(1);

  const bindings = await db
    .select({
      role: areaBindings.role,
      metricType: areaBindings.metricType,
      pointSystemId: areaBindings.pointSystemId,
      pointId: areaBindings.pointId,
      ordinal: areaBindings.ordinal,
      transform: areaBindings.transform,
    })
    .from(areaBindings)
    .where(eq(areaBindings.areaId, resolved.id))
    .orderBy(areaBindings.ordinal);

  return NextResponse.json({ area, bindings });
}

/**
 * POST /api/areas — create a multi-device "site" area (the self-serve area builder).
 *
 * Body: `{ displayName, alias?, timezoneOffsetMin?, displayTimezone?, location?, memberSystemIds:number[] }`.
 * The site is owner-scoped (owner forced to the caller) and always gets a SYNTHETIC handle, so it can
 * grow from one member to many without re-keying. Each member must be readable by the caller (no
 * escalation). Timezone defaults from the first member. Returns `{ id, legacySystemId }`.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) {
    return NextResponse.json(
      { error: "displayName is required" },
      { status: 400 },
    );
  }
  const alias =
    typeof body?.alias === "string" && body.alias.trim()
      ? body.alias.trim()
      : null;

  const rawMembers: unknown[] = Array.isArray(body?.memberSystemIds)
    ? body.memberSystemIds
    : [];
  const memberSystemIds: number[] = [
    ...new Set(rawMembers.filter((n): n is number => Number.isInteger(n))),
  ];
  if (memberSystemIds.length === 0) {
    return NextResponse.json(
      { error: "At least one member device is required" },
      { status: 400 },
    );
  }

  try {
    await assertMembersReadable(auth.userId, auth.isAdmin, memberSystemIds);
  } catch (err) {
    if (err instanceof AreaAccessError)
      return NextResponse.json({ error: err.message }, { status: 403 });
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // Timezone defaults from the first member device.
  const first = await SystemsManager.getInstance().getSystem(
    memberSystemIds[0],
  );
  const timezoneOffsetMin =
    typeof body?.timezoneOffsetMin === "number"
      ? body.timezoneOffsetMin
      : (first?.timezoneOffsetMin ?? 600);
  const displayTimezone =
    typeof body?.displayTimezone === "string" && body.displayTimezone
      ? body.displayTimezone
      : (first?.displayTimezone ?? "Australia/Sydney");

  const location = body?.location
    ? mergeAreaLocation(null, locationPatchFromBody(body.location))
    : null;

  try {
    const created = await createArea({
      ownerClerkUserId: auth.userId,
      displayName,
      alias,
      timezoneOffsetMin,
      displayTimezone,
      location,
      memberSystemIds,
    });
    await refreshAreaServing(created.id);
    return NextResponse.json(created);
  } catch (err) {
    if (err instanceof AreaAliasTakenError)
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    throw err;
  }
}
