/**
 * Helper devices — derived, non-physical, never-polled `devices` rows (vendor='helper') that live
 * in an Area and own the Area's COMPUTED points (the battery-provenance blend is the first tenant). A
 * helper is a MEMBER of exactly one Area; it is owned by the Area's owner (private household-derived data,
 * NOT ownerless).
 *
 * "Exactly one Area" is structural since migration 0071 — `devices.area_id`, one nullable column —
 * rather than a convention over `area_members` rows. That is what makes the dedupe below reliable.
 */
import { and, asc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, devices } from "@/lib/db/planetscale/schema";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { helperSiteId } from "./helper-site-id";
import { setDeviceArea } from "./members";

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
      tz: areas.displayTimezone,
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
    vendorSiteId: helperSiteId(areaId),
    displayName: `${area.displayName ?? "Area"} · derived`,
    timezoneOffsetMin: area.tzOff,
    displayTimezone: area.tz,
  });
  // The uuid comes straight off the create (slice 1a): `createHelperDevice` INSERTS the `devices` row
  // rather than mirroring one, so it already knows the identity and hands it back. This used to
  // re-derive it via `ensureDeviceRow(helper.id)` to "re-assert the row in case the mirror hiccupped" — a
  // hedge that only meant something while the row was a COPY of a `systems` row written by someone else.
  // There is no second writer to lose a race with now, so the extra round trip goes with it.
  //
  // 🛑 This MOVES the helper out of the area-of-one its create just minted and into the Area it
  // serves — and it is the write the dedupe above reads. Between the resolver flip (which pointed the
  // dedupe at `devices.area_id`) and this line, the two disagreed: the dedupe asked a column no writer
  // set, so it missed every time and this function minted a FRESH helper on every call. That is the
  // duplicate-helper bug (two `Craig Unified · derived` on dev) in its unbounded form — nothing caps
  // it — and it is now structurally impossible, because membership IS a column on the row being
  // deduped.
  const helperDeviceId = helper.deviceId;
  await setDeviceArea(db, helperDeviceId, areaId);
  return helper.id;
}
