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
import { and, asc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, devices } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { helperSiteId } from "./helper-site-id";
import { refreshAreaServing, rehomeDevice } from "./create";

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

  // 🛑 DEDUPE ON EXACTLY THE PREDICATE OF THE UNIQUE INDEX — `(vendor_site_id) WHERE vendor =
  // 'helper'`. Both halves, and the `vendor` half is a SECURITY boundary, not tidiness.
  //
  // This has now been got wrong three times, the same way each time: the lookup asked a different
  // question from the constraint that would raise.
  //   1. It asked "is there a helper that is a MEMBER of this Area" over `area_members`. A missing
  //      membership row made it miss, and liveone-dev accumulated two `Craig Unified · derived` and
  //      two `Daylesford · derived` (cleaned up 2026-08-04).
  //   2. Migration 0071 moved it to `devices.area_id`. That fixed the instance and kept the shape: a
  //      helper moved OUT of its area is invisible to a lookup that searches inside the area, so the
  //      next recompute 500s on `devices_helper_area_unique` instead of duplicating. Reproduced on
  //      `origin/main` with `v4-surface-smoke`.
  //   3. Fixing (2) by matching `vendor_site_id` ALONE went too far the other way. The index is
  //      PARTIAL, so matching without `vendor` matches rows the index does not constrain — and
  //      `vendor_site_id` is CALLER-SUPPLIED at `POST /api/devices`. Any authenticated user could
  //      create an ordinary device with `vendorSiteId: "helper:area:ar_<someone-else's-area>"`, and
  //      this lookup would then adopt THEIR device into that area and `writeBlendOutputs` would
  //      write another household's private derived readings onto a device they own and can read.
  //      Found by review before it shipped.
  const siteId = helperSiteId(areaId);
  const existing = await db
    .select({ rid: devices.rid, uuid: devices.id, areaId: devices.areaId })
    .from(devices)
    .where(and(eq(devices.vendorSiteId, siteId), eq(devices.vendor, "helper")))
    .orderBy(asc(devices.rid))
    .limit(1);
  if (existing.length > 0) {
    const found = existing[0];
    // Self-healing rather than merely non-fatal: a helper found outside its own area is put back,
    // because the area it was in has been serving this area's blend points in the meantime.
    //
    // 🛑 Through `rehomeDevice`, not a bare `setDeviceArea`. Moving the row alone leaves the
    // DEPARTING area's bindings onto the helper's points in place, and a binding is an override
    // that SELECTS a point — so that area would go on serving this area's blend after the helper
    // had left it. Same cleanup, same serving refresh, as any other re-home.
    if (found.areaId !== areaId) {
      const moved = await rehomeDevice(
        Device.encode(found.uuid),
        areaId,
        new Map([[found.uuid, found.areaId]]),
      );
      if (moved.fromAreaId) await refreshAreaServing(moved.fromAreaId);
      await refreshAreaServing(areaId);
    }
    return found.rid;
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
