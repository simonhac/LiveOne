import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSystemAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { getAreaForSystem } from "@/lib/areas/resolve";

/**
 * GET /api/areas?systemId=N — the P3 Area for a system, read-only.
 *
 * Returns the Area whose view is `systemId`: its identity Area (`kind='identity'`, a 1:1 wrapper
 * over the physical system) or its composite Area (`kind='composite'`, points drawn across child
 * systems), plus the typed `area_bindings`. Identity Areas carry NO bindings — their points are the
 * system's own points (resolved from `point_info`), so `bindings` is empty for them; composite Areas
 * return their role→point edges.
 *
 * Access is system-granular (`requireSystemAccess`) — Areas are organisational, not the access
 * boundary, until P4. This is a NEW endpoint; the legacy `/api/data` payload stays frozen. Returns
 * `{ area: null, bindings: [] }` when `AREAS_TABLE` is off or no Area has been backfilled yet, so the
 * surface degrades gracefully before/independent of the P3 backfill.
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
      kind: areas.kind,
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
