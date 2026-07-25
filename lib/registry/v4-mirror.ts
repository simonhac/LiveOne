/**
 * config-v4 forward mirror: keep the v4 registries (`devices`, `points`, `area_members`) in step with
 * every write to the legacy registries (`systems`, `point_info`, `area_devices`).
 *
 * ## Why this exists (guardrail C7)
 *
 * The cutover rewrites the hot tables to be keyed on `points.rid` and gives them
 * `FOREIGN KEY (point_rid) REFERENCES points(rid) NOT VALID`. `NOT VALID` skips validation of EXISTING
 * rows but **still enforces on every new INSERT**. So a point minted after the registry copy — by a
 * poller that never stops — would have a `point_info` row and a `rid`, but no `points` row, and the first
 * reading referencing it would fail the FK. Delivered through QStash that becomes a poison pill, retried
 * forever.
 *
 * Mirroring at mint time makes that race **structurally impossible** rather than patched: there is never a
 * moment where `point_info` has a row that `points` lacks. It ships well before the window so the
 * invariant is already true (and monitored) when the cutover runs.
 *
 * ## Invariants
 *
 * - `points.id   == point_info.point_uid`  (verbatim)
 * - `points.rid  == point_info.rid`        (verbatim — the seam invariant the hot rewrite depends on)
 * - `devices.rid == systems.id`            (verbatim — `?systemId=N` resolves forever)
 *
 * The rid is NEVER re-allocated here: it is read back from the `point_info` write, which owns the
 * `point_rid_seq` default. Allocating a second `nextval` would silently desynchronise the two tables.
 *
 * ## Dark until cutover
 *
 * Nothing reads these tables before the cutover build, so a mirror failure cannot affect serving. It must
 * still be loud, because a silent gap re-opens exactly the race this closes — hence the standing invariant
 * check in `/api/health` and `monitor-observations`.
 */

import { eq, sql } from "drizzle-orm";
import type { AreaLocation } from "@/lib/areas/types";
import { Area } from "@/lib/ids";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaDevices,
  areaMembers,
  points,
  systems,
} from "@/lib/db/planetscale/schema";
import { DeviceRegistry, type DeviceRegistryExec } from "./device-registry";

type Exec = DeviceRegistryExec;

/** The `point_info` shape this mirror needs. Matches the row `ensurePointInfo` gets back from its upsert. */
export interface MirrorPointInput {
  systemId: number;
  pointUid: string;
  rid: number;
  physicalPathTail: string;
  logicalPathStem: string | null;
  metricType: string;
  metricUnit: string;
  displayName: string;
  defaultName: string;
  subsystem: string | null;
  transform: string | null;
  active: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Ensure the area-of-one for a device handle, minting it if absent.
 *
 * `devices.primary_area_id` is tightened to NOT NULL by registry-sync, and v3's `createSystem` does not
 * mint an area (the "explicit areas only" model on `main`), so a system created after registry-sync would
 * otherwise have no area to point at. tz/location are copied up from the device: post-cutover the area is
 * the SOLE home for placement, so this is a move, not a duplicate.
 *
 * @returns the area uuid
 */
async function ensureAreaOfOne(systemId: number, exec: Exec): Promise<string> {
  const [existing] = await exec
    .select({ id: areas.id })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  if (existing) return existing.id;

  const [sys] = await exec
    .select({
      owner: systems.ownerClerkUserId,
      name: systems.displayName,
      tzOffset: systems.timezoneOffsetMin,
      tz: systems.displayTimezone,
      location: systems.location,
    })
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);
  if (!sys) throw new Error(`ensureAreaOfOne: no systems row for ${systemId}`);

  const areaId = Area.toUuid(Area.generate());
  await exec
    .insert(areas)
    .values({
      id: areaId,
      ownerClerkUserId: sys.owner,
      legacySystemId: systemId,
      displayName: sys.name,
      alias: null,
      timezoneOffsetMin: sys.tzOffset,
      displayTimezone: sys.tz,
      dayOffsetMin: sys.tzOffset, // canonical fixed-offset day key == the device's offset
      // `systems.location` is untyped jsonb; `areas.location` is $type<AreaLocation>. Same shape, so
      // this is a declaration-level cast, not a conversion.
      location: sys.location as AreaLocation | null,
      status: "active",
    })
    .onConflictDoNothing();

  // Keep the legacy membership table in step too — registry-sync derives `area_members` from it.
  await exec
    .insert(areaDevices)
    .values({ areaId, systemId, ordinal: 0 })
    .onConflictDoNothing();
  await DeviceRegistry.ensureAreaForHandle(systemId, areaId, exec);

  // Re-read rather than trusting `areaId`: a concurrent mint may have won the ON CONFLICT.
  const [row] = await exec
    .select({ id: areas.id })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  return row?.id ?? areaId;
}

/**
 * Ensure a `devices` row (and its `legacy_handles` mapping, area-of-one and `area_members` edge) exists
 * for a legacy system handle. Idempotent.
 *
 * Column mapping mirrors the cutover transform exactly: `vendor_type→vendor`, `display_name→name`,
 * `alias→slug`, `owner_clerk_user_id→owner_user_id`, `metadata→adapter_state`, and the free-text
 * ratings/solar/battery fields stashed under `config.legacy*`.
 *
 * @returns the device uuid
 */
export async function ensureDeviceRow(
  systemId: number,
  exec: Exec = requirePlanetscaleDb(),
): Promise<string> {
  const addr = await DeviceRegistry.ensureDeviceForHandle(systemId, exec);
  const areaId = await ensureAreaOfOne(systemId, exec);

  await exec.execute(sql`
    INSERT INTO devices (id, rid, owner_user_id, vendor, vendor_site_id, status, name, slug, model, serial,
                         primary_area_id, config, adapter_state, commissioned_on, created_at, updated_at)
    SELECT ${addr.uuid}::uuid, s.id, s.owner_clerk_user_id, s.vendor_type, s.vendor_site_id, s.status,
           s.display_name, s.alias, s.model, s.serial,
           ${areaId}::uuid,
           coalesce(s.config, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
             'legacyRatings', s.ratings, 'legacySolarSize', s.solar_size, 'legacyBatterySize', s.battery_size)),
           s.metadata, s.commissioned_on, s.created_at, s.updated_at
    FROM systems s
    WHERE s.id = ${systemId}
    ON CONFLICT (id) DO NOTHING`);

  await exec
    .insert(areaMembers)
    .values({ areaId, deviceId: addr.uuid, ordinal: 0 })
    .onConflictDoNothing();

  return addr.uuid;
}

/**
 * Mirror one `point_info` row into `points`, preserving `point_uid` as the id and `rid` verbatim.
 *
 * `ON CONFLICT (id) DO UPDATE` on the mutable descriptive columns keeps a renamed/retransformed point in
 * step, but NEVER touches `rid` or `device_id` — those are identity.
 */
export async function mirrorPoint(
  input: MirrorPointInput,
  exec: Exec = requirePlanetscaleDb(),
): Promise<void> {
  const deviceId = await ensureDeviceRow(input.systemId, exec);

  await exec
    .insert(points)
    .values({
      id: input.pointUid,
      rid: input.rid,
      deviceId,
      physicalPath: input.physicalPathTail,
      logicalPath: input.logicalPathStem,
      metricType: input.metricType,
      unit: input.metricUnit,
      name: input.displayName,
      defaultName: input.defaultName,
      subsystem: input.subsystem,
      transform: input.transform,
      active: input.active,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: points.id,
      set: {
        physicalPath: input.physicalPathTail,
        logicalPath: input.logicalPathStem,
        metricType: input.metricType,
        unit: input.metricUnit,
        name: input.displayName,
        defaultName: input.defaultName,
        subsystem: input.subsystem,
        transform: input.transform,
        active: input.active,
        updatedAt: input.updatedAt,
        // rid + device_id are identity — deliberately NOT overwritten.
      },
    });
}
