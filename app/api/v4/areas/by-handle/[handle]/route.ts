import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthContext } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, legacyHandles } from "@/lib/db/planetscale/schema";
import { Area } from "@/lib/ids";

export const maxDuration = 15;

/**
 * `GET /api/v4/areas/by-handle/{handle}` — resolve an Area's integer addressing handle
 * (`legacy_handles.handle`, e.g. 8 for Kinkora, 1000002 for Daylesford) to its `ar_` TypeID. The
 * inverse lookup every ops session needs first: every other `/api/v4/areas/*` route is keyed on the
 * TypeID, but a human (or a runbook) starts from the handle. The v4 twin of
 * `GET /api/areas/by-handle/{legacySystemId}`.
 *
 * 🛑 **The one deliberate non-TypeID path segment on the `/api/v4` tree**, and it has to be: a handle
 * is not a TypeID, and a route whose whole purpose is "I only have the handle" cannot demand one. It
 * lives under `/areas` rather than as its own resource because that is what it resolves, and it dies
 * with the handle itself.
 *
 * Authorized for the area's **owner**, an **admin**, or a **`CRON_SECRET` bearer** (headless ops) —
 * matching the legacy twin and the sibling provenance endpoints. 🛑 That third mode is why
 * `/api/v4/areas/by-handle/(.*)` is in `publicRoutes` (`lib/route-matchers.ts`): the middleware's
 * `auth.protect()` runs at the EDGE and would 404 a headless `CRON_SECRET` call before this handler
 * ever authenticated it. The entry is suffix-surgical — the sibling `/api/v4/areas/*` routes stay
 * Clerk-gated.
 *
 * Payload: the legacy twin's keys verbatim (`areaId` already crossed as `ar_` there), so re-pointing
 * an ops runbook is a URL change.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> },
) {
  const auth = await getAuthContext(request);
  if (!auth.userId && !auth.isCron)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { handle: handleStr } = await params;
  if (!/^\d+$/.test(handleStr))
    return NextResponse.json(
      { error: "Invalid handle", details: "handle must be an integer" },
      { status: 400 },
    );
  const handle = parseInt(handleStr, 10);

  const [area] = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      ownerClerkUserId: areas.ownerUserId,
      legacySystemId: legacyHandles.handle,
      displayName: areas.name,
      alias: areas.slug,
    })
    .from(areas)
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(eq(legacyHandles.handle, handle))
    .limit(1);
  if (!area)
    return NextResponse.json(
      { error: `No area with handle ${handle}` },
      { status: 404 },
    );

  const isOwner = !!auth.userId && area.ownerClerkUserId === auth.userId;
  if (!auth.isCron && !auth.isAdmin && !isOwner)
    return NextResponse.json(
      { error: "Forbidden — area owner, admin, or cron only" },
      { status: 403 },
    );

  return NextResponse.json({
    areaId: Area.encode(area.id),
    systemId: area.legacySystemId,
    displayName: area.displayName,
    alias: area.alias,
  });
}
