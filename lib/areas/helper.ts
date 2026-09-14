/**
 * Helper devices — derived, non-physical, never-polled `devices` rows (vendor='helper') that live
 * in an Area and own the Area's COMPUTED points (the battery-provenance blend is the first tenant). A
 * helper is a MEMBER of exactly one Area; it is owned by the Area's owner (private household-derived data,
 * NOT ownerless).
 *
 * "Exactly one Area" is structural since migration 0071 — `devices.area_id`, one nullable column —
 * rather than a convention over the many-to-many `area_members` it replaced. That is what makes the
 * dedupe below reliable, and since Stage 5 the helper is CREATED in its Area rather than minted
 * elsewhere and moved, so there is no window in which it exists and the dedupe cannot see it.
 */
import { and, asc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, devices } from "@/lib/db/planetscale/schema";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { helperSiteId } from "./helper-site-id";

/**
 * Ensure the Area's helper device exists and is a member, returning its integer handle (`devices.rid`).
 * Idempotent:
 * located by "the helper member of this Area" (one helper per Area). Best-effort race-safety (the
 * recompute driver is sequential per handle); the optional `systems_helper_area_unique` partial index
 * would make it fully race-safe (approval-gated migration, not required for the MVP).
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

  // Membership is uuid-keyed since slice H, so this reads `devices` and returns `devices.rid`. Since
  // slice 1a `devices` is not a mirror of anything — it is the registry — so `vendor` is written here
  // directly rather than copied from `systems.vendor_type`.
  // Since migration 0071 this dedupes on `devices.area_id` rather than an `area_members` join, which
  // makes the duplicate-helper race STRUCTURALLY impossible rather than merely unlikely. The old
  // lookup asked "is there a helper that is a MEMBER of this Area", so a missing membership row made
  // it miss and mint a SECOND helper for the same Area — liveone-dev accumulated exactly that (two
  // `Craig Unified · derived`, two `Daylesford · derived`, cleaned up 2026-08-04). Membership is now a
  // column on the row being deduped, so there is no second row to be missing.
  const existing = await db
    .select({ rid: devices.rid })
    .from(devices)
    .where(and(eq(devices.areaId, areaId), eq(devices.vendor, "helper")))
    .orderBy(asc(devices.rid))
    .limit(1);
  if (existing.length > 0) return existing[0].rid;

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
