/**
 * Shared read helpers over the `areas` / `area_bindings` tables — the authoritative role→point reads
 * for a MULTI-DEVICE Area (one that aggregates several devices' points into typed roles). A multi-device
 * Area is located by its integer addressing handle, so every caller stays keyed on the same id; only
 * multi-device Areas have bindings, so an identity handle resolves to zero rows.
 *
 * config-v4 Phase 13 PR 5: the handle is read from `legacy_handles`, not the dropped
 * `areas.legacy_system_id` — see `lib/areas/resolve.ts` for why that map is authoritative.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaBindings,
  devices,
  legacyHandles,
  points,
} from "@/lib/db/planetscale/schema";
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
 * The point refs bound to the multi-device Area the integer `handle` names, ordered by
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
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    // Located by the addressing handle alone — no `kind` filter. Only multi-device Areas have bindings,
    // so an identity handle resolves to zero rows here regardless.
    .where(eq(legacyHandles.handle, handle))
    .orderBy(areaBindings.ordinal);
  return rows;
}

/** A flat row for rebuilding the KV subscription registry from SQL. */
export interface AreaBindingRow {
  handle: number; // legacy_handles.handle
  /** The SOURCE point's owning device handle (`devices.rid`) — the `subscriptions:system:N` KV key. */
  sourceSystemId: number;
  /** The bound point's uuid — the subscription map's inner key since slice E PR 2b. */
  pointUid: string;
  ordinal: number;
}

/**
 * Every multi-device Area's bindings, flattened with the Area's integer addressing handle. Drives
 * `buildSubscriptionRegistry` — the reverse `point_uid → subscriber` index, in SQL. Migration 0048
 * removed `area_bindings`' own `(point_system_id, point_id)`, so the source system id is recovered by
 * hopping `points.device_id → devices.rid` — the `devices.rid == systems.id` seam invariant (verified
 * 72/72 agreeing with `point_info.system_id` on dev).
 *
 * NOT via `point_info`, deliberately, for two reasons. (a) Lifetime: slice N drops `point_info` BEFORE
 * Phase 13 retires the integer KV keyspace, so a `point_info` join would leave this query with no
 * backing table across the terminal window; `points`/`devices` survive slice N and `rid` dies naturally
 * with the keyspace. (b) Safety: both hops here are FK-backed (`area_bindings.point_uid → points.id`,
 * which survived 0047, and `points.device_id → devices.id`, NOT NULL), so neither inner join can drop a
 * binding — whereas `point_uid` has NO FK into `point_info`, which would have made that join a silent
 * filter on a missing row and quietly cost the area its subscription edge.
 *
 * Ordered so the per-Area enumeration is deterministic.
 */
export async function getAreaBindings(): Promise<AreaBindingRow[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      handle: legacyHandles.handle,
      sourceSystemId: devices.rid,
      pointUid: areaBindings.pointUid,
      ordinal: areaBindings.ordinal,
    })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    // LEFT, not inner: the projected `handle` was nullable and the `.filter` below is what enforces
    // presence, so an area missing a handle row must reach that filter rather than silently vanish
    // here. `legacy_handles.area_id` is uniquely indexed, so this adds at most one row per area.
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .innerJoin(points, eq(points.id, areaBindings.pointUid))
    .innerJoin(devices, eq(devices.id, points.deviceId))
    // The first innerJoin already restricts to Areas that HAVE bindings — exactly the multi-device
    // areas; an area-of-one contributes none.
    .orderBy(legacyHandles.handle, areaBindings.ordinal);
  // `legacy_handles.area_id` is nullable, but a handle-addressed Area always has its row.
  return rows.filter((r): r is AreaBindingRow => r.handle !== null);
}
