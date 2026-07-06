/**
 * Small shared HTTP-layer helpers for the `/api/areas` mutation routes: coercing an untyped JSON body
 * into a typed location patch (same shape as the location route's `toPatch`), and loading the
 * ownership/handle facts a route needs to authorize an area edit.
 */
import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import type { AreaLocation } from "@/lib/areas/types";
import type { AreaLocationPatch } from "@/lib/areas/location";

/** Coerce an untyped JSON object into a typed `AreaLocationPatch` (undefined = preserve, null = clear). */
export function locationPatchFromBody(body: unknown): AreaLocationPatch {
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

export interface AreaAuthRow {
  id: string;
  ownerClerkUserId: string | null;
  legacySystemId: number | null;
  status: string;
  displayName: string;
  location: AreaLocation | null;
}

/** Load the facts a route needs to authorize/patch an area, or null if the uuid is unknown. */
export async function loadAreaForAuth(
  areaId: string,
): Promise<AreaAuthRow | null> {
  const [row] = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      ownerClerkUserId: areas.ownerClerkUserId,
      legacySystemId: areas.legacySystemId,
      status: areas.status,
      displayName: areas.displayName,
      location: areas.location,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  return row ?? null;
}
