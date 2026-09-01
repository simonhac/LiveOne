/**
 * Route helper for the per-derivation sub-resources — the sibling of `lib/areas/http.ts`.
 *
 * Every `/api/v4/areas/{ar_}/derivations/{dx_}/…` route has the same three-step preamble: authorize
 * the AREA (owner-or-admin), decode the `dx_` TypeID, then load the row **with the area in the
 * WHERE clause**. That last step is the one worth factoring: it is what makes the area's ownership
 * check cover the derivation, and the existing PATCH route says so in a comment precisely because
 * omitting it would let anyone who owns any area address any derivation by id. A helper cannot be
 * forgotten the way a WHERE clause can.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { loadAreaForOwner } from "@/lib/areas/http";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivations,
  type Derivation as DerivationRow,
} from "@/lib/db/planetscale/schema";
import { Derivation } from "@/lib/ids";
import type { AreaAuthRow } from "@/lib/areas/http";

export interface LoadedDerivation {
  userId: string;
  isAdmin: boolean;
  area: AreaAuthRow;
  derivation: DerivationRow;
}

/**
 * Authorize the area, then load one of its derivations. 400 bad id · 403 not yours · 404 unknown
 * area, or a derivation that is not on this area.
 *
 * "Not on this area" is deliberately a 404 rather than a 403: the caller has already proved they may
 * write to the area, so the only thing left to say is that the derivation is not there. Reporting
 * 403 would leak that the id exists somewhere else.
 */
export async function loadDerivationForOwner(
  request: NextRequest,
  arId: string,
  dxid: string,
): Promise<LoadedDerivation | { error: NextResponse }> {
  const authed = await loadAreaForOwner(request, arId);
  if ("error" in authed) return authed;

  const uuid = Derivation.toUuidOrNull(dxid);
  if (!uuid)
    return {
      error: NextResponse.json(
        { error: `Invalid derivation id: ${dxid}` },
        { status: 400 },
      ),
    };

  const [row] = await requirePlanetscaleDb()
    .select()
    .from(derivations)
    .where(
      and(eq(derivations.id, uuid), eq(derivations.areaId, authed.area.id)),
    )
    .limit(1);
  if (!row)
    return {
      error: NextResponse.json(
        { error: "Derivation not found on this area" },
        { status: 404 },
      ),
    };

  return { ...authed, derivation: row };
}
