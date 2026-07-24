import { NextRequest, NextResponse } from "next/server";
import { loadReadableArea } from "@/lib/areas/http";
import {
  capabilitiesForSystem,
  memberSystemIds,
} from "@/lib/capabilities/server";
import {
  availableAreaCards,
  availableDeviceCards,
  availableTilesFromCaps,
  CARD_CATALOG,
  TILE_CATALOG,
} from "@/lib/capabilities/catalog";
import { DeviceRegistry } from "@/lib/registry";

/**
 * config-v4 area eligibility (§9.2), DARK — the add-card GALLERY data ("which cards/tiles CAN this area
 * show", grey-out). Per catalog contract #2, ELIGIBILITY ≠ render authority; a consumer must not treat
 * this as the final say on whether a card renders. Readable (owner ∪ viewer).
 *
 * Area-scoped cards/tiles are checked against the area UNION capabilities; device-scoped cards against
 * each MEMBER's own capabilities (catalog contract #1).
 *   GET → { areaCards:[{id,label}], tiles:[{id,label}],
 *           deviceCards:[{ systemId, cards:[{id,label,bindsCapability?}] }] }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;
  const handle = r.area.legacySystemId;

  const areaCaps = await capabilitiesForSystem(handle);
  const areaCards = availableAreaCards(areaCaps).map((cid) => ({
    id: cid,
    label: CARD_CATALOG[cid].label,
  }));
  const tiles = availableTilesFromCaps(areaCaps).map((tid) => ({
    id: tid,
    label: TILE_CATALOG[tid].label,
  }));

  // Per-member device-scoped cards. Best-effort: a per-member failure degrades that member to `cards: []`
  // (same posture as `listReadableAreas`' chartCapable enrichment), never failing the whole route.
  const members = await memberSystemIds(handle);
  const mappings = await DeviceRegistry.addrsForHandles(members);
  if (members.some((systemId) => !mappings.has(systemId))) {
    return NextResponse.json(
      { error: "device-mapping-incomplete" },
      { status: 503 },
    );
  }
  const deviceCards = await Promise.all(
    members.map(async (systemId) => {
      try {
        const caps = await capabilitiesForSystem(systemId);
        const cards = availableDeviceCards(caps).map((cid) => {
          const entry = CARD_CATALOG[cid];
          return entry.bindsCapability
            ? {
                id: cid,
                label: entry.label,
                bindsCapability: entry.bindsCapability,
              }
            : { id: cid, label: entry.label };
        });
        return { deviceId: mappings.get(systemId)!.deviceId, cards };
      } catch {
        return {
          deviceId: mappings.get(systemId)!.deviceId,
          cards: [] as { id: string; label: string }[],
        };
      }
    }),
  );

  return NextResponse.json({ areaCards, tiles, deviceCards });
}
