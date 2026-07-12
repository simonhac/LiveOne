/**
 * Helper devices — derived, non-physical, never-polled `systems` rows (vendor_type='helper') that live
 * in an Area and own the Area's COMPUTED points (the battery-provenance blend is the first tenant). A
 * helper is a MEMBER of exactly one Area; it is owned by the Area's owner (private household-derived data,
 * NOT ownerless). Analogous to `ensureAreaOfOne` (lib/areas/sync.ts) but for a member, not an area-of-one.
 */
import { and, asc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaDevices, areas, systems } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { ensureMember } from "./sync";

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
      displayName: areas.displayName,
      owner: areas.ownerClerkUserId,
      tzOff: areas.timezoneOffsetMin,
      tz: areas.displayTimezone,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  if (!area) throw new Error(`ensureHelperDevice: no area ${areaId}`);

  const existing = await db
    .select({ id: systems.id })
    .from(systems)
    .innerJoin(areaDevices, eq(areaDevices.systemId, systems.id))
    .where(
      and(eq(areaDevices.areaId, areaId), eq(systems.vendorType, "helper")),
    )
    .orderBy(asc(systems.id))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const helper = await SystemsManager.getInstance().createHelperDevice({
    ownerClerkUserId: area.owner,
    vendorSiteId: `helper:area:${areaId}`,
    displayName: `${area.displayName ?? "Area"} · derived`,
    timezoneOffsetMin: area.tzOff,
    displayTimezone: area.tz,
  });
  await ensureMember(db, areaId, helper.id, HELPER_MEMBER_ORDINAL);
  return helper.id;
}
