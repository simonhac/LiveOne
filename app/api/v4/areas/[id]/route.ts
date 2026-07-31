import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import {
  loadAreaForOwner,
  loadReadableArea,
  locationPatchFromBody,
} from "@/lib/areas/http";
import { mergeAreaLocation } from "@/lib/areas/location";
import {
  updateAreaMeta,
  refreshAreaServing,
  AreaAliasTakenError,
} from "@/lib/areas/create";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { loadAreaBindings, loadAreaMembers } from "@/lib/areas/v4-load";
import { areaDetailResponse } from "@/lib/areas/v4-shapes";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/**
 * The TypeID-native area aggregate (§9.2): meta + members + bindings + capabilities in ONE payload,
 * plus the two meta mutations that edit it. Every entity IDENTITY crosses as a TypeID
 * (`ar_`/`dv_`/`bn_`/`pt_`).
 *   GET    → the aggregate. Readable (owner ∪ visible-device areas).
 *   PATCH  → rename / re-slug / retime / relocate / set status. OWNER or admin.
 *   DELETE → soft-delete (`status = 'archived'`); refuses a device's own area. OWNER or admin.
 *
 * The GET is READABLE and the writes are OWNED, and that asymmetry is why they use different loaders:
 * `loadReadableArea` (400 malformed / 403 unknown-or-not-yours — §8.4 collapses the two) vs
 * `loadAreaForOwner` (400 malformed / 404 unknown / 403 not-yours). The writes keep the legacy twins'
 * 404-vs-403 split verbatim rather than collapsing it: the area builder distinguishes "gone" (close the
 * dialog) from "not yours" (an authorization error), and this is a mutation surface — a caller who is
 * about to be told 403 anyway learns nothing from the 404.
 *
 * It also carries `area.legacySystemId`, the integer ADDRESS — not an identity — that `/api/data` and
 * the KV keyspace are still keyed by, exactly as the legacy twin `GET /api/areas/{areaId}` does. This
 * header used to claim handles "never cross this API boundary"; that aspiration silently made the v4
 * payload non-substitutable for the one its clients read. See `lib/areas/v4-shapes.ts`.
 */

/**
 * Read + serialize the whole aggregate for one area. Shared by `GET` and by `PATCH`'s echo.
 *
 * 🛑 It takes the handle as an ARGUMENT and does not re-derive it, and PATCH must NOT echo by calling
 * `GET` instead: `GET`'s loader resolves the area through `listReadableAreas`, which filters
 * `status = 'active'`, so `PATCH {status:"archived"}` would have echoed a **403 on the row it had just
 * successfully written**. (Same trap for an admin patching another owner's area.)
 */
async function areaAggregateResponse(
  areaUuid: string,
  legacySystemId: number | null,
): Promise<NextResponse> {
  const [row] = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      name: areas.name,
      slug: areas.slug,
      status: areas.status,
      dayOffsetMin: areas.dayOffsetMin,
      timezoneOffsetMin: areas.timezoneOffsetMin,
      displayTimezone: areas.displayTimezone,
      location: areas.location,
      config: areas.config,
    })
    .from(areas)
    .where(eq(areas.id, areaUuid))
    .limit(1);
  if (!row)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  // `loadAreaMembers`/`loadAreaBindings` (lib/areas/v4-load.ts) are shared with the two collection PUTs
  // — §9.2 makes a `PUT` return the new state, and a hand-written second projection there would drift
  // from this one on the first field either gains.
  const [members, areaCaps, bindingRows] = await Promise.all([
    loadAreaMembers(areaUuid),
    // An area with no `legacy_handles` row has no handle-addressed capability set; that is not an error
    // here (the loader LEFT-joins for exactly this reason), it is an empty capability list.
    legacySystemId == null
      ? Promise.resolve(new Set<string>())
      : capabilitiesForDevice(legacySystemId),
    loadAreaBindings(areaUuid),
  ]);

  return NextResponse.json(
    areaDetailResponse({
      area: {
        ...row,
        capabilities: [...areaCaps],
        // Carried, not dropped: the integer address `/api/data?systemId=` still uses, which the legacy
        // twin returns. See `areaDetailResponse`. It comes off the loader (`legacy_handles`), not `row`.
        legacySystemId,
      },
      members,
      bindings: bindingRows,
    }),
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;
  return areaAggregateResponse(r.area.id, r.area.legacySystemId);
}

/**
 * PATCH — partial meta edit (§9.2). The v4 twin of `PATCH /api/areas/{areaId}`.
 *
 * Body: `{ name?, slug?, dayOffsetMin?, displayTimezone?, status?, location? }` — the same set the
 * legacy twin takes under its pre-v4 spellings (`displayName`/`alias`/`timezoneOffsetMin`). `slug: null`
 * clears it; an omitted key is preserved, and `location` MERGES (undefined = keep, null = clear
 * per-field), exactly as `mergeAreaLocation` has always done.
 *
 * Returns the freshly-read aggregate rather than the legacy `{ ok: true }`: a PATCH here can change
 * derived state the caller did not name (a `location` edit re-derives the grid region), so echoing the
 * new state is both the §9.2 house style and the only answer that cannot be stale.
 *   403 not yours · 404 unknown · 409 slug taken · 422 bad body.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const { area } = authed;

  const body = await request.json().catch(() => null);
  if (body == null || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json(
      { error: "body must be a JSON object" },
      { status: 422 },
    );

  const patch: Parameters<typeof updateAreaMeta>[1] = {};
  if (body.name !== undefined) {
    const next = typeof body.name === "string" ? body.name.trim() : "";
    if (!next)
      return NextResponse.json(
        { error: "name cannot be empty" },
        { status: 422 },
      );
    patch.displayName = next;
  }
  if (body.slug !== undefined) {
    if (body.slug !== null && typeof body.slug !== "string")
      return NextResponse.json(
        { error: "slug must be a string or null" },
        { status: 422 },
      );
    patch.alias = body.slug ? String(body.slug).trim() : null;
  }
  if (body.dayOffsetMin !== undefined) {
    if (typeof body.dayOffsetMin !== "number")
      return NextResponse.json(
        { error: "dayOffsetMin must be a number" },
        { status: 422 },
      );
    // One number, both columns — `updateAreaMeta` writes `day_offset_min` AND the legacy
    // `timezone_offset_min` from this input, so the v4 name is not a second source of truth.
    patch.timezoneOffsetMin = body.dayOffsetMin;
  }
  if (body.displayTimezone !== undefined) {
    if (typeof body.displayTimezone !== "string" || !body.displayTimezone)
      return NextResponse.json(
        { error: "displayTimezone must be a non-empty string" },
        { status: 422 },
      );
    patch.displayTimezone = body.displayTimezone;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "archived")
      return NextResponse.json(
        { error: "status must be 'active' or 'archived'" },
        { status: 422 },
      );
    patch.status = body.status;
  }
  if (body.location !== undefined) {
    patch.location = mergeAreaLocation(
      area.location,
      locationPatchFromBody(body.location),
    );
  }

  try {
    await updateAreaMeta(area.id, patch);
  } catch (err) {
    // 🛑 409, never a bare 500 — see the note on `POST /api/v4/areas` and lib/db/pg-error.ts.
    if (err instanceof AreaAliasTakenError)
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    throw err;
  }
  // Metadata edits don't change the point set, but `location` feeds grid-region derivation — cheap to
  // refresh, and it keeps "every area mutation refreshes serving" true without exception.
  await refreshAreaServing(area.id);
  return areaAggregateResponse(area.id, area.legacySystemId);
}

/**
 * DELETE — soft-delete (`status = 'archived'`). The v4 twin of `DELETE /api/areas/{areaId}`.
 *
 * SOFT, deliberately: an area's uuid keys its flow/provenance history (`point_readings_flow_attr_1d`,
 * `battery_provenance_daily`), so a hard delete would destroy data the row does not own. Archiving
 * drops it out of `listReadableAreas` (which filters `status = 'active'`) and out of the KV subscription
 * registry, which is what "deleted" means to every consumer.
 *
 * A legacy Area addressed by a REAL device handle is refused with 409: it is that device's own area and
 * is load-bearing for the device page.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const { area } = authed;

  if (
    area.legacySystemId != null &&
    (await DeviceConfigRegistry.deviceByHandle(area.legacySystemId))
  ) {
    return NextResponse.json(
      { error: "This is a device's own area and cannot be deleted" },
      { status: 409 },
    );
  }

  await updateAreaMeta(area.id, { status: "archived" });
  // The archived area must leave the KV subscription registry, or its bindings keep being served.
  await refreshAreaServing(area.id);
  return NextResponse.json({ success: true });
}
