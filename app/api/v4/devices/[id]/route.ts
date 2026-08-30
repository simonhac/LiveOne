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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    config: row.config ?? null,
    adapterState: row.adapterState ?? null,
    ...(capabilities ? { capabilities } : {}),
    ...(points ? { points } : {}),
  });
}
