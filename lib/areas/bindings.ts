/**
 * Shared read helpers over the `areas` / `area_bindings` tables — the authoritative role→point reads
 * for a MULTI-DEVICE Area (one that aggregates several devices' points into typed roles). A multi-device
 * Area is located by its `legacy_system_id` (its integer addressing handle), so every caller stays keyed
 * on the same id; only multi-device Areas have bindings, so an identity handle resolves to zero rows.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings, pointInfo } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";

/** An Area's binding point refs, ordered by ordinal. */
export interface BindingRef {
  /** The bound point's uuid — `area_bindings.point_uid`, NOT NULL since migration 0047. */
  pointUid: string;
  role: string;
  metricType: string;
  ordinal: number;
}

/**
 * The point refs bound to the multi-device Area whose `legacy_system_id` is `handle`, ordered by
 * ordinal. Empty if no such Area / no bindings. Consumed by the area-native branch of
 * `PointManager._resolvePointsForViewable`.
 */
export async function getAreaBindingRefs(
  handle: number,
): Promise<BindingRef[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      pointUid: areaBindings.pointUid,
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
  /** The SOURCE point's owning `point_info.system_id` — still the `subscriptions:system:N` KV key. */
  sourceSystemId: number;
  /** The bound point's uuid — the subscription map's inner key since slice E PR 2b. */
  pointUid: string;
  ordinal: number;
}

/**
 * Every multi-device Area's bindings, flattened with the Area's `legacy_system_id` (its handle). Drives
 * `buildSubscriptionRegistry` — the reverse `point_uid → subscriber` index, in SQL. The source system
 * id comes from `point_info` (joined on `point_uid`), not from a column on `area_bindings`: the int
 * pair is gone as of migration 0048. Ordered so the per-Area enumeration is deterministic.
 */
export async function getAreaBindings(): Promise<AreaBindingRow[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      handle: areas.legacySystemId,
      sourceSystemId: pointInfo.systemId,
      pointUid: areaBindings.pointUid,
      ordinal: areaBindings.ordinal,
    })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    // `point_uid` has no FK into `point_info` (0047 dropped it), so this join is also the liveness
    // filter: a binding whose point has been deleted contributes no subscription edge.
    .innerJoin(pointInfo, eq(pointInfo.pointUid, areaBindings.pointUid))
    // The first innerJoin already restricts to Areas that HAVE bindings — exactly the multi-device
    // areas; an area-of-one contributes none.
    .orderBy(areas.legacySystemId, areaBindings.ordinal);
  // legacySystemId is nullable in the schema but always set for a handle-addressed Area.
  return rows.filter((r): r is AreaBindingRow => r.handle !== null);
}
