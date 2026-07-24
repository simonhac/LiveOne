import { eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import type { BatteryProvenanceConfig } from "@/lib/capabilities/config";
import type { AreaConfig } from "./types";

/**
 * Pre-cutover compatibility write: when the selected battery device's legacy settings are saved,
 * mirror the site-level provenance settings into every Area that resolves that device as its battery
 * producer. Other AreaConfig keys are preserved.
 */
export async function syncAreaBatteryConfigFromDevice(
  systemId: number,
  batteryProvenance: BatteryProvenanceConfig | undefined,
): Promise<void> {
  const db = requirePlanetscaleDb();
  const rows = await db
    .select({ id: areas.id, config: areas.config })
    .from(areas).where(sql`
      EXISTS (
        SELECT 1 FROM area_bindings ab
        WHERE ab.area_id = ${areas.id}
          AND ab.role = 'battery'
          AND ab.metric_type = 'power'
          AND ab.point_system_id = ${systemId}
          AND NOT EXISTS (
            SELECT 1 FROM area_bindings preferred
            WHERE preferred.area_id = ab.area_id
              AND preferred.role = 'battery'
              AND preferred.metric_type = 'power'
              AND (
                preferred.ordinal < ab.ordinal
                OR (preferred.ordinal = ab.ordinal AND preferred.id < ab.id)
              )
          )
        )
    `);
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const current = row.config ?? {};
      const next: AreaConfig = { ...current };
      if (batteryProvenance) next.batteryProvenance = batteryProvenance;
      else delete next.batteryProvenance;
      await tx
        .update(areas)
        .set({
          config: Object.keys(next).length > 0 ? next : null,
          updatedAt: new Date(),
        })
        .where(eq(areas.id, row.id));
    }
  });
}
