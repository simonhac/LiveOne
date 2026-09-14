import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { asc, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as devicesTable,
  points as pointsTable,
} from "@/lib/db/planetscale/schema";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { Area, Device, Point } from "@/lib/ids";
import { loadAreaForAuth } from "@/lib/areas/http";
import {
  assertDevicesRehomable,
  refreshAreaServing,
  rehomeDevice,
  AreaAccessError,
  AreaValidationError,
} from "@/lib/areas/create";

/**
 * `GET /api/v4/devices/{id}` — the per-device aggregate: everything the list route (`GET
 * /api/v4/devices`) says about one device, plus the columns a fleet-wide list deliberately leaves out
 * (config, adapter state, model/serial, timestamps), plus `?include=points` for the device's full
 * point roster. Read-only; the operator CLI's `device show`.
 *
 * Readability is decided by the SAME source as the list route — `devicesVisibleByUser` (owned ∪
 * public ∪ dashboard-granted, active only unless `?includeArchived=true`) — so the aggregate can
 * never answer for a device the list would not name. Unknown and not-readable are deliberately the SAME 404: distinguishing them would
 * make this an existence oracle over other owners' devices (the §8.4 rule the areas loaders apply as
 * a 403 collapse; here the twins collapse into 404 because the resource is addressed by id, not
 * listed).
 *
 * `config` and `adapterState` are the jsonb columns AS-IS. Neither holds credentials — vendor creds
 * live in Clerk privateMetadata, not `devices.config` — which is what makes a plain pass-through safe.
 *
 * `?include=capabilities` adds the DERIVED capability list (`capabilitiesForDevice` — the same walk
 * the area aggregate runs per member). Opt-in because each entry costs a point scan + compound
 * predicates; the area aggregate remains the authoritative place to read capabilities in context.
 *
 * The `points` leg reads the `points` table directly rather than going through
 * `PointManager.getActivePointsForDevice`: the manager serves `PointInfo`, a wire shape that predates
 * (and does not carry) `points.control`, and this aggregate wants the stored columns, not the served
 * projection. Path composition matches `/api/device/{systemId}/points` exactly — full physical path
 * `liveone/{vendor}/{vendorSiteId}/{tail}`, logical path `{stem}/{metricType}` — so the two payloads
 * describe the same point with the same strings.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid)
    return NextResponse.json(
      { error: `Invalid device id: ${id}` },
      { status: 400 },
    );

  const [row] = await requirePlanetscaleDb()
    .select()
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);

  // `?includeArchived=true` widens WHICH STATUSES are readable, never WHOSE devices — the same
  // opt-in the list route and `GET /api/v4/areas` take, and deliberately NOT implied by
  // `x-liveone-admin` (admin widens the owner set, not the status set). `devicesVisibleByUser` is
  // `activeOnly` by default, while an area aggregate DOES return its archived members
  // (`lib/areas/v4-shapes.ts`), so without this the two disagree and every consumer that walks an
  // area's members into this route 404s on a retired one.
  const includeArchived =
    request.nextUrl.searchParams.get("includeArchived") === "true";
  // The readable set is keyed by rid (the list route's `VisibleDevice.id`), so the row must resolve
  // first — but a missing row and an unreadable one exit through the SAME response (see header).
  const visible = row
    ? await DeviceConfigRegistry.devicesVisibleByUser(
        auth.userId,
        !includeArchived,
        { isAdmin: auth.actingAsAdmin },
      )
    : [];
  if (!row || !visible.some((d) => d.id === row.rid))
    return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const include = (request.nextUrl.searchParams.get("include") ?? "").split(
    ",",
  );
  const points = include.includes("points")
    ? (
        await requirePlanetscaleDb()
          .select()
          .from(pointsTable)
          .where(eq(pointsTable.deviceId, row.id))
          .orderBy(asc(pointsTable.rid))
      ).map((p) => ({
        id: Point.encode(p.id),
        physicalPath: `liveone/${row.vendor}/${row.vendorSiteId}/${p.physicalPath}`,
        logicalPath: p.logicalPath ? `${p.logicalPath}/${p.metricType}` : null,
        metricType: p.metricType,
        unit: p.unit,
        name: p.name,
        subsystem: p.subsystem,
        active: p.active,
        control: p.control ?? null,
      }))
    : undefined;

  const capabilities = include.includes("capabilities")
    ? [...(await capabilitiesForDevice(row.rid))].sort()
    : undefined;

  return NextResponse.json({
    id: Device.encode(row.id),
    legacySystemId: row.rid,
    name: row.name,
    slug: row.slug,
    vendor: row.vendor,
    vendorSiteId: row.vendorSiteId,
    status: row.status,
    ownerUserId: row.ownerUserId,
    model: row.model,
    serial: row.serial,
    commissionedOn: row.commissionedOn,
    // The area the device is IN — nullable, because a device is in 0 or 1 area. This used to sit
    // beside a `primaryAreaId` naming the eagerly-minted area-of-one; that shell is no longer minted
    // and its column is dropped by migration 0073, so this is the only area a device has.
    areaId: row.areaId ? Area.encode(row.areaId) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    config: row.config ?? null,
    adapterState: row.adapterState ?? null,
    ...(capabilities ? { capabilities } : {}),
    ...(points ? { points } : {}),
  });
}

/**
 * `PATCH /api/v4/devices/{id}` — rename with `{ name }`, or move with `{ areaId }`.
 * Naming requires device ownership or admin; area custody alone cannot rename a device.
 * Names and moves cannot be combined, avoiding partial writes with different authorization rules.
 *
 * The device-side inverse of `PUT /api/v4/areas/{id}/members`, and the ONLY way to say *not
 * assigned*. Both verbs exist because both questions are natural: the area builder asks "which
 * devices are in this area", the device settings dialog asks "which area is this device in". Home
 * Assistant carries the same pair.
 *
 * 🛑 It is a MOVE. The device leaves whatever area it was in, and that area loses every binding whose
 * point lives on the device — so the two authorizations are separate questions and BOTH are asked:
 *
 *  - `assertDevicesRehomable` — may the caller take this device out of where it is? (Own it, or own
 *    the area it is leaving. An ownerless OpenElectricity region is refused outright: it is an
 *    ambient SERVICE producer that consumers reference by id.)
 *  - area ownership — may the caller put it in the destination? Owning the device is NOT enough;
 *    otherwise anyone could push a device into a stranger's site and change what that site's Sankey
 *    reports.
 *
 * `areaId: null` needs only the first, since there is no destination to authorize.
 *
 * 400 malformed id · 403 destination not yours · 404 no such device OR not yours to move ·
 * 409 the device moved under you · 422 bad body / ambient device.
 *
 * 🛑 "No such device" and "not yours to move" are the SAME 404, the §8.4 collapse. Holding a
 * well-formed `dv_` string is not permission to learn whether it names anything, and a distinct 403
 * would confirm the existence of any device a caller cared to guess at. The DESTINATION's 403 is
 * different and is kept: the caller demonstrably knows that area exists, because they named it.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid)
    return NextResponse.json(
      { error: `Invalid device id: ${id}` },
      { status: 400 },
    );

  const body = (await request.json().catch(() => null)) as {
    areaId?: unknown;
    name?: unknown;
  } | null;
  if (body && typeof body === "object" && "name" in body) {
    if (Object.keys(body).some((key) => key !== "name"))
      return NextResponse.json(
        {
          error: "Send name alone; do not combine a rename with other changes",
        },
        { status: 422 },
      );
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 100
    )
      return NextResponse.json(
        { error: "name must be a nonempty string of at most 100 characters" },
        { status: 422 },
      );
    const [device] = await requirePlanetscaleDb()
      .select({
        rid: devicesTable.rid,
        name: devicesTable.name,
        ownerUserId: devicesTable.ownerUserId,
      })
      .from(devicesTable)
      .where(eq(devicesTable.id, uuid))
      .limit(1);
    if (!device || !(auth.isAdmin || device.ownerUserId === auth.userId))
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    const name = body.name.trim();
    const renamed = name !== device.name;
    if (renamed) {
      await DeviceWriter.updateDevice(device.rid, { displayName: name });
      revalidatePath("/dashboard", "layout");
      revalidatePath("/device", "layout");
    }
    return NextResponse.json({ id, name, previousName: device.name, renamed });
  }
  // `areaId` must be PRESENT — `{}` is not "unassign". Absent-means-null is exactly the shape that
  // lets a client bug orphan a device silently.
  if (!body || typeof body !== "object" || !("areaId" in body))
    return NextResponse.json(
      { error: "body must be { areaId: ar_… | null }" },
      { status: 422 },
    );
  const rawArea = body.areaId;
  if (rawArea !== null && typeof rawArea !== "string")
    return NextResponse.json(
      { error: "areaId must be an ar_ id or null" },
      { status: 422 },
    );
  const targetAreaUuid = rawArea === null ? null : Area.toUuidOrNull(rawArea);
  if (rawArea !== null && !targetAreaUuid)
    return NextResponse.json(
      { error: `Invalid area id: ${rawArea}` },
      { status: 422 },
    );

  const [row] = await requirePlanetscaleDb()
    .select({ rid: devicesTable.rid })
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  if (!row)
    return NextResponse.json({ error: "Device not found" }, { status: 404 });

  // 🛑 `assertDevicesRehomable` is the WHOLE authorization here, and there is deliberately no
  // `devicesVisibleByUser` precheck in front of it. That set is the PICKER's — owned ∪ public ∪
  // dashboard-granted, ACTIVE only — and it is the wrong question for this verb in three ways, each
  // of which 404'd a caller who was entitled: an admin acting as admin is not in it; an area owner
  // with CUSTODY of someone else's device is not in it (custody is exactly the case the picker
  // cannot express); and a DISABLED device is filtered out of it, so a device could not be re-homed
  // precisely when you most want to tidy it away. Found in review.
  let authorized;
  try {
    // 🛑 `isAdmin`, not `actingAsAdmin`, and deliberately. This PR's rule is that READS are opt-in
    // (`x-liveone-admin`) while WRITES keep the unconditional admin they have always had —
    // `loadAreaForOwner` and `requireDeviceAccess` both grant it without asking, and this route
    // would be the lone exception if it did otherwise. Moving the whole write side onto the opt-in
    // is the right end state and is one coherent change; see docs/architecture/api.md.
    authorized = await assertDevicesRehomable(
      auth.userId,
      auth.isAdmin,
      [row.rid],
      // The destination, so re-stating a helper's current area is a no-op rather than a 422. A
      // helper being moved ANYWHERE else — including to `null` — is still refused.
      targetAreaUuid ?? undefined,
    );
  } catch (err) {
    // 🛑 `AreaAccessError` collapses into the SAME 404 as "no such device". Holding a well-formed
    // `dv_` string is not permission to learn whether it names anything: a 403 here would confirm the
    // existence of any device an attacker cared to guess at, and would echo its integer handle while
    // doing so. `AreaValidationError` stays a 422 because it is a statement about a device the caller
    // has already been shown to be entitled to (ambient, or the id resolves to no row at all).
    if (err instanceof AreaAccessError)
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }

  if (targetAreaUuid) {
    const area = await loadAreaForAuth(targetAreaUuid);
    // Unknown destination and un-owned destination collapse into one 403, the §8.4 rule the area
    // loaders apply: distinguishing them is an existence oracle over other owners' areas.
    if (!area || !(auth.isAdmin || area.ownerClerkUserId === auth.userId))
      return NextResponse.json(
        { error: "Area not found or not writable" },
        { status: 403 },
      );
  }

  const { fromAreaId, moved, conflicted } = await rehomeDevice(
    Device.encode(uuid),
    targetAreaUuid,
    authorized,
  );
  // 🛑 Someone moved this device between the authorization and the write, so nothing was written and
  // we do not know where it is now. A 200 here would have to name an area, and every candidate is a
  // guess: the destination (not true), or where authorization saw it (also not true). 409 and refetch
  // is the only honest answer.
  if (conflicted)
    return NextResponse.json(
      {
        error:
          "This device moved while you were moving it — refetch and try again.",
      },
      { status: 409 },
    );
  // 🛑 BOTH ends. The source area's KV subscriptions and point-series cache still name this device's
  // points; refreshing only the destination leaves it serving latest values for a device it no longer
  // holds. Skipped entirely on a no-op move, which touched nothing.
  if (moved) {
    if (fromAreaId) await refreshAreaServing(fromAreaId);
    if (targetAreaUuid) await refreshAreaServing(targetAreaUuid);
  }

  // Past the conflict check, `moved: false` can only mean "already there" — so the destination IS
  // where the device is, either way.
  return NextResponse.json({
    id: Device.encode(uuid),
    areaId: targetAreaUuid ? Area.encode(targetAreaUuid) : null,
    previousAreaId: fromAreaId ? Area.encode(fromAreaId) : null,
    moved,
  });
}
