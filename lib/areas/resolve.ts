/**
 * Resolve the Area that represents a logical system (P3). The identity counterpart to the
 * composite-only reads in `lib/areas/bindings.ts`.
 *
 * Every physical system has a 1:1 `kind='identity'` Area and every composite shim row has a
 * `kind='composite'` Area, BOTH located by `legacy_system_id == systemId` (the 1:1 migration seam,
 * which carries a UNIQUE index). So a single lookup keyed on `legacy_system_id` answers "which Area
 * is this system's view" for either kind.
 *
 * Gated by `AREAS_TABLE`: off → returns null so callers fall back to the legacy `system_id` path;
 * on-but-not-yet-backfilled → also null (degrades gracefully before the P3 backfill runs).
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { AREAS_TABLE } from "@/lib/areas/flags";

export interface ResolvedArea {
  id: string;
  kind: "identity" | "composite";
}

/**
 * The Area whose `legacy_system_id == systemId` (identity for a physical system, composite for a
 * composite shim), or null when `AREAS_TABLE` is off or no such Area has been backfilled yet.
 */
export async function getAreaForSystem(
  systemId: number,
): Promise<ResolvedArea | null> {
  if (!AREAS_TABLE) return null;
  const [row] = await requirePlanetscaleDb()
    .select({ id: areas.id, kind: areas.kind })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  if (!row) return null;
  return { id: row.id, kind: row.kind as "identity" | "composite" };
}
