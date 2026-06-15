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
import type { RoleId } from "@/lib/roles/registry";

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
 * typed-table replacement for parsing `metadata.mappings` in
 * `PointManager._resolveCompositeSystemPoints`.
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

/**
 * Per-metric source SYSTEM for a composite, derived from its bindings — the typed-table replacement
 * for `CompositeAdapter.getSourceForMetric` (override ?? base_system). A metric with no binding maps
 * to null, exactly as the adapter yields null when a source is absent.
 */
export interface LiveSourceSystems {
  solar: number | null;
  battery: number | null;
  battery_soc: number | null;
  load: number | null;
  grid: number | null;
}

export async function deriveLiveSourceSystems(
  systemId: number,
): Promise<LiveSourceSystems> {
  const refs = await getCompositeBindingRefs(systemId);
  const systemOf = (role: RoleId, metricType: string): number | null =>
    refs.find((r) => r.role === role && r.metricType === metricType)
      ?.pointSystemId ?? null;
  return {
    solar: systemOf("solar", "power"),
    battery: systemOf("battery", "power"),
    battery_soc: systemOf("battery", "soc"),
    load: systemOf("load", "power"),
    grid: systemOf("grid", "power"),
  };
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
 * `buildSubscriptionRegistry` when `AREAS_TABLE` is on — the reverse `(point_system_id, point_id) →
 * composite` index, in SQL. Ordered so the per-composite enumeration is deterministic.
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
