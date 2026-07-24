import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { loadReadableArea } from "@/lib/areas/http";
import { getAreaBindingsForEditor } from "@/lib/areas/create";
import { memberSystemIds } from "@/lib/capabilities/server";
import { Area } from "@/lib/ids";

/**
 * config-v4 single area (§9.2), DARK, TypeID-native. Readable (owner ∪ viewer), matching `default-section`.
 *   GET → { area:{ id: ar_…, displayName, status }, members:[systemId:int], bindings:[…],
 *           placement:{ location, timezoneOffsetMin, displayTimezone } }
 *
 * `members` is the EFFECTIVE member set (`memberSystemIds`: `area_devices`, or the handle itself for an
 * area-of-one) — the honest resolved membership, not the raw `area_devices` rows (which a legacy
 * real-system area-of-one may lack pre-cutover). Members stay integer systemIds: devices have no uuid
 * until the cutover mints `dv_` — the one entity the TypeID-native surface can't speak yet.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;
  const uuid = r.area.id;

  const [row] = await requirePlanetscaleDb()
    .select({
      displayName: areas.displayName,
      status: areas.status,
      location: areas.location,
      timezoneOffsetMin: areas.timezoneOffsetMin,
      displayTimezone: areas.displayTimezone,
    })
    .from(areas)
    .where(eq(areas.id, uuid))
    .limit(1);
  if (!row) {
    // loadReadableArea already found this area; a race (delete) is the only way here.
    return NextResponse.json({ error: "Area not found" }, { status: 404 });
  }

  const members = await memberSystemIds(r.area.legacySystemId);
  const bindings = await getAreaBindingsForEditor(uuid);

  return NextResponse.json({
    area: {
      id: Area.encode(uuid),
      displayName: row.displayName,
      status: row.status,
    },
    members,
    bindings,
    placement: {
      location: row.location,
      timezoneOffsetMin: row.timezoneOffsetMin,
      displayTimezone: row.displayTimezone,
    },
  });
}
