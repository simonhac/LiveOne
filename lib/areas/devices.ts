/**
 * Reads over the `area_devices` membership table (composite retirement, Phase B).
 *
 * An Area is a grouping of 1..N member devices. This is the explicit, unified membership: an identity
 * Area has one member (its source system); a composite Area's members are the distinct child systems of
 * its bindings. Phase C's resolver consumes this to default each member's own points (with
 * `area_bindings` as an override), replacing the composite special-case.
 */
import { asc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaDevices } from "@/lib/db/planetscale/schema";

/** The member device systemIds of an Area, ordered by `ordinal` then systemId. Empty if none. */
export async function getAreaDeviceSystemIds(
  areaId: string,
): Promise<number[]> {
  const rows = await requirePlanetscaleDb()
    .select({ systemId: areaDevices.systemId })
    .from(areaDevices)
    .where(eq(areaDevices.areaId, areaId))
    .orderBy(asc(areaDevices.ordinal), asc(areaDevices.systemId));
  return rows.map((r) => r.systemId);
}
