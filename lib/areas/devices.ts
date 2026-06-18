/**
 * Reads over the `area_devices` membership table (the unified 1..N model, Phase B).
 *
 * An Area is a grouping of 1..N member devices. This is the explicit, unified membership: an
 * area-of-one has one member (its source system); a multi-device area's members are the distinct child
 * systems of its bindings. Phase C's resolver consumes this to default each member's own points (with
 * `area_bindings` as an override), so there is no single-vs-multi special-case.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaDevices, areas, pointInfo } from "@/lib/db/planetscale/schema";

/** The member device systemIds of an Area, ordered by `ordinal` then systemId. Empty if none. */
export async function getAreaDeviceSystemIds(
  areaId: string,
): Promise<number[]> {
  const rows = await requirePlanetscaleDb()
    .select({ systemId: areaDevices.systemId })
    .from(areaDevices)
    .where(eq(areaDevices.areaId, areaId))
    .orderBy(asc(areaDevices.ordinal), asc(areaDevices.systemId));
  return rows.map((r) => r.systemId);
}

/**
 * The member-device points to fan out for **binding-less** areas-backed handles — i.e. multi-device
 * areas that resolve under union-default (no `area_bindings` to select). For each such handle, every
 * member device's `point_info` point, as `(handle, pointSystemId, pointId)`. Multi-device areas WITH
 * bindings are covered by `getAllCompositeBindings` instead, so this is empty for today's data (both
 * prod multi-device areas have bindings) — it only lights up when a binding-less multi-device area
 * appears. SQL-only (no resolver dependency) so the KV registry can consume it without an import cycle.
 */
export async function getBindinglessAreaMemberPoints(): Promise<
  { handle: number; pointSystemId: number; pointId: number }[]
> {
  const rows = await requirePlanetscaleDb()
    .select({
      handle: areas.legacySystemId,
      pointSystemId: pointInfo.systemId,
      pointId: pointInfo.index,
    })
    .from(areas)
    .innerJoin(areaDevices, eq(areaDevices.areaId, areas.id))
    .innerJoin(pointInfo, eq(pointInfo.systemId, areaDevices.systemId))
    .where(
      and(
        isNotNull(areas.legacySystemId),
        // areas-backed: the handle has no real systems row
        sql`NOT EXISTS (SELECT 1 FROM systems s WHERE s.id = ${areas.legacySystemId})`,
        // binding-less: no area_bindings (those are covered by getAllCompositeBindings)
        sql`NOT EXISTS (SELECT 1 FROM area_bindings ab WHERE ab.area_id = ${areas.id})`,
      ),
    )
    .orderBy(areas.legacySystemId, pointInfo.systemId, pointInfo.index);
  return rows
    .filter((r): r is typeof r & { handle: number } => r.handle != null)
    .map((r) => ({
      handle: r.handle,
      pointSystemId: r.pointSystemId,
      pointId: r.pointId,
    }));
}
