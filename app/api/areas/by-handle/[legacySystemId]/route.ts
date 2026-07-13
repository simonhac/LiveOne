import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthContext } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";

export const maxDuration = 15;

/**
 * GET /api/areas/by-handle/[legacySystemId] — resolve an Area's integer addressing handle
 * (`legacy_system_id`, e.g. 8 for Kinkora, 1000002 for Daylesford) to its UUID. The inverse lookup
 * every ops session needs first: the recompute / provenance-summary endpoints are keyed on the UUID,
 * but a human (or a runbook) starts from the handle. (`GET /api/areas?systemId=` takes a numeric handle
 * but returns the full area+bindings payload; this is the tiny handle→id map.)
 *
 * Authorized for the area's **owner**, an **admin**, or a **`CRON_SECRET` bearer** (headless ops) —
 * matching the sibling recompute / provenance-summary endpoints.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ legacySystemId: string }> },
) {
  const auth = await getAuthContext(request);
  if (!auth.userId && !auth.isCron)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!planetscaleDb)
    return NextResponse.json({ error: "DB not configured" }, { status: 503 });

  const { legacySystemId } = await params;
  if (!/^\d+$/.test(legacySystemId))
    return NextResponse.json(
      { error: "Invalid handle", details: "legacySystemId must be an integer" },
      { status: 400 },
    );
  const handle = parseInt(legacySystemId, 10);

  const [area] = await planetscaleDb
    .select({
      id: areas.id,
      ownerClerkUserId: areas.ownerClerkUserId,
      legacySystemId: areas.legacySystemId,
      displayName: areas.displayName,
      alias: areas.alias,
    })
    .from(areas)
    .where(eq(areas.legacySystemId, handle))
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
    areaId: area.id,
    systemId: area.legacySystemId,
    displayName: area.displayName,
    alias: area.alias,
  });
}
