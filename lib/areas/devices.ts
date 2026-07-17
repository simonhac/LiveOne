/**
 * Reads over the `area_devices` membership table (the unified 1..N model, Phase B).
 *
 * An Area is an explicit grouping of 1..N member devices. Phase C's resolver consumes this membership to
 * default each member's own points (with
 * `area_bindings` as an override), so there is no single-vs-multi special-case.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaDevices, areas, pointInfo } from "@/lib/db/planetscale/schema";

type Db = ReturnType<typeof requirePlanetscaleDb>;

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

/** Add a system as an Area member. Idempotent (PK conflict -> no-op). */
export async function ensureAreaMember(
  db: Db,
  areaId: string,
  systemId: number,
  ordinal = 0,
): Promise<void> {
  await db
    .insert(areaDevices)
    .values({ areaId, systemId, ordinal })
    .onConflictDoNothing();
}

/**
 * Handles of active explicit Areas that are eligible to own an energy-flow matrix (a Sankey). Flow is an
 * Area-only concept: a raw device never gets its own matrix. The legacy implied area rows are retired by
 * `scripts/cleanup/retire-implied-areas.ts`, so this enumerates `areas` directly and only keeps the
 * duplicate-prevention guard: if an area's integer handle is itself a member device of another active
 * Area, the parent Area owns the flow view. The caller maps these through `resolveLogicalSystem` +
 * `isComplete`, so an Area that lacks a source/load role set still drops out. SQL-only (no resolver import).
 */
export async function listFlowEligibleAreaHandles(): Promise<number[]> {
  const rows = await requirePlanetscaleDb()
    .select({ handle: areas.legacySystemId })
    .from(areas)
    .where(
      and(
        eq(areas.status, "active"),
        isNotNull(areas.legacySystemId),
        // Not a member device of a different active area.
        sql`NOT EXISTS (
          SELECT 1 FROM area_devices ad
          JOIN areas parent ON parent.id = ad.area_id
          WHERE ad.system_id = ${areas.legacySystemId}
            AND parent.legacy_system_id <> ${areas.legacySystemId}
            AND parent.status = 'active'
        )`,
      ),
    )
    .orderBy(areas.legacySystemId);
  return rows.map((r) => r.handle).filter((h): h is number => h != null);
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
