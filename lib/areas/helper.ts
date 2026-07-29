/**
 * Helper devices — derived, non-physical, never-polled `systems` rows (vendor_type='helper') that live
 * in an Area and own the Area's COMPUTED points (the battery-provenance blend is the first tenant). A
 * helper is a MEMBER of exactly one Area; it is owned by the Area's owner (private household-derived data,
 * NOT ownerless).
 */
import { and, asc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaMembers, areas, devices } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { ensureDeviceRow } from "@/lib/registry/v4-mirror";
import { Device } from "@/lib/ids";
import { helperSiteId } from "./helper-site-id";
import { ensureAreaMember } from "./members";

const HELPER_MEMBER_ORDINAL = 99; // sorts after the real member devices

/**
 * Ensure the Area's helper device exists and is a member, returning its `systems.id`. Idempotent:
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

  // Membership is uuid-keyed since slice H, so this reads `devices` rather than `systems`, and returns
  // `devices.rid` — the same integer by the `devices.rid == systems.id` seam invariant. `devices.vendor`
  // mirrors `systems.vendor_type` and has been self-healing since slice A2.
  const existing = await db
    .select({ rid: devices.rid })
    .from(devices)
    .innerJoin(areaMembers, eq(areaMembers.deviceId, devices.id))
    .where(and(eq(areaMembers.areaId, areaId), eq(devices.vendor, "helper")))
    .orderBy(asc(devices.rid))
    .limit(1);
  if (existing.length > 0) return existing[0].rid;

  const helper = await SystemsManager.getInstance().createHelperDevice({
    ownerClerkUserId: area.owner,
    vendorSiteId: helperSiteId(areaId),
    displayName: `${area.displayName ?? "Area"} · derived`,
    timezoneOffsetMin: area.tzOff,
    displayTimezone: area.tz,
  });
  // `createHelperDevice` already mints the `devices` row via the mirror; this re-asserts it so the
  // membership FK cannot fail on a mirror hiccup (idempotent, and self-healing since slice A2).
  const helperDeviceId = Device.encode(await ensureDeviceRow(helper.id));
  await ensureAreaMember(db, areaId, helperDeviceId, HELPER_MEMBER_ORDINAL);
  return helper.id;
}
