/**
 * Shared read helpers over the `areas` / `area_bindings` tables — the authoritative role→point reads
 * for a MULTI-DEVICE Area (one that aggregates several devices' points into typed roles). A multi-device
 * Area is located by its `legacy_system_id` (its integer addressing handle), so every caller stays keyed
 * on the same id; only multi-device Areas have bindings, so an identity handle resolves to zero rows.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";

/** An Area's binding point refs, ordered by ordinal. */
export interface BindingRef {
  pointSystemId: number;
  pointId: number;
  role: string;
  metricType: string;
  ordinal: number;
}

/**
 * The (point_system_id, point_id) refs bound to the multi-device Area whose `legacy_system_id` is
 * `handle`, ordered by ordinal. Empty if no such Area / no bindings. Consumed by the area-native branch
 * of `PointManager._resolvePointsForViewable`.
 */
export async function getAreaBindingRefs(
  handle: number,
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
    // Located by the addressing handle alone — no `kind` filter. Only multi-device Areas have bindings,
    // so an identity handle resolves to zero rows here regardless.
    .where(eq(areas.legacySystemId, handle))
    .orderBy(areaBindings.ordinal);
  return rows;
}

/** A flat row for rebuilding the KV subscription registry from SQL. */
export interface AreaBindingRow {
  handle: number; // areas.legacy_system_id
  pointSystemId: number;
  pointId: number;
  ordinal: number;
}

/**
 * Every multi-device Area's bindings, flattened with the Area's `legacy_system_id` (its handle). Drives
 * `buildSubscriptionRegistry` — the reverse `(point_system_id, point_id) → subscriber` index, in SQL.
 * Ordered so the per-Area enumeration is deterministic.
 */
export async function getAreaBindings(): Promise<AreaBindingRow[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      handle: areas.legacySystemId,
      pointSystemId: areaBindings.pointSystemId,
      pointId: areaBindings.pointId,
      ordinal: areaBindings.ordinal,
    })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    // The innerJoin already restricts to Areas that HAVE bindings — exactly the multi-device areas;
    // an area-of-one contributes none.
    .orderBy(areas.legacySystemId, areaBindings.ordinal);
  // legacySystemId is nullable in the schema but always set for a handle-addressed Area.
  return rows.filter((r): r is AreaBindingRow => r.handle !== null);
}
