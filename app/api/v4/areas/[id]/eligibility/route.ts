import { NextRequest, NextResponse } from "next/server";
import { loadReadableArea } from "@/lib/areas/http";
import { capabilitiesForSystem } from "@/lib/capabilities/server";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
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
  //
  // Membership arrives as device ids (slice H), so the `dv_` TypeIDs this route emits come straight off
  // the membership rows — no `legacy_handles` round trip. That also retires the `device-mapping-incomplete`
  // 503: `area_members.device_id` FKs `devices.id`, so a member without a device row is unrepresentable.
  // The rid hop remains only because `capabilitiesForSystem` is still int-keyed (Phase 13 removes it).
  const memberIds = await getAreaMemberDeviceIds(r.area.id);
  const memberRids = await DeviceRegistry.ridsForDevices(memberIds);
  const deviceCards = await Promise.all(
    memberIds.map(async (deviceId) => {
      try {
        const caps = await capabilitiesForSystem(memberRids.get(deviceId)!);
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
        return { deviceId, cards };
      } catch {
        return {
          deviceId,
          cards: [] as { id: string; label: string }[],
        };
      }
    }),
  );

  return NextResponse.json({ areaCards, tiles, deviceCards });
}
