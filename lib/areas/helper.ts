/**
 * Helper devices — derived, non-physical, never-polled `devices` rows (vendor='helper') that live
 * in an Area and own the Area's COMPUTED points (the battery-provenance blend is the first tenant). A
 * helper is a MEMBER of exactly one Area; it is owned by the Area's owner (private household-derived data,
 * NOT ownerless).
 *
 * "Exactly one Area" is structural since migration 0071 — `devices.area_id`, one nullable column —
 * rather than a convention over the many-to-many `area_members` it replaced. Since Stage 5 the
 * helper is CREATED in its Area rather than minted elsewhere and moved, so there is no window in
 * which it exists and is not yet a member, and `assertDevicesRehomable` refuses to move it out.
 */
import { asc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, devices } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { helperSiteId } from "./helper-site-id";
import { setDeviceArea } from "./members";

/**
 * Ensure the Area's helper device exists and is in it, returning its integer handle (`devices.rid`).
 *
 * Idempotent, and located by `vendor_site_id` — see the comment on the lookup for why that column
 * and not the area. `devices_helper_area_unique` makes the mint race-safe in the last resort: the
 * loser gets a 23505 rather than a second helper.
 */
export async function ensureHelperDevice(areaId: string): Promise<number> {
  const db = requirePlanetscaleDb();

  const [area] = await db
    .select({
      displayName: areas.name,
      owner: areas.ownerUserId,
      tzOff: areas.timezoneOffsetMin,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  if (!area) throw new Error(`ensureHelperDevice: no area ${areaId}`);

  // 🛑 DEDUPE ON `vendor_site_id`, the column the UNIQUE INDEX is on.
  //
  // This has now been got wrong twice, the same way both times: the lookup asked a different
  // question from the constraint that would raise, so it missed and this function tried to mint a
  // duplicate. First it asked "is there a helper that is a MEMBER of this Area" over `area_members`
  // — a missing membership row made it miss and liveone-dev accumulated two `Craig Unified ·
  // derived` and two `Daylesford · derived` (cleaned up 2026-08-04). Migration 0071 moved it to
  // `devices.area_id`, which fixed that instance and left the shape: a helper that has been moved
  // OUT of its area is invisible to a lookup that searches inside the area, so the next recompute
  // 500s on `devices_helper_area_unique` instead of duplicating. Reproduced on `origin/main` with
  // `v4-surface-smoke`, whose members section deliberately adopts a real helper into a scratch area.
  //
  // `helperSiteId(areaId)` is a total function of the area AND is what the unique index constrains,
  // so asking it cannot disagree with the insert that follows. `assertDevicesRehomable` now refuses
  // the adoption that caused this, but the lookup should not depend on that being true.
  const siteId = helperSiteId(areaId);
  const existing = await db
    .select({ rid: devices.rid, uuid: devices.id, areaId: devices.areaId })
    .from(devices)
    .where(eq(devices.vendorSiteId, siteId))
    .orderBy(asc(devices.rid))
    .limit(1);
  if (existing.length > 0) {
    // Self-healing rather than merely non-fatal: a helper found outside its own area is put back,
    // because the area it was in has been serving this area's blend points in the meantime.
    if (existing[0].areaId !== areaId)
      await setDeviceArea(db, Device.encode(existing[0].uuid), areaId);
    return existing[0].rid;
  }

  const helper = await DeviceWriter.createHelperDevice({
    ownerClerkUserId: area.owner,
    // 🛑 The helper is created IN the Area, in one insert. It used to be minted into an area-of-one
    // and then moved here by a follow-up `setDeviceArea`, which is what opened the window the
    // duplicate-helper bug lived in: the dedupe above reads `devices.area_id`, so between the insert
    // and the move the helper existed and was invisible to the very check meant to find it.
    areaId,
    vendorSiteId: helperSiteId(areaId),
    displayName: `${area.displayName ?? "Area"} · derived`,
    timezoneOffsetMin: area.tzOff,
  });
  return helper.id;
}
