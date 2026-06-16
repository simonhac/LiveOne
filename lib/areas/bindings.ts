/**
 * Shared read helpers over the P3 `areas` / `area_bindings` tables.
 *
 * These are the authoritative composite role→point reads (they replaced the legacy
 * `systems.metadata` parsing). A composite Area is located by its `legacy_system_id` (== the
 * composite's integer handle, formerly its `systems.id`), so every caller stays keyed on the same
 * id — now resolving to the areas-backed virtual system after the `systems` row was deleted (0014).
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { and, eq } from "drizzle-orm";

/** A composite Area's binding point refs, ordered by ordinal — the set the v2 mappings encoded. */
export interface BindingRef {
  pointSystemId: number;
  pointId: number;
  role: string;
  metricType: string;
  ordinal: number;
}

/**
 * The (point_system_id, point_id) refs bound to the composite Area whose `legacy_system_id` is
 * `systemId`, ordered by ordinal. Empty if no such Area (e.g. not yet backfilled). This is the
 * typed-table replacement for parsing `metadata.mappings`; consumed by the areas-backed branch of
 * `PointManager._resolvePointsForViewable`.
 */
export async function getCompositeBindingRefs(
  systemId: number,
): Promise<BindingRef[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      pointSystemId: areaBindings.pointSystemId,
      pointId: areaBindings.pointId,
      role: areaBindings.role,
      metricType: areaBindings.metricType,
      ordinal: areaBindings.ordinal,
    })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .where(and(eq(areas.legacySystemId, systemId), eq(areas.kind, "composite")))
    .orderBy(areaBindings.ordinal);
  return rows;
}

/** A flat row for rebuilding the KV subscription registry from SQL. */
export interface CompositeBindingRow {
  compositeSystemId: number; // areas.legacy_system_id
  pointSystemId: number;
  pointId: number;
  ordinal: number;
}

/**
 * All composite Areas' bindings, flattened with the composite's `legacy_system_id`. Drives
 * `buildSubscriptionRegistry` — the reverse `(point_system_id, point_id) → composite` index, in
 * SQL. Ordered so the per-composite enumeration is deterministic.
 */
export async function getAllCompositeBindings(): Promise<
  CompositeBindingRow[]
> {
  const rows = await requirePlanetscaleDb()
    .select({
      compositeSystemId: areas.legacySystemId,
      pointSystemId: areaBindings.pointSystemId,
      pointId: areaBindings.pointId,
      ordinal: areaBindings.ordinal,
    })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .where(eq(areas.kind, "composite"))
    .orderBy(areas.legacySystemId, areaBindings.ordinal);
  // legacySystemId is nullable in the schema but always set for composite Areas.
  return rows.filter(
    (r): r is CompositeBindingRow => r.compositeSystemId !== null,
  );
}
