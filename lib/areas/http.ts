/**
 * Small shared HTTP-layer helpers for the `/api/areas` mutation routes: coercing an untyped JSON body
 * into a typed location patch (same shape as the location route's `toPatch`), and loading the
 * ownership/handle facts a route needs to authorize an area edit.
 *
 * Plus the config-v4 read-side loaders (`findReadableArea` / `loadReadableArea`): parse an `ar_` TypeID
 * and resolve it within the caller's READABLE set (owner ∪ visible-system areas). The `/api/v4/areas/*`
 * routes are TypeID-native, so the `ar_`→uuid decode lives here in one place.
 *
 * `loadAreaForOwner` is the equivalent decode+auth seam for the legacy **area-builder** routes
 * (`/api/areas/[areaId]*`), which check OWNERSHIP (not merely readability): parse an `ar_` id, then
 * 404/403 the same way those routes always have. Consolidates what used to be three near-identical
 * `requireAreaOwner` copies (one per route file).
 */
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { Area } from "@/lib/ids";
import { listReadableAreas, type ReadableArea } from "@/lib/areas/list";
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
      ownerClerkUserId: areas.ownerUserId,
      legacySystemId: areas.legacySystemId,
      status: areas.status,
      displayName: areas.name,
      location: areas.location,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  return row ?? null;
}

/** `findReadableArea` outcome: the resolved readable area, or a status+message the caller maps to a 4xx. */
export type ReadableAreaResult =
  | { ok: true; area: ReadableArea }
  | { ok: false; status: 400 | 403; message: string };

/**
 * Parse an `ar_` TypeID and resolve it within `userId`'s readable set. AUTH-FREE (the caller has already
 * authenticated) so it can back both the `/api/v4/areas/{id}` route loader and the `POST /dashboards
 * {seedArea}` branch without a second Clerk round-trip. A malformed id → 400; a well-formed id outside the
 * readable set → 403 (the §8.4 no-escalation collapse: "unknown" and "not yours" are indistinguishable).
 */
export async function findReadableArea(
  userId: string,
  arId: string,
): Promise<ReadableAreaResult> {
  const parsed = Area.parse(arId);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      message: `Invalid area id: ${parsed.message}`,
    };
  }
  const uuid = Area.toUuid(parsed.id);
  const area = (await listReadableAreas(userId)).find((a) => a.id === uuid);
  if (!area) {
    return {
      ok: false,
      status: 403,
      message: "Area not found or not readable",
    };
  }
  return { ok: true, area };
}

/**
 * Authenticate + resolve a readable area — the loader every `GET /api/v4/areas/{id}[/…]` route uses.
 * Mirrors `loadOwnedDashboard` (dashboard side): returns `{ area, userId }` or `{ error }` to short-circuit.
 */
export async function loadReadableArea(
  request: NextRequest,
  arId: string,
): Promise<{ area: ReadableArea; userId: string } | { error: NextResponse }> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };
  const r = await findReadableArea(auth.userId, arId);
  if (!r.ok) {
    return {
      error: NextResponse.json({ error: r.message }, { status: r.status }),
    };
  }
  return { area: r.area, userId: auth.userId };
}

/**
 * Authenticate + parse an `ar_` TypeID + authorize OWNER/ADMIN write access — the loader every
 * `/api/areas/[areaId]*` mutation route uses. Malformed id → 400; unknown → 404; well-formed but not
 * owned (and not admin) → 403. `area.id` (below the seam) is the raw uuid every DAO call in `create.ts`
 * expects.
 */
export async function loadAreaForOwner(
  request: NextRequest,
  arId: string,
): Promise<
  | { userId: string; isAdmin: boolean; area: AreaAuthRow }
  | { error: NextResponse }
> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };
  const uuid = Area.toUuidOrNull(arId);
  if (!uuid) {
    return {
      error: NextResponse.json(
        { error: `Invalid area id: ${arId}` },
        { status: 400 },
      ),
    };
  }
  const area = await loadAreaForAuth(uuid);
  if (!area) {
    return {
      error: NextResponse.json({ error: "Area not found" }, { status: 404 }),
    };
  }
  if (!(auth.isAdmin || area.ownerClerkUserId === auth.userId)) {
    return {
      error: NextResponse.json(
        { error: "Write access required" },
        { status: 403 },
      ),
    };
  }
  return { userId: auth.userId, isAdmin: auth.isAdmin, area };
}
