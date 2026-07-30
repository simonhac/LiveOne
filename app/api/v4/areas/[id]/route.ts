import { NextRequest, NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices, areaBindings, areas } from "@/lib/db/planetscale/schema";
import { loadReadableArea } from "@/lib/areas/http";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { DeviceRegistry } from "@/lib/registry";
import { areaDetailResponse } from "@/lib/areas/v4-shapes";

/**
 * Final TypeID-native area aggregate. Legacy integer handles remain an internal addressing detail and
 * never cross this API boundary.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;
  const db = requirePlanetscaleDb();

  const [row] = await db
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
    .where(eq(areas.id, r.area.id))
    .limit(1);
  if (!row)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  // Membership arrives as device ids (slice H), so the `dv_` TypeIDs this route emits come straight off
  // the membership rows — no `legacy_handles` round trip, and no `device-mapping-incomplete` 503, since
  // `area_members.device_id` FKs `devices.id`. The rid hop remains only because `devices` and
  // `capabilitiesForDevice` are still int-keyed (Phase 13 removes it).
  const memberIds = await getAreaMemberDeviceIds(r.area.id);
  const memberRids = await DeviceRegistry.ridsForDevices(memberIds);
  const [memberRows, areaCaps, bindingRows] = await Promise.all([
    db
      .select({
        id: devices.rid,
        name: devices.name,
        vendor: devices.vendor,
        status: devices.status,
      })
      .from(devices)
      .where(inArray(devices.rid, [...memberRids.values()])),
    capabilitiesForDevice(r.area.legacySystemId),
    db
      .select({
        id: areaBindings.id,
        role: areaBindings.role,
        metricType: areaBindings.metricType,
        // `area_bindings` holds the uuid itself (`point_uid`, NOT NULL since 0047), so the
        // `point_info` join this projection used to need is gone — it produced nothing else.
        pointUid: areaBindings.pointUid,
        priority: areaBindings.priority,
        transform: areaBindings.transform,
      })
      .from(areaBindings)
      .where(eq(areaBindings.areaId, r.area.id))
      .orderBy(
        asc(areaBindings.role),
        asc(areaBindings.metricType),
        asc(areaBindings.priority),
        asc(areaBindings.id),
      ),
  ]);
  const memberById = new Map(memberRows.map((member) => [member.id, member]));
  const members = await Promise.all(
    memberIds.map(async (deviceId) => {
      const rid = memberRids.get(deviceId)!;
      const member = memberById.get(rid);
      if (!member) throw new Error(`Area member system not found: ${rid}`);
      const capabilities = await capabilitiesForDevice(rid);
      return {
        id: deviceId,
        name: member.name,
        vendor: member.vendor,
        status: member.status,
        capabilities: [...capabilities].sort(),
      };
    }),
  );

  return NextResponse.json(
    areaDetailResponse({
      area: {
        ...row,
        capabilities: [...areaCaps],
      },
      members,
      bindings: bindingRows,
    }),
  );
}
