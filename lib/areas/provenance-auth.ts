/**
 * The decode + authorize seam the two config-v4 `/api/v4/areas/{ar_…}/provenance-*` reads share.
 *
 * Its own file (rather than another export on `lib/areas/http.ts`) because the gate it implements is
 * NOT the readable-set gate every other `/api/v4/areas/*` route uses: these endpoints are also reachable
 * headlessly by a `CRON_SECRET` bearer, which has no `userId` and therefore no readable set at all. So
 * `loadReadableArea`/`findReadableArea` cannot back them, and their "unknown id" answer stays the legacy
 * 404 rather than §8.4's collapse-into-403 (which only makes sense when the caller HAS a readable set).
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, legacyHandles } from "@/lib/db/planetscale/schema";
import { Area } from "@/lib/ids";
import type { AuthContext } from "@/lib/api-auth";

export interface ProvenanceArea {
  /** The raw uuid — below the seam, what every DAO/query takes. */
  uuid: string;
  ownerClerkUserId: string | null;
  /** The integer addressing handle from `legacy_handles`, or null for an unhandled area. */
  legacySystemId: number | null;
  /** Minutes east of UTC — the timezone every day window is resolved in. */
  timezoneOffsetMin: number;
}

/**
 * Parse an `ar_` TypeID (STRICT — a raw uuid is not an id on this surface) and load the three facts a
 * provenance read needs. `{ error }` short-circuits the route: 400 malformed, 404 unknown.
 */
export async function loadProvenanceArea(
  arId: string,
): Promise<{ area: ProvenanceArea } | { error: NextResponse }> {
  const uuid = Area.toUuidOrNull(arId);
  if (!uuid)
    return {
      error: NextResponse.json(
        { error: `Invalid area id: ${arId}` },
        { status: 400 },
      ),
    };
  const [row] = await requirePlanetscaleDb()
    .select({
      ownerClerkUserId: areas.ownerUserId,
      legacySystemId: legacyHandles.handle,
      timezoneOffsetMin: areas.timezoneOffsetMin,
    })
    .from(areas)
    // LEFT: an area with no handle row must still RESOLVE (it then takes the owner/admin/cron gate),
    // not 404 as if it did not exist.
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(eq(areas.id, uuid))
    .limit(1);
  if (!row)
    return {
      error: NextResponse.json({ error: "Area not found" }, { status: 404 }),
    };
  return { area: { uuid, ...row } };
}

/**
 * The owner/admin/`CRON_SECRET` gate the provenance ops endpoints share. Returns a response to send, or
 * null when the caller is authorized.
 */
export function forbidUnlessOwnerAdminOrCron(
  auth: AuthContext,
  area: Pick<ProvenanceArea, "ownerClerkUserId">,
): NextResponse | null {
  if (!auth.userId && !auth.isCron)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const isOwner = !!auth.userId && area.ownerClerkUserId === auth.userId;
  if (!auth.isCron && !auth.isAdmin && !isOwner)
    return NextResponse.json(
      { error: "Forbidden — area owner, admin, or cron only" },
      { status: 403 },
    );
  return null;
}
