/**
 * Reads and writes over the `area_members` membership table — an Area is an explicit grouping of 1..N
 * member devices, and Phase C's resolver consumes that membership to default each member's own points
 * (with `area_bindings` as an override), so there is no single-vs-multi special-case.
 *
 * Config-v4 Phase 12 slice H moved this off `area_devices` (`(area_id, system_id int)`, no FK) onto
 * `area_members` (`(area_id, device_id uuid)` → `devices.id`). Membership is now stated in device uuids:
 * `getAreaMemberDeviceIds` returns `dv_` TypeIDs, and callers that still join int-keyed columns convert
 * explicitly through `DeviceRegistry.ridsForDevices`. There is deliberately NO handle-returning variant
 * here — the conversion is meant to be visible at each site, because Phase 13 deletes them all when
 * `point_info.system_id` / `systems.id` move to uuid. (`area_bindings`' own int pair is already gone —
 * slice E PR 2b / migration 0048.)
 *
 * The `sql` fragments below are invisible to `tsc`; `__tests__/members.test.ts` asserts their rendered
 * SQL so a stale table or column name fails CI rather than at runtime.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaMembers,
  areas,
  devices,
  pointInfo,
} from "@/lib/db/planetscale/schema";
import { Device, type DeviceId } from "@/lib/ids";

type Db = ReturnType<typeof requirePlanetscaleDb>;

/**
 * The member device ids of an Area, ordered by `ordinal` then `devices.rid`. Empty if none.
 *
 * The tiebreak is `rid`, NOT `device_id`: uuid order is not int order, so ordering by the uuid would
 * silently reshuffle members that share an ordinal. Ordering by `rid` keeps member order byte-identical
 * to the `area_devices` era.
 */
export async function getAreaMemberDeviceIds(
  areaId: string,
): Promise<DeviceId[]> {
  const rows = await requirePlanetscaleDb()
    .select({ deviceId: areaMembers.deviceId })
    .from(areaMembers)
    .innerJoin(devices, eq(devices.id, areaMembers.deviceId))
    .where(eq(areaMembers.areaId, areaId))
    .orderBy(asc(areaMembers.ordinal), asc(devices.rid));
  return rows.map((r) => Device.encode(r.deviceId));
}

/**
 * Add a device as an Area member. Idempotent (PK conflict -> no-op).
 *
 * The caller must have ensured the `devices` row exists — `area_members.device_id` is a hard FK, unlike
 * the old `area_devices.system_id`. `ensureDeviceRow` (lib/registry/v4-mirror.ts) is what guarantees it.
 */
export async function ensureAreaMember(
  db: Db,
  areaId: string,
  deviceId: DeviceId,
  ordinal = 0,
): Promise<void> {
  await db
    .insert(areaMembers)
    .values({ areaId, deviceId: Device.toUuid(deviceId), ordinal })
    .onConflictDoNothing();
}

/**
 * Handles of active explicit Areas that are eligible to own an energy-flow matrix (a Sankey). Flow is an
 * Area-only concept: a raw device never gets its own matrix. Config-v4 keeps the implied areas-of-one
 * (decision "Option A" — deleting them would destroy their uuid-keyed flow/provenance history), so this
 * enumerates `areas` directly and keeps the
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
        // Not a member device of a different active area. `devices.rid` IS the member's integer handle
        // (the `devices.rid == systems.id` seam invariant, lib/registry/v4-mirror.ts).
        sql`NOT EXISTS (
          SELECT 1 FROM area_members am
          JOIN devices d ON d.id = am.device_id
          JOIN areas parent ON parent.id = am.area_id
          WHERE d.rid = ${areas.legacySystemId}
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
 * member device's `point_info` point, as `(handle, sourceSystemId, pointUid)`. Multi-device areas WITH
 * bindings are covered by `getAllCompositeBindings` instead, so this is empty for today's data (both
 * prod multi-device areas have bindings) — it only lights up when a binding-less multi-device area
 * appears. SQL-only (no resolver dependency) so the KV registry can consume it without an import cycle.
 *
 * Still emits integer handles: the subscriber ref grammar stays `{systemId}.{pointIndex}` until
 * Phase 13, and `sourceSystemId` remains the `subscriptions:system:N` KV key. The map's SOURCE-point
 * key moved to `point_uid` in slice E PR 2b. (Slice M retired the same grammar on the OBSERVATIONS
 * wire; the KV subscriber grammar is a separate keyspace and is untouched.)
 */
export async function getBindinglessAreaMemberPoints(): Promise<
  { handle: number; sourceSystemId: number; pointUid: string }[]
> {
  const rows = await requirePlanetscaleDb()
    .select({
      handle: areas.legacySystemId,
      sourceSystemId: pointInfo.systemId,
      pointUid: pointInfo.pointUid,
    })
    .from(areas)
    .innerJoin(areaMembers, eq(areaMembers.areaId, areas.id))
    .innerJoin(devices, eq(devices.id, areaMembers.deviceId))
    .innerJoin(pointInfo, eq(pointInfo.systemId, devices.rid))
    .where(
      and(
        isNotNull(areas.legacySystemId),
        // areas-backed: the handle names no DEVICE of its own. config-v4 slice K3: was
        // `NOT EXISTS (SELECT 1 FROM systems s WHERE s.id = …)` — an open-coded `isAreaHandle` that
        // `tsc` could not see, so it survived K2's sweep. `devices.rid` IS the device's integer handle
        // (the `devices.rid == systems.id` seam invariant, lib/registry/v4-mirror.ts), so this is the
        // same predicate against the surviving table.
        sql`NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = ${areas.legacySystemId})`,
        // binding-less: no area_bindings (those are covered by getAllCompositeBindings)
        sql`NOT EXISTS (SELECT 1 FROM area_bindings ab WHERE ab.area_id = ${areas.id})`,
      ),
    )
    .orderBy(areas.legacySystemId, pointInfo.systemId, pointInfo.index);
  return rows
    .filter((r): r is typeof r & { handle: number } => r.handle != null)
    .map((r) => ({
      handle: r.handle,
      sourceSystemId: r.sourceSystemId,
      pointUid: r.pointUid,
    }));
}
