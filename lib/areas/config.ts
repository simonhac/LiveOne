import { eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import type { BatteryProvenanceConfig } from "@/lib/capabilities/config";
import type { AreaConfig } from "./types";

/**
 * Pre-cutover compatibility write: when the selected battery device's legacy settings are saved,
 * mirror the site-level provenance settings into every Area that resolves that device as its battery
 * producer. Other AreaConfig keys are preserved.
 *
 * ⚠️ HAND-WRITTEN `sql` — `tsc` cannot see into it, and its failure mode is silent under-resolution
 * (zero areas updated, no error). Config-v4 Phase 12 slice E PR 2a re-points the device test from
 * `ab.point_system_id` to the binding's `point_uid`, hopping `points.device_id → devices.rid` (the
 * seam invariant `devices.rid == systems.id`, lib/registry/v4-mirror.ts). Exercised against a live
 * database, not merely compiled — see the slice-E block in the config-v4 epic record.
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
          AND EXISTS (
            SELECT 1 FROM points p
            JOIN devices d ON d.id = p.device_id
            WHERE p.id = ab.point_uid AND d.rid = ${systemId}
          )
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
