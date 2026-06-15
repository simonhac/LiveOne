/**
 * Resolve the Area that represents a logical system (P3). The identity counterpart to the
 * composite-only reads in `lib/areas/bindings.ts`.
 *
 * Every physical system has a 1:1 `kind='identity'` Area and every composite has a
 * `kind='composite'` Area, BOTH located by `legacy_system_id == systemId` (the 1:1 migration seam,
 * which carries a UNIQUE index). So a single lookup keyed on `legacy_system_id` answers "which Area
 * is this system's view" for either kind. For a composite, `legacy_system_id` is the integer handle
 * of its areas-backed virtual system (the `systems` row was deleted in migration 0014).
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";

export interface ResolvedArea {
  id: string;
  kind: "identity" | "composite";
}

/**
 * The Area whose `legacy_system_id == systemId` (identity for a physical system, composite for a
 * composite virtual system), or null when no such Area exists.
 */
export async function getAreaForSystem(
  systemId: number,
): Promise<ResolvedArea | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ id: areas.id, kind: areas.kind })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  if (!row) return null;
  return { id: row.id, kind: row.kind as "identity" | "composite" };
}
