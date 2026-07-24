import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areas,
  pointInfo,
  systems,
} from "@/lib/db/planetscale/schema";
import { loadReadableArea } from "@/lib/areas/http";
import {
  capabilitiesForSystem,
  memberSystemIds,
} from "@/lib/capabilities/server";
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
      name: areas.displayName,
      slug: areas.alias,
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

  const memberIds = await memberSystemIds(r.area.legacySystemId);
  const [memberRows, mappings, areaCaps, bindingRows] = await Promise.all([
    db
      .select({
        id: systems.id,
        name: systems.displayName,
        vendor: systems.vendorType,
        status: systems.status,
      })
      .from(systems)
      .where(inArray(systems.id, memberIds)),
    DeviceRegistry.addrsForHandles(memberIds),
    capabilitiesForSystem(r.area.legacySystemId),
    db
      .select({
        id: areaBindings.id,
        role: areaBindings.role,
        metricType: areaBindings.metricType,
        pointUid: pointInfo.pointUid,
        priority: areaBindings.priority,
        transform: areaBindings.transform,
      })
      .from(areaBindings)
      .innerJoin(
        pointInfo,
        and(
          eq(pointInfo.systemId, areaBindings.pointSystemId),
          eq(pointInfo.index, areaBindings.pointId),
        ),
      )
      .where(eq(areaBindings.areaId, r.area.id))
      .orderBy(
        asc(areaBindings.role),
        asc(areaBindings.metricType),
        asc(areaBindings.priority),
        asc(areaBindings.id),
      ),
  ]);
  const missingMappings = memberIds.filter((member) => !mappings.has(member));
  if (missingMappings.length > 0) {
    return NextResponse.json(
      { error: "device-mapping-incomplete" },
      { status: 503 },
    );
  }
  const memberById = new Map(memberRows.map((member) => [member.id, member]));
  const members = await Promise.all(
    memberIds.map(async (memberId) => {
      const member = memberById.get(memberId);
      const mapping = mappings.get(memberId)!;
      if (!member) throw new Error(`Area member system not found: ${memberId}`);
      const capabilities = await capabilitiesForSystem(memberId);
      return {
        id: mapping.deviceId,
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
