/**
 * config-v4 forward mirror: keep the v4 registries (`devices`, `points`) in step with every write to
 * the legacy registries (`systems`, `point_info`).
 *
 * `area_members` is no longer mirrored — since slice H it is the membership table itself, written
 * directly by `lib/areas/members.ts`. The only write left here is the area-of-one edge, which is minted
 * alongside the device rather than copied from anywhere.
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

import { and, eq, isNull, sql } from "drizzle-orm";
import type { AreaLocation } from "@/lib/areas/types";
import { Area } from "@/lib/ids";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaMembers,
  pointInfo,
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
 * Narrow a `point_info` row to the mirror's input.
 *
 * Shared by BOTH writers — the mint upsert and `updatePoint` — deliberately: when they each built this
 * object inline, only one of them existed, and the edit path silently shipped without a mirror call at
 * all. One mapper means a new mirrored column is a compile error in one place, not a leak in the other.
 */
export function toMirrorPointInput(
  row: typeof pointInfo.$inferSelect,
): MirrorPointInput {
  return {
    systemId: row.systemId,
    pointUid: row.pointUid,
    rid: row.rid,
    physicalPathTail: row.physicalPathTail,
    logicalPathStem: row.logicalPathStem,
    metricType: row.metricType,
    metricUnit: row.metricUnit,
    displayName: row.displayName,
    defaultName: row.defaultName,
    subsystem: row.subsystem,
    transform: row.transform,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Extract the first positive number preceding `unit` from a free-text spec column, as SQL.
 *
 * Lower-cased so "kW"/"kw"/"KWh" all match; the pattern uses `[ ]*` / `[.]` rather than `\s` / `\.`
 * ON PURPOSE — a `\` inside a JS template literal is an unknown string escape that silently drops to
 * the bare character, so `\s` would reach Postgres as `s` and match "9 skW". No backslashes, no trap.
 *
 * `nullif(greatest(coalesce(…,0),0),0)` collapses "no match" and "not a positive number" to NULL, which
 * `jsonb_strip_nulls` then removes: an absent spec field must mean exactly what an unparseable free-text
 * value meant. System 3 carries the literal `solar_size` "-0.0 kW" — the capture group is unsigned so it
 * reads 0.0, and this filters it. (The retiring regex also rejected it, via its `^` anchor.)
 */
function specNum(col: string, unit: "kw" | "kwh" | "v"): string {
  return `nullif(greatest(coalesce((substring(lower(${col}) from '([0-9]+([.][0-9]+)?)[ ]*${unit}'))::numeric, 0), 0), 0)`;
}

/**
 * `devices.config`, built from `systems.config` plus the STRUCTURED device spec (`DeviceConfig.spec`,
 * lib/capabilities/config.ts) parsed out of the three free-text `systems` columns.
 *
 * Replaces the earlier `legacyRatings`/`legacySolarSize`/`legacyBatterySize` string stash, and DELETES
 * those keys on the way through so a re-mirrored device is never left carrying both shapes. `devices`
 * has no counterpart to the three columns by design (clean-sheet §4.8), and the only behavioural reader
 * of the free text was a regex re-deriving these very numbers on every render
 * (`maxPowerHintFromSystemInfo`) — a number that must be re-parsed on each read was never stored.
 *
 * This is the SOLE implementation of the parse. The backfill
 * (`scripts/config-v4/backfill-device-spec.ts`) re-runs `ensureDeviceRow` rather than reimplementing it
 * in TypeScript, so there is no second copy to drift.
 */
export const DEVICE_CONFIG_WITH_SPEC_SQL = `
  ((coalesce(s.config, '{}'::jsonb) - 'legacyRatings' - 'legacySolarSize' - 'legacyBatterySize')
   || jsonb_strip_nulls(jsonb_build_object('spec', nullif(jsonb_strip_nulls(jsonb_build_object(
        'solarSizeKw',     ${specNum("s.solar_size", "kw")},
        'batterySizeKwh',  ${specNum("s.battery_size", "kwh")},
        'inverterSizeKw',  ${specNum("s.ratings", "kw")},
        'batteryVoltageV', ${specNum("s.ratings", "v")}
      )), '{}'::jsonb))))`;

/**
 * Ensure the area-of-one for a device handle, minting it if absent — and BACKFILL its placement.
 *
 * `devices.primary_area_id` is tightened to NOT NULL by registry-sync, and v3's `createSystem` does not
 * mint an area (the "explicit areas only" model on `main`), so a system created after registry-sync would
 * otherwise have no area to point at. tz/location are copied up from the device: post-cutover the area is
 * the SOLE home for placement, so this is a move, not a duplicate.
 *
 * ## The mint-only leak, and why the reconcile is one-directional
 *
 * Until slice K2 this function returned early on `if (existing)`, so placement was copied at MINT and
 * never again — the EIGHTH instance of "wired at mint, not at edit" (A2 found three, H a fourth, E a
 * fifth, M a sixth shape, K1 a seventh). `updateSystem` re-mirrors `devices` but the area is a separate
 * row, so every `location`/timezone edit through the admin settings route drifted, with nothing able to
 * self-heal it. That matters now: `lib/grid/context.ts` derives the NEM region from `areas.location`, and
 * the terminal window DROPS `systems` — a value living only there is destroyed, not merely stale.
 *
 * ⚠️ The reconcile fills only what is MISSING on the area, and never overwrites. The area is the
 * AUTHORITY: the area builder and `/api/areas/*` write `areas.location` / the timezones directly, so a
 * blanket copy-down from `systems` would destroy the newer value. That is not hypothetical — handle 13
 * (Kutis) is exactly this case, with a populated `areas.location` and a stale/null `systems.location`,
 * and it is asserted as a NAMED benign divergence in `verify-slice-k1-parity.ts` block 4. So: `systems`
 * → area only where the area side is NULL. Timezones are NOT NULL on `areas`, so they are never filled
 * by this path; `location` is the one nullable column and the one that leaked.
 *
 * @returns the area uuid
 */
async function ensureAreaOfOne(systemId: number, exec: Exec): Promise<string> {
  const [existing] = await exec
    .select({ id: areas.id, location: areas.location })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  if (existing) {
    // Heal the mint-only leak, one-directionally: adopt `systems.location` ONLY when the area has none.
    if (existing.location == null) {
      const [src] = await exec
        .select({ location: systems.location })
        .from(systems)
        .where(eq(systems.id, systemId))
        .limit(1);
      if (src?.location != null) {
        await exec
          .update(areas)
          .set({ location: src.location as AreaLocation | null })
          .where(and(eq(areas.id, existing.id), isNull(areas.location)));
      }
    }
    return existing.id;
  }

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
      // config-v4: KEYS are the renamed `areas` columns; VALUES come from the untouched `systems` row.
      id: areaId,
      ownerUserId: sys.owner,
      legacySystemId: systemId,
      name: sys.name,
      slug: null,
      timezoneOffsetMin: sys.tzOffset,
      displayTimezone: sys.tz,
      dayOffsetMin: sys.tzOffset, // canonical fixed-offset day key == the device's offset
      // `systems.location` is untyped jsonb; `areas.location` is $type<AreaLocation>. Same shape, so
      // this is a declaration-level cast, not a conversion.
      location: sys.location as AreaLocation | null,
      status: "active",
    })
    .onConflictDoNothing();

  // The area-of-one's membership edge is NOT written here: `area_members.device_id` FKs `devices.id`,
  // and this runs BEFORE `ensureDeviceRow`'s INSERT into `devices`. It is written there instead, once
  // the row exists (slice H — `area_devices`, which had no FK, used to be written at this point).
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
 * for a legacy system handle, and bring its mutable columns back in step with `systems`. Idempotent.
 *
 * Column mapping mirrors the cutover transform exactly: `vendor_type→vendor`, `display_name→name`,
 * `alias→slug`, `owner_clerk_user_id→owner_user_id`, `metadata→adapter_state`, and the free-text
 * ratings/solar/battery fields PARSED into the structured `config.spec` (slice K1 — they used to be
 * stashed verbatim under `config.legacy*`, which `deviceConfigWithSpecSql` now deletes).
 *
 * `ON CONFLICT (id) DO UPDATE` (not `DO NOTHING`) is what makes this a *mirror* rather than a one-shot
 * mint, matching `mirrorPoint` below. It previously did nothing on conflict, so `devices` was written at
 * mint only and every `systems` edit drifted it — a rename or a status change through the admin UI
 * (`updateSystem`, 8+ callers) diverged `name`/`status`/`slug`/`config`/`adapter_state` silently, and
 * nothing could self-heal it. `systems` is the sole writer of those columns (the only other `devices`
 * writer is the one-off `scripts/config-v4/registry-populate.ts`), so re-copying cannot clobber
 * device-side state.
 *
 * NEVER overwritten on conflict: `rid`, `primary_area_id` and `created_at` — those are identity. `rid`
 * in particular is the `devices.rid == systems.id` seam invariant.
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
           ${sql.raw(DEVICE_CONFIG_WITH_SPEC_SQL)},
           s.metadata, s.commissioned_on, s.created_at, s.updated_at
    FROM systems s
    WHERE s.id = ${systemId}
    ON CONFLICT (id) DO UPDATE SET
      owner_user_id   = EXCLUDED.owner_user_id,
      vendor          = EXCLUDED.vendor,
      vendor_site_id  = EXCLUDED.vendor_site_id,
      status          = EXCLUDED.status,
      name            = EXCLUDED.name,
      slug            = EXCLUDED.slug,
      model           = EXCLUDED.model,
      serial          = EXCLUDED.serial,
      config          = EXCLUDED.config,
      adapter_state   = EXCLUDED.adapter_state,
      commissioned_on = EXCLUDED.commissioned_on,
      updated_at      = EXCLUDED.updated_at`);

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
