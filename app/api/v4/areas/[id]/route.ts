import { NextRequest, NextResponse } from "next/server";
import { refuseIfReliedUpon } from "@/lib/integrity/http";
import { AreaNotArchivedError, hardDeleteArea } from "@/lib/areas/delete";
import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import {
  loadAreaForOwner,
  loadReadableArea,
  locationPatchFromBody,
} from "@/lib/areas/http";
import {
  mergeAreaLocation,
  areaLocationPatchError,
} from "@/lib/areas/location";
import {
  updateAreaMeta,
  refreshAreaServing,
  AreaAliasTakenError,
} from "@/lib/areas/create";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { loadAreaBindings, loadAreaMembers } from "@/lib/areas/v4-load";
import { areaDetailResponse } from "@/lib/areas/v4-shapes";
import { isValidTimezone } from "@/lib/timezones";

/**
 * The TypeID-native area aggregate (§9.2): meta + members + bindings + capabilities in ONE payload,
 * plus the two meta mutations that edit it. Every entity IDENTITY crosses as a TypeID
 * (`ar_`/`dv_`/`bn_`/`pt_`).
 *   GET    → the aggregate. Readable (owner ∪ visible-device areas).
 *   PATCH  → rename / re-slug / retime / relocate / set status. OWNER or admin.
 *   DELETE → HARD delete (the row). Refuses unless already archived and nothing depends on it.
 *            Archiving is `PATCH { status: 'archived' }` — a separate verb, deliberately.
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
      ownerUserId: areas.ownerUserId,
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
  const r = await loadReadableArea(request, id, {
    // So an archived area can still be INSPECTED. Reading one changes nothing, and an area you
    // cannot read is one you cannot decide about — which is the state that made archiving a
    // one-way door before `area delete` existed.
    includeArchived:
      request.nextUrl.searchParams.get("includeArchived") === "true",
  });
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
 *   403 not yours · 404 unknown · 409 slug taken · 409 relied upon · 422 bad body.
 *
 * 🛑 **`status: "archived"` is a DELETE by another name, and is gated identically.** `DELETE` on
 * this resource IS this PATCH plus a serving refresh — same `updateAreaMeta`, same column, same
 * user-visible outcome (the area leaves `listReadableAreas` and the KV registry). Gating one
 * entrance and not the other would leave a refusal that reads as protection and is a formality;
 * anything that could not be deleted could still be archived, silently. So the referential check
 * lives on the TRANSITION, not on the verb.
 *
 * Only `active → archived` is gated. Un-archiving breaks nothing, and re-archiving an already
 * archived area changes nothing — a gate on either would refuse a no-op, which teaches operators
 * that the refusal is noise.
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
    // 🛑 A REAL zone, not just a non-empty string. This column is what
    // `/api/v4/areas/[id]/calendar.ics` places every DTSTART in, so a typo like
    // "Australia/Melbournee" silently empties that area's calendar feed — every event is skipped
    // with a log nobody is reading. Catch it at the one moment someone is looking at an error.
    if (!isValidTimezone(body.displayTimezone))
      return NextResponse.json(
        {
          error: `displayTimezone '${body.displayTimezone}' is not a known IANA timezone`,
        },
        { status: 422 },
      );
    patch.displayTimezone = body.displayTimezone;
  }
  let archiving = false;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "archived")
      return NextResponse.json(
        { error: "status must be 'active' or 'archived'" },
        { status: 422 },
      );
    patch.status = body.status;
    archiving = body.status === "archived" && area.status !== "archived";
  }
  if (body.location !== undefined) {
    const error = areaLocationPatchError(body.location, area.location);
    if (error) return NextResponse.json({ error }, { status: 422 });
    patch.location = mergeAreaLocation(
      area.location,
      locationPatchFromBody(body.location),
    );
  }

  // Before ANY write: an archive is a delete, so it clears the same gate. See the docstring.
  if (archiving) {
    const relied = await refuseIfReliedUpon(request, "area", area.id);
    if ("response" in relied) return relied.response;
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
 * DELETE — a GENUINE delete. The row goes.
 *
 * ## Archive and delete are two verbs now, and this is the destructive one
 *
 * This used to be the soft archive, on the reasoning that an area's uuid keys its flow and
 * provenance history so the row could never safely go. That reasoning was right about the DATA and
 * wrong about the CONCLUSION: it left the system with no way to retire a row at all, and prod
 * accumulated 17 empty area-of-one shells that nothing could remove. The history is still protected
 * — by refusing while it exists, below, rather than by refusing forever.
 *
 * So: archiving is `PATCH { status: 'archived' }`, which is where it always really lived (the
 * transition gate is on the PATCH, not here). This verb deletes.
 *
 * ## Two interlocks, and NEITHER is waivable
 *
 * 1. **Archived first.** Restated inside the DELETE's own `WHERE` by `hardDeleteArea`, so an area
 *    un-archived mid-decision fails rather than races. Same shape as `derivation delete`'s
 *    disabled-first rule, and the same reasoning: archiving is one reversible command, and it makes
 *    you watch the thing stop being served before it is destroyed.
 *
 * 2. **Nothing may still reference it** → 409 naming every dependent, its `via` and its `effect`.
 *
 * 🛑 Neither interlock is evaluated HERE. Both live inside `hardDeleteArea`, which takes a row lock
 * and re-scans under it — because a scan on the pool followed by a delete on another connection is
 * a committable gap, and a calendar token minted inside it would be CASCADEd away by a delete that
 * had just reported nothing depended on the area. The `status` check below is a friendly fast path,
 * not the guarantee.
 *
 * 🛑 It uses `findDependents`, NOT `refuseIfReliedUpon`. Every other delete route reaches for the
 * adapter, so the divergence is worth stating: the adapter parses `?force=true` and waives the
 * refusal, and an irreversible delete has no business offering that. The dependents each carry a
 * `fix` naming the verb that clears them (`liveone automation move`, `liveone area purge flows`,
 * `liveone calendar revoke`); clearing them is the confirmation step.
 *
 * ## What is NOT checked any more, and why it was not merely moved
 *
 * The old `deviceByHandle(legacySystemId)` 409 — "this is a device's own area" — is gone, from here
 * and from the PATCH archive transition it was briefly going to move to.
 *
 * It is a PRE-0074 PROXY for a question that now has a real column. Back when membership lived in
 * `area_members`, "the handle names a device" was the closest available test for "a device lives
 * here". Since 0074 that is `devices.area_id`, asked directly, and the two answers have diverged
 * completely: on prod all 17 empty area-of-one shells have a handle that names a live device and no
 * devices in them at all. Keeping the proxy would have refused the archive of every single area
 * this work exists to retire, while still not answering whether anything was in them.
 *
 * The thing it was protecting is protected better now:
 *   - devices in the area are a named dependent under BOTH scopes (`areaDependents`);
 *   - `?systemId=N` survives the delete regardless, because `hardDeleteArea` nulls
 *     `legacy_handles.area_id` and keeps the row, so the device leg keeps resolving;
 *   - the flow view was never the shell's to lose — `listFlowEligibleAreaHandles`
 *     (`lib/areas/members.ts`) already excludes an area whose handle names a device that belongs to
 *     a DIFFERENT active area, which is exactly the shells.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const { area } = authed;

  // A cheap, friendly pre-check ONLY. The authoritative one is inside `hardDeleteArea`, under a row
  // lock — see its docstring. This exists so the common case gets a 409 naming the archive verb
  // without opening a transaction, and it is deliberately NOT the thing being relied on.
  if (area.status !== "archived")
    return NextResponse.json(
      {
        error: "That area is not archived, and delete is not the archive verb",
        detail: {
          code: "area-active",
          status: area.status,
          fix: "PATCH { status: 'archived' } first, confirm nothing misses it, then delete",
        },
      },
      { status: 409 },
    );

  try {
    const result = await hardDeleteArea(area.id);
    if (!result.ok)
      return NextResponse.json(
        {
          error: `That area is still relied upon by ${result.dependents.length} thing(s)`,
          detail: {
            code: "relied-upon",
            dependents: result.dependents,
            // Deliberately NOT "…or repeat with ?force=true", which is what the shared adapter says.
            fix: "clear each of them first — this delete has no force",
          },
        },
        { status: 409 },
      );
    return NextResponse.json({ success: true, deleted: result.deleted });
  } catch (err) {
    if (err instanceof AreaNotArchivedError)
      return NextResponse.json(
        {
          error:
            "That area stopped being archived while the delete was deciding",
          detail: { code: "area-active", fix: "re-read it and try again" },
        },
        { status: 409 },
      );
    throw err;
  }
}
