/**
 * Resolve the Area that represents a logical system. An Area is located by its addressing handle
 * (`legacy_system_id == systemId`, a UNIQUE index): a single-device Area wraps one physical system
 * (handle == its `systems.id`); a multi-device Area draws its points across child systems via
 * `area_bindings` (handle has no `systems` row — resolved as an area view in SystemsManager). The
 * single-vs-multi distinction is structural (membership), not a stored `kind`.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";

export interface ResolvedArea {
  id: string;
}

/** The Area whose `legacy_system_id == systemId`, or null when no such Area exists. */
export async function getAreaForSystem(
  systemId: number,
): Promise<ResolvedArea | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ id: areas.id })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  if (!row) return null;
  return { id: row.id };
}

/**
 * The integer addressing handle (`legacy_system_id`) for an Area uuid — the inverse of
 * `getAreaForSystem`. For an identity Area this is the physical `systems.id`; for a composite it is
 * the areas-backed virtual-system handle that `getActivePointsForSystem` resolves to child points.
 * Returns null when the uuid is unknown or the Area carries no handle. Used to map a dashboard's
 * per-card Areas back to the systemIds its share scope authorizes.
 */
export async function getLegacySystemIdForArea(
  areaId: string,
): Promise<number | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ legacySystemId: areas.legacySystemId })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  return row?.legacySystemId ?? null;
}
