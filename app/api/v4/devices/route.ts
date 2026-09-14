import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas as areasTable,
  devices as devicesTable,
} from "@/lib/db/planetscale/schema";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { Area, Device } from "@/lib/ids";

/**
 * `GET /api/v4/devices` (clean-sheet §9.2) — the readable device set: exactly the devices visible to
 * the caller (owned ∪ granted ∪ public), which is also the no-escalation set the area create/member
 * routes enforce. An admin who sends `x-liveone-admin` gets the whole fleet; being an admin is not
 * acting as one, so without it this answers exactly as it does for anyone else — which is what keeps
 * the member picker from quietly becoming a fleet list.
 * It is the TypeID-native twin of `GET /api/areas/candidate-devices` (the area
 * builder's member picker), and §9.2 already names this resource, so the port lands here rather than
 * under `/areas`.
 *
 * 🛑 **Nothing the legacy twin returns is dropped** — the config-v4 Phase 14 STEP 0 lesson (a v4 read
 * that silently narrows its payload is invisible to a status-code test and fatal to the client that
 * moves onto it). Every legacy key is carried; four are RENAMED into the v4 vocabulary already fixed by
 * `GET /api/v4/areas/{id}`'s `members[]` and by the `devices` table's own column names, and the old
 * integer `id` is carried alongside the TypeID rather than replaced:
 *
 * | legacy `candidate-devices` | here             | why                                              |
 * | -------------------------- | ---------------- | ------------------------------------------------ |
 * | `id` (int `devices.rid`)   | `id` (`dv_`)     | §9.2: identities cross as TypeIDs                |
 * | —                          | `legacySystemId` | the int ADDRESS, carried not dropped (see below) |
 * | `displayName`              | `name`           | `devices.name`; area `members[]` already says so |
 * | `vendorType`               | `vendor`         | `devices.vendor`; idem                           |
 * | `alias`                    | `slug`           | `devices.slug`; v4 says slug everywhere          |
 * | `ownerClerkUserId`         | `ownerUserId`    | `devices.owner_user_id`                          |
 * | `vendorSiteId`, `status`   | unchanged        |                                                  |
 *
 * `legacySystemId` is the integer `/api/data?systemId=` address, NOT an identity — same reasoning (and
 * same key) as `GET /api/v4/areas`. It is what today's member picker round-trips into
 * `memberSystemIds`, so carrying it makes re-pointing the client a URL change.
 *
 * `areaId` / `areaName` are NEW here, and they are not decoration: membership is `devices.area_id`
 * and naming a device in an area MOVES it, so every picker and every CLI diff that offers a device
 * has to be able to say what it would be taken out of. Null means ambient — HA's unassigned bucket,
 * which is where the OpenElectricity NEM regions permanently live.
 *
 * ⚠️ **`capabilities` (§9.2's fifth field) is deliberately NOT here.** It is absent from the legacy
 * twin, so omitting it narrows nothing; and each entry would cost a full `capabilitiesForDevice` walk
 * (a PointManager point scan + a member walk + a grid-context resolve) on a request the member picker
 * fires when a dialog opens. Add it behind an explicit `?include=capabilities` when a client needs it.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  // `?includeInactive=true` widens the list to every status, not just `active`.
  //
  // 🛑 Named `includeInactive`, NOT `includeArchived` like the areas twin, and the difference is not
  // an oversight. `areas.status` is `active | archived` (migration 0076), so there "not active" and
  // "archived" are the same set and one name is true of both. `devices.status` is
  // `active | disabled | archived`, so a flag called `includeArchived` that also returned `disabled`
  // devices would be quietly wrong — and quietly wrong in the widening direction.
  //
  // Exact string "true", like every other boolean query param here, so a typo fails closed.
  const includeInactive =
    request.nextUrl.searchParams.get("includeInactive") === "true";

  const visible = await DeviceConfigRegistry.devicesVisibleByUser(
    auth.userId,
    !includeInactive,
    { isAdmin: auth.actingAsAdmin },
  );
  // rid → uuid in ONE indexed read. Deliberately not widened into `VisibleDevice` itself: that
  // projection is shared with the device switcher and two other agents are editing this tree.
  const rids = visible.map((d) => d.id);
  const rows = rids.length
    ? await requirePlanetscaleDb()
        .select({
          rid: devicesTable.rid,
          id: devicesTable.id,
          areaId: devicesTable.areaId,
          areaName: areasTable.name,
        })
        .from(devicesTable)
        // LEFT: an ambient device (`area_id` NULL) must still appear in the picker — it is the one
        // an operator most needs to see, and an INNER join would silently drop it.
        .leftJoin(areasTable, eq(areasTable.id, devicesTable.areaId))
        .where(inArray(devicesTable.rid, rids))
    : [];
  const rowByRid = new Map(rows.map((r) => [r.rid, r]));

  return NextResponse.json({
    devices: visible.map((d) => {
      const row = rowByRid.get(d.id);
      return {
        // Every visible device came out of `devices`, so the uuid is always there; the fallback only
        // exists so a mapping hole degrades to a 200 with a null id instead of a 500.
        id: row ? Device.encode(row.id) : null,
        legacySystemId: d.id,
        name: d.displayName,
        slug: d.alias,
        vendor: d.vendorType,
        vendorSiteId: d.vendorSiteId,
        status: d.status,
        ownerUserId: d.ownerClerkUserId,
        areaId: row?.areaId ? Area.encode(row.areaId) : null,
        areaName: row?.areaName ?? null,
      };
    }),
  });
}
