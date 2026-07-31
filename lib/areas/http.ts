/**
 * Small shared HTTP-layer helpers for the `/api/v4/areas` mutation routes: coercing an untyped JSON body
 * into a typed location patch (same shape as the location route's `toPatch`), and loading the
 * ownership/handle facts a route needs to authorize an area edit.
 *
 * Plus the config-v4 read-side loaders (`findReadableArea` / `loadReadableArea`): parse an `ar_` TypeID
 * and resolve it within the caller's READABLE set (owner ∪ visible-device areas). The `/api/v4/areas/*`
 * routes are TypeID-native, so the `ar_`→uuid decode lives here in one place.
 *
 * `loadAreaForOwner` is the equivalent decode+auth seam for the legacy **area-builder** routes
 * (`/api/v4/areas/{id}*`), which check OWNERSHIP (not merely readability): parse an `ar_` id, then
 * 404/403 the same way those routes always have. Consolidates what used to be three near-identical
 * `requireAreaOwner` copies (one per route file).
 */
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, legacyHandles } from "@/lib/db/planetscale/schema";
import { Area, Device, type DeviceId } from "@/lib/ids";
import { DeviceRegistry } from "@/lib/registry";
import {
  assertMembersReadable,
  AreaAccessError,
  AreaValidationError,
} from "@/lib/areas/create";
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
      legacySystemId: legacyHandles.handle,
      status: areas.status,
      displayName: areas.name,
      location: areas.location,
    })
    .from(areas)
    // config-v4 Phase 13 PR 5: handle from `legacy_handles`, not the dropped column. LEFT, so
    // `AreaAuthRow.legacySystemId` keeps its `number | null` type AND — the load-bearing half — an area
    // with no handle row still RESOLVES here rather than returning null and 404-ing a route that only
    // needed the owner to authorize a patch.
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
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

/** `resolveMemberDeviceRefs` outcome — the readable member set, or a status the caller maps to a 4xx. */
export type MemberRefsResult =
  | { ok: true; deviceIds: DeviceId[]; systemIds: number[] }
  | { ok: false; status: 403 | 422; message: string };

/**
 * Decode a v4 `members: [dv_…]` list into the integer handles the area DAOs still take, refusing any
 * ref the caller cannot READ — the §8.4 no-escalation firewall on the members wire.
 *
 * Two failures are deliberately COLLAPSED into one 403: a well-formed `dv_` id that names no device,
 * and one that names a device the caller cannot see. Distinguishing them would turn this endpoint into
 * an existence oracle over other owners' devices, which is precisely what §8.4 forbids. A malformed id
 * (wrong prefix / bad base32) is a different thing — it cannot name anything, so it is a body error and
 * reads as 422 with the offending value echoed.
 *
 * Order is PRESERVED (it becomes `area_members.ordinal`), and duplicates are rejected rather than
 * silently deduped: on a declarative full-replace, `[a, b, a]` states two different ordinals for `a` and
 * there is no defensible way to pick one. (config-v4 Phase 14 stage 10.)
 */
export async function resolveMemberDeviceRefs(
  userId: string,
  isAdmin: boolean,
  refs: unknown,
): Promise<MemberRefsResult> {
  if (!Array.isArray(refs) || refs.length === 0) {
    return {
      ok: false,
      status: 422,
      message: "members must be a non-empty array of dv_ ids",
    };
  }
  const deviceIds: DeviceId[] = [];
  for (const ref of refs) {
    const parsed = typeof ref === "string" ? Device.parse(ref) : null;
    if (!parsed?.ok) {
      return {
        ok: false,
        status: 422,
        message: `Invalid member device id: ${typeof ref === "string" ? ref : typeof ref}`,
      };
    }
    if (deviceIds.includes(parsed.id)) {
      return {
        ok: false,
        status: 422,
        message: `Duplicate member: ${parsed.id}`,
      };
    }
    deviceIds.push(parsed.id);
  }

  // `ridsForDevices` answers only for devices that HAVE a row; a miss is an unknown id, which collapses
  // into "not readable" above. The readability decision itself is `assertMembersReadable`'s — the same
  // firewall the legacy routes call, so v4 cannot become the laxer door onto the same tables.
  const rids = await DeviceRegistry.ridsForDevices(deviceIds);
  const systemIds: number[] = [];
  for (const id of deviceIds) {
    const rid = rids.get(id);
    if (rid == null) {
      return {
        ok: false,
        status: 403,
        message: `Device not found or not readable: ${id}`,
      };
    }
    systemIds.push(rid);
  }
  try {
    await assertMembersReadable(userId, isAdmin, systemIds);
  } catch (err) {
    if (err instanceof AreaAccessError)
      return { ok: false, status: 403, message: err.message };
    if (err instanceof AreaValidationError)
      return { ok: false, status: 422, message: err.message };
    throw err;
  }
  return { ok: true, deviceIds, systemIds };
}

/**
 * Authenticate + parse an `ar_` TypeID + authorize OWNER/ADMIN write access — the loader every
 * `/api/v4/areas/{id}*` mutation route uses. Malformed id → 400; unknown → 404; well-formed but not
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
