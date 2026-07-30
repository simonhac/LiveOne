import { eq, max } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { isProduction } from "@/lib/env";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems as pgSystems } from "@/lib/db/planetscale/schema";
import { DeviceRegistry } from "@/lib/registry";
import { ensureDeviceRow } from "@/lib/registry/v4-mirror";

/**
 * A `systems` row. The last surviving export of this module, and only because it is the patch shape of
 * {@link SystemsManager.updateSystem}. Config READS are `DeviceConfigRegistry`
 * (lib/registry/device-config.ts) — `SystemWithPolling`, `PollingStatus` and `Area` were deleted with
 * the readers in slice K3.
 */
export type System = InferSelectModel<typeof pgSystems>;

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

/**
 * The WRITE residue of the v3 config registry: four writers against `systems`, and nothing else.
 *
 * Slice K2 moved every config READ to `DeviceConfigRegistry`; slice K3 moved the last two (the
 * polymorphic-handle area views, `getViewableSystem`/`isAreaHandle`) and deleted `getSystem`, its
 * `deviceStateByHandle` subquery and `fetchSystemById` outright. Nothing in this module reads config any
 * more — `insertSystemToPg`'s `max(systems.id)` dev-id probe is a WRITE-path allocation, not a read.
 *
 * The four writers stay because `systems_id_seq` still allocates the integer handle while `devices.rid`
 * is documented inert: `devices` cannot become the write target until `systems` drops. They flip — and
 * this file goes — in the terminal window (Phase 12 slice N / Phase 13).
 *
 * ⚠️ Do NOT "fix" {@link SystemsManager.deleteSystem}'s orphaned `devices` row: the terminal window's
 * FK-coverage guard depends on that orphaning. See the method comment.
 */
export class SystemsManager {
  private static instance: SystemsManager | null = null;

  private constructor() {}

  /** Get the (stateless) SystemsManager facade. Cheap: no DB work, no cross-request cache. */
  static getInstance(): SystemsManager {
    return (SystemsManager.instance ??= new SystemsManager());
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
