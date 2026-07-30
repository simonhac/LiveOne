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
import { and, asc, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaMembers,
  areas,
  devices,
  legacyHandles,
  points,
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
    .select({ handle: legacyHandles.handle })
    .from(areas)
    // config-v4 Phase 13 PR 5: the handle comes from `legacy_handles`, not the dropped
    // `areas.legacy_system_id`. INNER, so it subsumes the `isNotNull(areas.legacySystemId)` this
    // replaces — "has a handle" is now expressed by the join, and leaving a redundant null check
    // behind would imply the projection could still be null when the join guarantees it cannot.
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(
      and(
        eq(areas.status, "active"),
        // Not a member device of a different active area. `devices.rid` IS the member's integer handle
        // (the `devices.rid == systems.id` seam invariant, lib/registry/v4-mirror.ts).
        //
        // ⚠️ Raw `sql`, so `tsc` cannot see either handle reference. The PARENT's handle needs its own
        // `legacy_handles` hop (`plh`); an INNER join there preserves the old NULL semantics exactly —
        // `parent.legacy_system_id <> X` was NULL, hence not-EXISTS-satisfying, for a parent with no
        // handle, and a missing `plh` row drops that parent from the subquery the same way.
        sql`NOT EXISTS (
          SELECT 1 FROM area_members am
          JOIN devices d ON d.id = am.device_id
          JOIN areas parent ON parent.id = am.area_id
          JOIN legacy_handles plh ON plh.area_id = parent.id
          WHERE d.rid = ${legacyHandles.handle}
            AND plh.handle <> ${legacyHandles.handle}
            AND parent.status = 'active'
        )`,
      ),
    )
    .orderBy(legacyHandles.handle);
  return rows.map((r) => r.handle).filter((h): h is number => h != null);
}

/**
 * The member-device points to fan out for **binding-less** areas-backed handles — i.e. multi-device
 * areas that resolve under union-default (no `area_bindings` to select). For each such area, every
 * member device's `points` point, as `(areaId, sourceDeviceId, pointUid)`. Multi-device areas WITH
 * bindings are covered by `getAreaBindings` instead, so this is empty for today's data (both
 * prod multi-device areas have bindings) — it only lights up when a binding-less multi-device area
 * appears. SQL-only (no resolver dependency) so the KV registry can consume it without an import cycle.
 *
 * config-v4 Phase 13 PR 3: both ids are now uuids — the KV subscriber key is the Area's own `ar_` TypeID
 * (`latest:area:{ar_…}`) and the source key is the device's `dv_` TypeID
 * (`subscriptions:device:{dv_…}`), so the vestigial `{handle}.{ordinal}` ref grammar is gone with them.
 * The map's SOURCE-point key moved to `point_uid` in slice E PR 2b. The `legacy_handles` join REMAINS,
 * but only for the areas-backed predicate below — nothing is projected from it.
 */
export async function getBindinglessAreaMemberPoints(): Promise<
  { areaId: string; sourceDeviceId: string; pointUid: string }[]
> {
  const rows = await requirePlanetscaleDb()
    .select({
      areaId: areas.id,
      sourceDeviceId: devices.id,
      pointUid: points.id,
    })
    .from(areas)
    // config-v4 Phase 13 PR 5: handle from `legacy_handles`, not the dropped column. INNER, so it
    // subsumes the `isNotNull(areas.legacySystemId)` that used to sit in the `where` below.
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .innerJoin(areaMembers, eq(areaMembers.areaId, areas.id))
    .innerJoin(devices, eq(devices.id, areaMembers.deviceId))
    // slice 1b: was `point_info.system_id = devices.rid` — a join through the integer handle. The
    // points-primary equivalent is the real FK, `points.device_id = devices.id`.
    .innerJoin(points, eq(points.deviceId, devices.id))
    .where(
      and(
        // areas-backed: the handle names no DEVICE of its own. config-v4 slice K3: was
        // `NOT EXISTS (SELECT 1 FROM systems s WHERE s.id = …)` — an open-coded `isAreaHandle` that
        // `tsc` could not see, so it survived K2's sweep. `devices.rid` IS the device's integer handle
        // (the `devices.rid == systems.id` seam invariant, lib/registry/v4-mirror.ts), so this is the
        // same predicate against the surviving table.
        //
        // 🛑 **This is the SQL twin of the device-first dispatch in `PointManager`'s
        // `_resolvePointsForHandle`, and it DELIBERATELY survives Phase 13 PR 2's deletion of
        // `isAreaHandle`.** It is not a stray: this is a set-based sweep over every area at once, so it
        // cannot call the per-handle memoized reader the TypeScript side uses without N+1 round trips.
        // The two must stay in step — `NOT EXISTS (device with this rid)` here is exactly
        // "`deviceByHandle` returned null" there. If one flips to area-first, so must the other, or the
        // KV subscription registry will fan out points for a colliding handle that the serving path
        // resolves device-first (trap D-l).
        //
        // PR 3 did NOT relax this even though the KV keyspace split gives an Area its own
        // `latest:area:{ar_…}` hash. The reason is that a READ by integer handle unions both legs
        // (`lib/kv-subjects.ts`), so fanning out here for a colliding or identity handle would still
        // widen what that handle serves. The coupling moved; it did not go away. `tsc` cannot see this coupling; only this comment can.
        //
        // The probed value is PR 5's `legacy_handles.handle`, not the dropped `areas.legacy_system_id`
        // — same integer handle, read from the table that survives Phase 13.
        sql`NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = ${legacyHandles.handle})`,
        // binding-less: no area_bindings (those are covered by getAllCompositeBindings)
        sql`NOT EXISTS (SELECT 1 FROM area_bindings ab WHERE ab.area_id = ${areas.id})`,
      ),
    )
    .orderBy(areas.id, devices.rid, points.rid);
  return rows;
}
