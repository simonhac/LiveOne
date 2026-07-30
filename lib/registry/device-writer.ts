import { eq, max } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { isProduction } from "@/lib/env";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems as pgSystems } from "@/lib/db/planetscale/schema";
import {
  ensureDeviceRow,
  mirrorPlacementToAreaOfOne,
} from "@/lib/registry/v4-mirror";

/**
 * A `systems` row. The only type this module exports, and only because it is the patch shape of
 * {@link updateSystem}. Config READS are `DeviceConfigRegistry` (./device-config.ts) —
 * `SystemWithPolling`, `PollingStatus` and `Area` were deleted with the readers in slice K3.
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
 * ## Why this file exists (and why it is not `SystemsManager` any more)
 *
 * Slice K2 moved every config READ to `DeviceConfigRegistry`; slice K3 moved the last two (the
 * polymorphic-handle area views, `getViewableSystem`/`isAreaHandle`) and deleted `getSystem`, its
 * `deviceStateByHandle` subquery and `fetchSystemById` outright. That emptied `lib/systems-manager.ts` of
 * everything except these four writers — so K3 relocated them here VERBATIM and deleted the file.
 *
 * The writers could not be CONVERTED in K3: `systems_id_seq` still allocates the integer handle while
 * `devices.rid` is documented inert, so `devices` cannot become the write target until `systems` drops.
 * Relocating them is not converting them — the SQL is unchanged, `systems` is still the author and
 * `devices` still the mirror. The point is that the terminal window inherits a small file in the registry
 * folder with a name that says what it is, instead of a class named after a registry that no longer
 * exists. This whole module goes when `systems` drops.
 *
 * Nothing here reads config — `insertSystemToPg`'s `max(systems.id)` dev-id probe is a WRITE-path
 * allocation, not a read. Callers use `DeviceConfigRegistry` for every read, including read-back.
 *
 * ⚠️ Do NOT "fix" {@link deleteSystem}'s orphaned `devices` row: the terminal window's FK-coverage guard
 * depends on that orphaning. See the method comment.
 */
/**
 * Create a new system in the database.
 * @param systemData - The system data to insert
 * @returns The created system
 */
async function createSystem(systemData: CreateSystemData): Promise<System> {
  const newSystem = await insertSystemToPg(systemData);

  console.log(
    `[DeviceWriter] Created system ${newSystem.id} (${systemData.vendorType}) for user ${systemData.ownerClerkUserId}`,
  );

  // Areas are EXPLICIT: a device does NOT get an auto-minted area-of-one. A device renders on its own
  // /device view straight from `point_info` + capabilities (no backing Area), and flow is an
  // area-only concept — a device gets a flow matrix only once a user groups it into an Area
  // (createArea). No cache to invalidate: config is read per-request.
  //
  // config-v4: the `devices` mirror is minted INSIDE `insertSystemToPg`'s transaction (see there), so
  // the standing C7 invariant (`systems` with no `devices` row == 0) holds atomically and there is no
  // best-effort mirror call here any more. It could not stay best-effort: `legacy_handles.device_id`
  // FKs `devices(id)`, so the mirror is no longer optional bookkeeping that a create can skip — a
  // create either lands whole or not at all. Note this DOES mint the v4 area-of-one — post-cutover the
  // area is the sole home for tz/location and `devices.primary_area_id` is NOT NULL, so it is a
  // structural requirement of the v4 shape, not a reversal of the explicit-areas model above (which
  // governs the v3 rendering path).
  return newSystem;
}

/**
 * Create a HELPER device — a derived, non-physical, never-polled `systems` row (vendor_type='helper')
 * that lives in an Area and owns the Area's COMPUTED points (battery-provenance blend, …). Its
 * SEMANTIC home is an existing Area, of which it is a MEMBER (wired by
 * `lib/areas/helper.ts::ensureHelperDevice`). Owned by the Area's owner for access control (NOT
 * ownerless — the blend is private household-derived data).
 *
 * ⚠️ It nonetheless gets a v4 area-of-one, exactly like {@link createSystem}. This comment used to
 * claim it did NOT; the tree disagreed — `ensureHelperDevice` calls `ensureDeviceRow`, which always
 * mints one, and all six helpers on `liveone-dev` have had an `areas` row keyed by their handle since
 * they were created. `devices.primary_area_id` is NOT NULL post-cutover, so a device with no
 * area-of-one is not a representable shape; the helper's Area membership is the SECOND edge, not a
 * substitute for it. So the FK fix deliberately did NOT give this path a no-area variant — that would
 * have been a behaviour change dressed as a hotfix.
 */
async function createHelperDevice(params: {
  ownerClerkUserId: string | null;
  vendorSiteId: string;
  displayName: string;
  timezoneOffsetMin: number;
  displayTimezone: string;
}): Promise<System> {
  const sys = await insertSystemToPg({
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
    `[DeviceWriter] Created helper device ${sys.id} (${params.vendorSiteId})`,
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
 *
 * The same is true one level out for tz: `devices` has no tz/location columns (the area-of-one is their
 * sole home by design), so `ensureDeviceRow` cannot carry a timezone edit anywhere a reader will find
 * it. `mirrorPlacementToAreaOfOne` closes that — in the SAME transaction, so a tz edit can never be
 * half-applied. See its header for why this is intent propagation and not the blanket copy-down
 * `ensureAreaOfOne` deliberately refuses.
 */
async function updateSystem(
  systemId: number,
  patch: Partial<System>,
): Promise<void> {
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
    await mirrorPlacementToAreaOfOne(
      systemId,
      {
        ...(values.timezoneOffsetMin != null && {
          timezoneOffsetMin: values.timezoneOffsetMin,
        }),
        ...(values.displayTimezone != null && {
          displayTimezone: values.displayTimezone,
        }),
      },
      tx,
    );
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
async function deleteSystem(systemId: number): Promise<void> {
  await requirePlanetscaleDb()
    .delete(pgSystems)
    .where(eq(pgSystems.id, systemId));
}

/**
 * Insert the system into Postgres. The alias-unique collision is a unique_violation,
 * surfaced with SQLSTATE '23505'; rethrown unchanged so callers keep their handling.
 */
async function insertSystemToPg(systemData: CreateSystemData): Promise<System> {
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
          displayTimezone: systemData.displayTimezone ?? "Australia/Melbourne", // Default timezone
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      // ONE transaction, `devices` before `legacy_handles`. This used to be a bare
      // `DeviceRegistry.ensureDeviceForHandle`, which writes `legacy_handles.device_id` — FK'd to
      // `devices(id)` since migration 0036 — for a uuid that no `devices` row carried yet, so EVERY
      // device creation raised 23503. `ensureDeviceRow` is the ordered writer (devices → handle →
      // area-of-one → membership) and is idempotent, so it is also correct on the re-mirror paths.
      await ensureDeviceRow(inserted.id, tx);
      return inserted;
    });

    // PG createdAt/updatedAt are Date-typed; the row is structurally the System
    // shape the caller expects.
    return newSystem as unknown as System;
  } catch (e) {
    if (isPgUniqueViolation(e)) {
      console.warn(
        `[DeviceWriter] Postgres alias-unique collision (23505) creating system for user ${systemData.ownerClerkUserId}`,
      );
    }
    throw e;
  }
}

/**
 * The four surviving `systems` writers. A plain object, like `DeviceRegistry` / `DeviceConfigRegistry`:
 * the old `SystemsManager` singleton held no state, so `getInstance()` bought nothing.
 */
export const DeviceWriter = {
  createSystem,
  createHelperDevice,
  updateSystem,
  deleteSystem,
};
