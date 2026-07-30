import { cache } from "react";
import { eq, max, getTableColumns } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { isProduction } from "@/lib/env";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  systems as pgSystems,
  devices as pgDevices,
  deviceState as pgDeviceState,
  areas as pgAreas,
} from "@/lib/db/planetscale/schema";
import { DeviceRegistry } from "@/lib/registry";
import {
  DeviceConfigRegistry,
  type DeviceConfigView,
} from "@/lib/registry/device-config";
import { ensureDeviceRow } from "@/lib/registry/v4-mirror";

// Export the type for a system from the database
export type System = InferSelectModel<typeof pgSystems>;
/**
 * Operational polling state. Now sourced from `device_state`, not `polling_status` (config-v4 Phase 12
 * slice C) — so it no longer carries the legacy `id`/`systemId` columns. The name is kept because it
 * is what the shape MEANS; slice K renames the surface wholesale.
 */
export type PollingStatus = InferSelectModel<typeof pgDeviceState>;

export type Area = InferSelectModel<typeof pgAreas>;

// Combined system with polling status
export type SystemWithPolling = System & {
  pollingStatus?: PollingStatus | null;
};

/**
 * `device_state` re-keyed onto the legacy integer handle, so the ONE remaining `systems` read below can
 * join it exactly where it used to join `polling_status`.
 *
 * config-v4 slice K2 was briefed to DELETE this. It cannot go yet: it exists to give `getSystem` a
 * `pollingStatus`, and `getSystem` is the LEGACY side of `verify-slice-k1-parity.ts` — the gate that
 * proves the whole K2 conversion moved nothing. Deleting the subquery deletes the only independent
 * reading of `device_state` that `deviceByHandle`'s native join can be checked against, which is the
 * "re-assert an equivalence inside the change that destroys your ability to check it" trap. It goes
 * with `getSystem` in the terminal window, after the gate has served its purpose.
 *
 * `device_state` is keyed by `devices.id` (uuid), and the bridge to `systems.id` is the verbatim-rid
 * invariant `devices.rid == systems.id` (lib/registry/v4-mirror.ts). Folding that hop into a subquery
 * keeps it stated once instead of eight times, and keeps the join sites a one-line swap. Both hops are
 * unique-index probes over a 16-row table.
 *
 * Built from a standalone QueryBuilder, not `requirePlanetscaleDb()`, so importing this module never
 * needs a configured pool.
 */
const deviceStateByHandle = new QueryBuilder()
  .select({ handle: pgDevices.rid, ...getTableColumns(pgDeviceState) })
  .from(pgDeviceState)
  .innerJoin(pgDevices, eq(pgDevices.id, pgDeviceState.deviceId))
  .as("device_state");

/**
 * An "area view" — a SystemWithPolling shape synthesized from a multi-device Area whose integer
 * addressing handle (`legacy_system_id`) has NO real `systems` row. It is the SERVER-ONLY resolution
 * of that handle for the dashboard data path (points/flow/auth resolve via `area_bindings` + members);
 * it is deliberately kept OUT of the systems/devices/admin lists. Owns no points and never polls, so
 * device/polling fields are null.
 */
function synthesizeAreaView(area: Area): DeviceConfigView | null {
  if (area.legacySystemId == null) return null;
  return {
    id: area.legacySystemId,
    ownerClerkUserId: area.ownerUserId,
    vendorType: "area",
    vendorSiteId: `area:${area.legacySystemId}`,
    status: area.status,
    displayName: area.name,
    alias: area.slug,
    model: null,
    serial: null,
    location: area.location,
    metadata: null,
    config: null,
    timezoneOffsetMin: area.timezoneOffsetMin,
    displayTimezone: area.displayTimezone,
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
    commissionedOn: null, // area views own no points and never poll — no vendor commission date
    pollingStatus: null,
  };
}

// Input shape for creating a system (shared by createSystem and its routed inserts).
type CreateSystemData = {
  ownerClerkUserId: string;
  vendorType: string;
  vendorSiteId: string;
  status?: string;
  displayName: string;
  alias?: string | null;
  model?: string | null;
  serial?: string | null;
  ratings?: string | null;
  solarSize?: string | null;
  batterySize?: string | null;
  location?: any;
  metadata?: any;
  timezoneOffsetMin?: number;
  displayTimezone?: string;
};

/**
 * Detect a Postgres unique_violation (SQLSTATE '23505'), e.g. the alias-unique collision.
 * `pg` puts the SQLSTATE on the error's `code` field.
 */
function isPgUniqueViolation(e: unknown): boolean {
  return (
    !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505"
  );
}

/** Flatten a systems⋈device_state join row (any extra joined tables are ignored). */
function toSystemWithPolling(row: {
  systems: System;
  device_state: (PollingStatus & { handle: number }) | null;
}): SystemWithPolling {
  if (!row.device_state) return { ...row.systems, pollingStatus: null };
  // `handle` exists only to carry the join key out of the subquery — drop it so `pollingStatus` is
  // exactly a device_state row at runtime as well as in the types.
  const { handle: _handle, ...state } = row.device_state;
  return { ...row.systems, pollingStatus: state };
}

/**
 * Per-request memoized point lookup of a real system by id (with polling status). React's `cache()`
 * dedupes repeated lookups of the same id within a single request; nothing is shared across requests,
 * so config is always fresh. Outside a request (Jest/scripts) it just runs unmemoized.
 */
const fetchSystemById = cache(
  async (id: number): Promise<SystemWithPolling | null> => {
    const [row] = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .leftJoin(
        deviceStateByHandle,
        eq(deviceStateByHandle.handle, pgSystems.id),
      )
      .where(eq(pgSystems.id, id))
      .limit(1);
    return row ? toSystemWithPolling(row) : null;
  },
);

/** Per-request memoized lookup of the Area whose addressing handle is `id` → synthesized area view. */
const fetchAreaByHandle = cache(async (id: number): Promise<Area | null> => {
  const [area] = await requirePlanetscaleDb()
    .select()
    .from(pgAreas)
    .where(eq(pgAreas.legacySystemId, id))
    .limit(1);
  return area ?? null;
});

/**
 * The RESIDUE of the v3 config registry, after slice K2 moved every config READ to
 * `DeviceConfigRegistry` (lib/registry/device-config.ts).
 *
 * What is left, and why:
 *
 * - **`getSystem`** — zero production callers. Retained solely as the LEGACY side of
 *   `scripts/config-v4/verify-slice-k1-parity.ts`. Dies with `systems` in the terminal window.
 * - **`getViewableSystem` / `isAreaHandle`** — slice K3. Their REAL leg already reads `devices`; only
 *   the multi-device-area synthesis is still v3-shaped.
 * - **The four WRITERS** (`createSystem`, `createHelperDevice`, `updateSystem`, `deleteSystem`) —
 *   `systems` is still the author and `devices` still the mirror, because `systems_id_seq` allocates
 *   while `devices.rid` is documented inert. Writes flip in the terminal window, not here.
 *
 * Six readers (`getSystemByVendorSiteId`, `getSystemByUsernameAndAlias`, `getActiveSystems`,
 * `getAllSystems`, `getSystemsByOwner`, `getSystemsVisibleByUser`, `getPrimaryVisibleSystem`) were
 * deleted outright by K2 once their last caller moved — a callerless reader against a dying table is
 * not a shim, it is a second definition of "the config registry".
 */
export class SystemsManager {
  private static instance: SystemsManager | null = null;

  private constructor() {}

  /** Get the (stateless) SystemsManager facade. Cheap: no DB work, no cross-request cache. */
  static getInstance(): SystemsManager {
    return (SystemsManager.instance ??= new SystemsManager());
  }

  /** Get a real system by id (with polling status). */
  async getSystem(systemId: number): Promise<SystemWithPolling | null> {
    return fetchSystemById(systemId);
  }

  /**
   * Resolve a handle for the DASHBOARD DATA PATH: a real system, OR an area view (a multi-device Area
   * with no `systems` row). Use this — not getSystem — wherever an Area's whole-area data/auth/flow is
   * served. getSystem stays real-only (devices/admin/polling).
   */
  async getViewableSystem(systemId: number): Promise<DeviceConfigView | null> {
    // config-v4 slice K2: the REAL leg reads `devices` (the config registry), not `systems`. Only the
    // area-view synthesis below is still v3-shaped, and that is what K3 deletes.
    const real = await DeviceConfigRegistry.deviceByHandle(systemId);
    if (real) return real; // real row wins (an area-of-one)
    const area = await fetchAreaByHandle(systemId);
    return area ? synthesizeAreaView(area) : null;
  }

  /** Whether `systemId` is an area view (a multi-device Area handle with no real `systems` row). */
  async isAreaHandle(systemId: number): Promise<boolean> {
    if (await DeviceConfigRegistry.deviceByHandle(systemId)) return false; // real row wins
    return (await fetchAreaByHandle(systemId)) != null;
  }

  /**
   * Create a new system in the database.
   * @param systemData - The system data to insert
   * @returns The created system
   */
  async createSystem(systemData: CreateSystemData): Promise<System> {
    const newSystem = await this.insertSystemToPg(systemData);

    console.log(
      `[SystemsManager] Created system ${newSystem.id} (${systemData.vendorType}) for user ${systemData.ownerClerkUserId}`,
    );

    // Areas are EXPLICIT: a device does NOT get an auto-minted area-of-one. A device renders on its own
    // /device view straight from `point_info` + capabilities (no backing Area), and flow is an
    // area-only concept — a device gets a flow matrix only once a user groups it into an Area
    // (createArea). No cache to invalidate: config is read per-request.
    //
    // config-v4: mirror into `devices` immediately so the standing C7 invariant
    // (`systems` with no `devices` row == 0) can never be disarmed by a newly created system. Note this
    // DOES mint the v4 area-of-one — post-cutover the area is the sole home for tz/location and
    // `devices.primary_area_id` is NOT NULL, so it is a structural requirement of the v4 shape, not a
    // reversal of the explicit-areas model above (which governs the v3 rendering path).
    // Best-effort: the v4 registries are dark until cutover, so a mirror failure must not fail creation.
    try {
      await ensureDeviceRow(newSystem.id);
    } catch (error) {
      console.error(
        `[SystemsManager] v4 device mirror failed for system ${newSystem.id} — registry-sync will heal it`,
        error,
      );
    }
    return newSystem;
  }

  /**
   * Create a HELPER device — a derived, non-physical, never-polled `systems` row (vendor_type='helper')
   * that lives in an Area and owns the Area's COMPUTED points (battery-provenance blend, …). Unlike
   * {@link createSystem} it does NOT mint an area-of-one: a helper is a MEMBER of an existing Area
   * (wired by `lib/areas/helper.ts::ensureHelperDevice`), never its own area. Owned by the Area's owner
   * for access control (NOT ownerless — the blend is private household-derived data).
   */
  async createHelperDevice(params: {
    ownerClerkUserId: string | null;
    vendorSiteId: string;
    displayName: string;
    timezoneOffsetMin: number;
    displayTimezone: string;
  }): Promise<System> {
    const sys = await this.insertSystemToPg({
      ownerClerkUserId: params.ownerClerkUserId,
      vendorType: "helper",
      vendorSiteId: params.vendorSiteId,
      status: "active",
      displayName: params.displayName,
      alias: null,
      timezoneOffsetMin: params.timezoneOffsetMin,
      displayTimezone: params.displayTimezone,
    } as CreateSystemData);
    console.log(
      `[SystemsManager] Created helper device ${sys.id} (${params.vendorSiteId})`,
    );
    return sys;
  }

  /**
   * Update an existing system, and re-mirror it into the v4 `devices` registry.
   *
   * Updates Postgres only (config writes are Postgres-only). The patch maps 1:1 —
   * PG jsonb/timestamp columns accept plain objects/Dates directly, so no per-field
   * mapping is needed. `updatedAt` is always stamped to now regardless of the patch.
   *
   * config-v4: the `systems` write and its `devices` mirror are ONE transaction. Before this, the mirror
   * was written at mint only, so every edit here drifted `devices.name`/`status`/`slug`/`config`/
   * `adapter_state` — and `ensureDeviceRow` was `ON CONFLICT DO NOTHING`, so nothing could self-heal it.
   * Slice K reads `devices` as the config registry, so the drift is not cosmetic.
   */
  async updateSystem(systemId: number, patch: Partial<System>): Promise<void> {
    // Never let the caller override the id or the freshly-stamped updatedAt.
    const { id: _ignoredId, updatedAt: _ignoredUpdatedAt, ...rest } = patch;
    const values = { ...rest, updatedAt: new Date() };

    await requirePlanetscaleDb().transaction(async (tx) => {
      await tx
        .update(pgSystems)
        .set(values as Partial<InferSelectModel<typeof pgSystems>>)
        .where(eq(pgSystems.id, systemId));
      // Re-copies the mutable columns from the row just written (ensureDeviceRow SELECTs `systems`).
      await ensureDeviceRow(systemId, tx);
    });
  }

  /**
   * Delete a system.
   *
   * Deletes from Postgres only.
   *
   * ⚠️ config-v4 KNOWN GAP (deliberately not closed here): this leaves the mirrored `devices` row
   * ORPHANED. There is no FK from `devices` to `systems` (`devices.rid` is a plain integer), so nothing
   * cascades. Not fixed in the mirror-leak pass because deleting a device is not the inverse of this
   * one-liner — `area_members`, `points.device_id` and the device's area-of-one all hang off it, so the
   * safe teardown order is slice N's problem, not a side effect of a v3 delete. Low real exposure: the
   * only caller is the create-rollback path in `app/api/systems/route.ts`, where the device row was just
   * minted moments earlier. Revisit when `devices` becomes the primary registry (slice K/N).
   */
  async deleteSystem(systemId: number): Promise<void> {
    await requirePlanetscaleDb()
      .delete(pgSystems)
      .where(eq(pgSystems.id, systemId));
  }

  /**
   * Insert the system into Postgres. The alias-unique collision is a unique_violation,
   * surfaced with SQLSTATE '23505'; rethrown unchanged so callers keep their handling.
   */
  private async insertSystemToPg(
    systemData: CreateSystemData,
  ): Promise<System> {
    const pg = requirePlanetscaleDb();

    // Dev-id policy: explicit ids from 10000 in dev, serial in prod.
    let systemId: number | undefined = undefined;
    if (!isProduction()) {
      const DEV_SYSTEM_ID_START = 10000;
      const [{ maxId }] = await pg
        .select({ maxId: max(pgSystems.id) })
        .from(pgSystems);
      systemId =
        maxId && maxId >= DEV_SYSTEM_ID_START ? maxId + 1 : DEV_SYSTEM_ID_START;
    }

    try {
      const newSystem = await pg.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(pgSystems)
          .values({
            ...(systemId !== undefined ? { id: systemId } : {}),
            ownerClerkUserId: systemData.ownerClerkUserId,
            vendorType: systemData.vendorType,
            vendorSiteId: systemData.vendorSiteId,
            status: systemData.status || "active",
            displayName: systemData.displayName,
            alias: systemData.alias,
            model: systemData.model,
            serial: systemData.serial,
            ratings: systemData.ratings,
            solarSize: systemData.solarSize,
            batterySize: systemData.batterySize,
            location: systemData.location,
            metadata: systemData.metadata,
            timezoneOffsetMin: systemData.timezoneOffsetMin ?? 600, // Default to AEST
            displayTimezone:
              systemData.displayTimezone ?? "Australia/Melbourne", // Default timezone
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning();
        await DeviceRegistry.ensureDeviceForHandle(inserted.id, tx);
        return inserted;
      });

      // PG createdAt/updatedAt are Date-typed; the row is structurally the System
      // shape the caller expects.
      return newSystem as unknown as System;
    } catch (e) {
      if (isPgUniqueViolation(e)) {
        console.warn(
          `[SystemsManager] Postgres alias-unique collision (23505) creating system for user ${systemData.ownerClerkUserId}`,
        );
      }
      throw e;
    }
  }
}
