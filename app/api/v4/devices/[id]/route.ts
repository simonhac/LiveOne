import { NextRequest, NextResponse } from "next/server";
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
 * public ∪ dashboard-granted, active only) — so the aggregate can never answer for a device the list
 * would not name. Unknown and not-readable are deliberately the SAME 404: distinguishing them would
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

  // The readable set is keyed by rid (the list route's `VisibleDevice.id`), so the row must resolve
  // first — but a missing row and an unreadable one exit through the SAME response (see header).
  const visible = row
    ? await DeviceConfigRegistry.devicesVisibleByUser(auth.userId, true)
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
    primaryAreaId: Area.encode(row.primaryAreaId),
    // The area the device is IN — nullable, because a device is in 0 or 1 area. Distinct from
    // `primaryAreaId`, which is the eagerly-minted area-of-one it was born with and which the
    // resolver stopped consulting at migration 0071.
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
 * `PATCH /api/v4/devices/{id}` — put this device in an area, or in none: `{ areaId: "ar_…" | null }`.
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
 * Unknown device and unreadable device are the SAME 404 as on `GET`, for the same reason (an
 * existence oracle over other owners' devices). 400 malformed id · 403 not yours · 404 unknown ·
 * 422 bad body / ambient device.
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
  } | null;
  // `areaId` must be PRESENT — `{}` is not "unassign". Absent-means-null is exactly the shape that
  // lets a client bug orphan a device silently, and this route has no other field to patch.
  if (!body || !("areaId" in body))
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
  const visible = row
    ? await DeviceConfigRegistry.devicesVisibleByUser(auth.userId, true)
    : [];
  if (!row || !visible.some((d) => d.id === row.rid))
    return NextResponse.json({ error: "Device not found" }, { status: 404 });

  try {
    await assertDevicesRehomable(auth.userId, auth.isAdmin, [row.rid]);
  } catch (err) {
    if (err instanceof AreaAccessError)
      return NextResponse.json({ error: err.message }, { status: 403 });
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

  const { fromAreaId, moved } = await rehomeDevice(
    Device.encode(uuid),
    targetAreaUuid,
  );
  // 🛑 BOTH ends. The source area's KV subscriptions and point-series cache still name this device's
  // points; refreshing only the destination leaves it serving latest values for a device it no longer
  // holds. Skipped entirely on a no-op move, which touched nothing.
  if (moved) {
    if (fromAreaId) await refreshAreaServing(fromAreaId);
    if (targetAreaUuid) await refreshAreaServing(targetAreaUuid);
  }

  return NextResponse.json({
    id: Device.encode(uuid),
    areaId: targetAreaUuid ? Area.encode(targetAreaUuid) : null,
    previousAreaId: fromAreaId ? Area.encode(fromAreaId) : null,
    moved,
  });
}
