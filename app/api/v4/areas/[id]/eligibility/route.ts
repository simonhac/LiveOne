import { NextRequest, NextResponse } from "next/server";
import { loadReadableArea } from "@/lib/areas/http";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import {
  availableAreaCards,
  availableDeviceCards,
  NODE_CATALOG,
} from "@/lib/capabilities/catalog";
import { DeviceRegistry } from "@/lib/registry";

/**
 * Area eligibility (§9.2) — the add-card GALLERY data ("which cards CAN this area show", grey-out). Per catalog contract #2, ELIGIBILITY ≠ render authority; a consumer must not treat
 * this as the final say on whether a card renders. Readable (owner ∪ viewer).
 *
 * Area-scoped cards are checked against the area UNION capabilities; device-scoped cards against
 * each MEMBER's own capabilities (catalog contract #1).
 *   GET → { areaCards:[{id,label}],
 *           deviceCards:[{ deviceId: dv_…, cards:[{id,label,bindsCapability?}] }] }
 * (the key is `deviceId` and carries a `dv_` TypeID — this said `systemId` while the handler has
 *  emitted `deviceId` since slice H; nothing called it, so the drift was never observed.)
 *
 * 🆕 THE `tiles` KEY IS GONE — a WIRE CHANGE, made while this surface
 * still has no client. It existed because the catalog was two maps over two id spaces; §8.1 says a
 * tile IS a card, and `NODE_CATALOG` is now one map, so the tile views appear in `areaCards` (first,
 * in canonical tile order) like every other area-scoped card. The old `{id:"tiles"}` ENTRY is gone
 * too: in v4 that container is a `row` group, not a card, so it has no eligibility of its own.
 * Nothing is lost — the former `tiles` list was exactly the area-scoped tile subset of `areaCards`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;
  const handle = r.area.legacySystemId;

  const areaCaps = await capabilitiesForDevice(handle);
  const areaCards = availableAreaCards(areaCaps).map((cid) => ({
    id: cid,
    label: NODE_CATALOG[cid].label,
  }));

  // Per-member device-scoped cards. Best-effort: a per-member failure degrades that member to `cards: []`
  // (same posture as `listReadableAreas`' chartCapable enrichment), never failing the whole route.
  //
  // Membership arrives as device ids (slice H), so the `dv_` TypeIDs this route emits come straight off
  // the membership rows — no `legacy_handles` round trip. That also retires the `device-mapping-incomplete`
  // 503: `area_members.device_id` FKs `devices.id`, so a member without a device row is unrepresentable.
  // The rid hop remains only because `capabilitiesForDevice` is still int-keyed (Phase 13 removes it).
  const memberIds = await getAreaMemberDeviceIds(r.area.id);
  const memberRids = await DeviceRegistry.ridsForDevices(memberIds);
  const deviceCards = await Promise.all(
    memberIds.map(async (deviceId) => {
      try {
        const caps = await capabilitiesForDevice(memberRids.get(deviceId)!);
        const cards = availableDeviceCards(caps).map((cid) => {
          const entry = NODE_CATALOG[cid];
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

  return NextResponse.json({ areaCards, deviceCards });
}
