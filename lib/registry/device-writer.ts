import { eq, max, sql } from "drizzle-orm";
import { isProduction } from "@/lib/env";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { uniqueViolationDetail, violatedUniqueName } from "@/lib/db/pg-error";
import { areaMembers, areas, devices } from "@/lib/db/planetscale/schema";
import type { AreaLocation } from "@/lib/areas/types";
import type { DeviceConfig } from "@/lib/capabilities/config";
import { Area, Device, type DeviceId } from "@/lib/ids";
import { DeviceRegistry, type DeviceRegistryExec } from "./device-registry";

/**
 * The four device writers. Since config-v4 Phase 12 slice 1a they write **`devices` + `areas`**, and
 * `systems` is not referenced anywhere in this file — this was the last writer of that table.
 *
 * ## What changed, and why the mirror had to die with it
 *
 * Until 1a these four wrote `systems` and then called `ensureDeviceRow` (`lib/registry/v4-mirror.ts`) to
 * COPY the row into `devices`. That mirror is not separable from the writer: `ensureDeviceRow` and
 * `ensureAreaOfOne` both resolved their values with `SELECT … FROM systems`, so the moment `systems`
 * stops being written there is nothing for them to read. Converting the writer therefore deletes the
 * mirror in the same change, and every value it used to copy is now supplied directly by the caller.
 *
 * Placement (tz / location) lives on the **area-of-one**, which is its permanent home — `devices` has no
 * tz or location columns by design (clean-sheet §4.8). So a placement edit is an `areas` UPDATE here,
 * not the `mirrorPlacementToAreaOfOne` intent-propagation hop it used to need. That hop existed only to
 * chase a value written to `systems`; with no `systems` write there is no drift to chase, which retires
 * the ninth "wired at MINT, not at EDIT" leak by construction rather than by patch.
 *
 * The free-text `ratings`/`solar_size`/`battery_size` parse (`DEVICE_CONFIG_WITH_SPEC_SQL`) is gone for
 * the same reason: it existed to derive `devices.config.spec` FROM those `systems` columns. `config.spec`
 * is now written directly, and the one-shot backfill that populated it historically
 * (`scripts/config-v4/backfill-device-spec.ts`) is deleted — it reports `0 would change` on both
 * environments and its input cannot recur.
 */

/**
 * A patch for {@link updateDevice}.
 *
 * ⚠️ **The field names are deliberately the v3 `systems` ones** (`displayName`, `alias`,
 * `ownerClerkUserId`, `metadata`, …) even though each now writes a differently-named `devices`/`areas`
 * column. That is not laziness: these names are the vocabulary of all ten call sites and of the JSON
 * request bodies those routes parse, so renaming them here would churn ten unrelated files and their
 * tests to no benefit. The mapping to storage is done once, below, where it can be read.
 *
 * It is also a CLOSED shape rather than the old `Partial<Device>`, which accepted any `systems` column —
 * including ones with no `devices` counterpart, which it would have silently dropped.
 */
export type DevicePatch = {
  ownerClerkUserId?: string | null;
  displayName?: string;
  alias?: string | null;
  status?: string;
  vendorSiteId?: string;
  model?: string | null;
  serial?: string | null;
  config?: DeviceConfig | null;
  metadata?: unknown;
  commissionedOn?: string | null;
  /** Placement — written to the device's area-of-one, the sole home for it. */
  location?: AreaLocation | null;
  timezoneOffsetMin?: number;
  displayTimezone?: string;
  /**
   * Accepted and IGNORED: `updated_at` is always stamped to now. Present so callers that build one
   * generic patch object (the admin settings route) still type-check.
   */
  updatedAt?: Date;
};

/** Input shape for creating a device (shared by createDevice and createHelperDevice). */
export type CreateDeviceData = {
  ownerClerkUserId: string | null;
  vendorType: string;
  vendorSiteId: string;
  status?: string;
  displayName: string;
  alias?: string | null;
  model?: string | null;
  serial?: string | null;
  config?: DeviceConfig | null;
  location?: AreaLocation | null;
  metadata?: unknown;
  timezoneOffsetMin?: number;
  displayTimezone?: string;
};

/**
 * What a create returns.
 *
 * 🛑 **`id` is the INTEGER HANDLE (`devices.rid`) — NOT `devices.id`, which is a uuid.** Every caller
 * uses the returned `.id` as a handle: `POST /api/devices` passes it to {@link deleteDevice} on the
 * rollback path, and the Tesla and Enphase OAuth callbacks pass it to `storeTeslaTokens` /
 * `storeEnphaseTokens` as the device id the credentials are filed under. Returning a `devices` row here
 * would swap an int for a uuid at those sites, and because several forward `.id` into `number`-shaped
 * parameters only via inference, **`tsc` does not catch all of them** — it would compile and fail at
 * runtime, which is exactly the shape of the create-path FK defect fixed on 2026-07-27. `deviceUuid` is
 * exposed separately for anything that genuinely wants the v4 identity.
 *
 * Pinned by `lib/registry/__tests__/device-writer-contract.test.ts`.
 */
export type CreatedDevice = {
  /** 🛑 `devices.rid` — the integer handle. Read the type docstring before changing this. */
  id: number;
  /** `devices.id` — the v4 uuid identity. */
  deviceUuid: string;
  deviceId: DeviceId;
  /** The area-of-one minted alongside the device. */
  areaId: string;
  ownerClerkUserId: string | null;
  vendorType: string;
  vendorSiteId: string;
  status: string;
  displayName: string;
  alias: string | null;
};

/**
 * Allocate the integer handle for a new device.
 *
 * Prod draws from `device_rid_seq` EXPLICITLY rather than letting the `devices.rid` column DEFAULT fire,
 * because the value is needed up front — by step 3's `legacy_handles` row, which names it for BOTH the
 * device and its area-of-one. Migration 0049 floored the sequence above `max(systems.id)`, so a value
 * from it cannot collide with a historical handle. (Pre-1a this came from `systems_id_seq` and was copied
 * into `devices.rid` verbatim; `devices.rid`'s own DEFAULT was documented inert precisely because two
 * independent counters were live. 1a leaves exactly one.)
 *
 * Dev keeps the explicit-ids-from-10000 policy, re-based on `max(devices.rid)` now that `systems` is not
 * written. The two allocators cannot cross: dev's floor is 10000 and the sequence sits near
 * `max(systems.id)`, far below it.
 */
async function allocateRid(exec: DeviceRegistryExec): Promise<number> {
  if (!isProduction()) {
    const DEV_RID_START = 10000;
    const [{ maxRid }] = await exec
      .select({ maxRid: max(devices.rid) })
      .from(devices);
    return maxRid && maxRid >= DEV_RID_START ? maxRid + 1 : DEV_RID_START;
  }
  const res = await exec.execute(
    sql`SELECT nextval('device_rid_seq')::int AS rid`,
  );
  const rows = (res as unknown as { rows?: Array<{ rid: number }> }).rows ?? [];
  const rid = Number(rows[0]?.rid);
  if (!Number.isFinite(rid))
    throw new Error("allocateRid: device_rid_seq returned no value");
  return rid;
}

/**
 * Insert a device, its area-of-one, its handle mapping and its membership edge — one transaction.
 *
 * ⚠️⚠️ **THE FOUR-STEP ORDER BELOW IS LOAD-BEARING. Each step is required by the NEXT one's foreign
 * key, and getting it wrong has broken device creation three times.** Read this before reordering:
 *
 *   1. **`areas`** — must precede `devices` because `devices.primary_area_id` is `NOT NULL` and FKs
 *      `areas(id)`. (The area no longer keys on the rid at all — migration 0052 dropped
 *      `areas.legacy_system_id` — but the rid is still allocated up front for `devices.rid` and step 3.)
 *   2. **`devices`** — must precede `legacy_handles` because `legacy_handles.device_id` FKs `devices(id)`
 *      (migration 0036). Violating *this* edge is the 2026-07-27 prod defect: the writer opened by
 *      filling the handle row for a uuid no `devices` row carried yet, so **every first mint of a device
 *      raised 23503** and `POST /api/devices` plus both OAuth connect callbacks 500'd. Re-mints masked
 *      it, because the `ON CONFLICT` `coalesce` preserved the already-valid uuid.
 *   3. **`legacy_handles`** — both columns, device and area, now that both targets exist.
 *   4. **`area_members`** — last, because `area_members.device_id` FKs `devices(id)` AND `area_id` FKs
 *      `areas(id)`; it is the only step needing both rows present.
 *
 * Steps 2-4 are the pre-1a mirror's order, preserved exactly. Step 1 was previously a separate
 * `ensureAreaOfOne` call that read `systems` for the values it is now handed directly.
 */
async function insertDeviceToPg(
  data: CreateDeviceData,
): Promise<CreatedDevice> {
  const pg = requirePlanetscaleDb();
  try {
    return await pg.transaction(async (tx) => {
      const rid = await allocateRid(tx);
      const uuid = Device.toUuid(Device.generate());
      const areaId = Area.toUuid(Area.generate());
      const now = new Date();
      const tzOffset = data.timezoneOffsetMin ?? 600; // AEST
      const tz = data.displayTimezone ?? "Australia/Melbourne";
      const status = data.status || "active";
      const slug = data.alias ?? null;

      // ---- 1. areas (the area-of-one; sole home for tz + location) -------------------------------
      await tx.insert(areas).values({
        id: areaId,
        ownerUserId: data.ownerClerkUserId,
        name: data.displayName,
        slug: null,
        timezoneOffsetMin: tzOffset,
        displayTimezone: tz,
        dayOffsetMin: tzOffset, // canonical fixed-offset day key == the device's offset
        location: data.location ?? null,
        status: "active",
      });

      // ---- 2. devices ---------------------------------------------------------------------------
      await tx.insert(devices).values({
        id: uuid,
        rid,
        ownerUserId: data.ownerClerkUserId,
        vendor: data.vendorType,
        vendorSiteId: data.vendorSiteId,
        status,
        name: data.displayName,
        slug,
        model: data.model ?? null,
        serial: data.serial ?? null,
        primaryAreaId: areaId,
        config: data.config ?? null,
        adapterState: (data.metadata ?? null) as never,
        createdAt: now,
        updatedAt: now,
      });

      // ---- 3. legacy_handles --------------------------------------------------------------------
      await DeviceRegistry.ensureDeviceForHandle(rid, tx, Device.encode(uuid));
      await DeviceRegistry.ensureAreaForHandle(rid, areaId, tx);

      // ---- 4. area_members ----------------------------------------------------------------------
      await tx
        .insert(areaMembers)
        .values({ areaId, deviceId: uuid, ordinal: 0 })
        .onConflictDoNothing();

      return {
        id: rid, // 🛑 the INTEGER handle — see CreatedDevice's docstring
        deviceUuid: uuid,
        deviceId: Device.encode(uuid),
        areaId,
        ownerClerkUserId: data.ownerClerkUserId,
        vendorType: data.vendorType,
        vendorSiteId: data.vendorSiteId,
        status,
        displayName: data.displayName,
        alias: slug,
      };
    });
  } catch (e) {
    // Diagnostic only — the error is rethrown either way and `POST /api/devices` renders it as a 500.
    //
    // config-v4 Phase 14 stage 2b: this was a private `(e as {code?}).code === "23505"` predicate, which
    // drizzle ≥0.44 never satisfies, so the warning NEVER fired and a create that died on a unique
    // violation reached the log with no hint of which one. It now names the violated index, because on
    // this database that name lives in the pg `message` and nowhere else (see `lib/db/pg-error.ts`);
    // `insertDeviceToPg` can trip `devices_owner_slug_unique`, `devices_rid_unique`, `areas_pkey` and
    // both `legacy_handles` uniques, and the old message asserted the first of those unconditionally.
    const violated = violatedUniqueName(e);
    if (violated) {
      console.warn(
        `[DeviceWriter] Postgres unique violation (23505) on ${violated} creating device for user ${data.ownerClerkUserId}: ${uniqueViolationDetail(e) ?? "(no detail)"}`,
      );
    }
    throw e;
  }
}

/**
 * Create a new device.
 *
 * Unlike v3's `createDevice` this DOES mint an area (the area-of-one), because `devices.primary_area_id`
 * is `NOT NULL` — a device with no area is not a representable shape. That is a structural requirement,
 * not a reversal of the "areas are explicit" model, which governs whether a device gets a user-visible
 * grouping and a flow matrix.
 */
async function createDevice(
  deviceData: CreateDeviceData,
): Promise<CreatedDevice> {
  const created = await insertDeviceToPg(deviceData);
  console.log(
    `[DeviceWriter] Created device ${created.id} (${deviceData.vendorType}) for user ${deviceData.ownerClerkUserId}`,
  );
  return created;
}

/**
 * Create a HELPER device — a derived, non-physical, never-polled device (`vendor='helper'`) that lives
 * in an Area and owns the Area's COMPUTED points (battery-provenance blend, …). Its SEMANTIC home is an
 * existing Area, of which it is a MEMBER (wired by `lib/areas/helper.ts::ensureHelperDevice`). Owned by
 * the Area's owner for access control (NOT ownerless — the blend is private household-derived data).
 *
 * It nonetheless gets its own area-of-one, exactly like {@link createDevice}, for the `primary_area_id`
 * reason above. The Area membership is the SECOND edge, not a substitute for it.
 */
async function createHelperDevice(params: {
  ownerClerkUserId: string | null;
  vendorSiteId: string;
  displayName: string;
  timezoneOffsetMin: number;
  displayTimezone: string;
}): Promise<CreatedDevice> {
  const created = await insertDeviceToPg({
    ownerClerkUserId: params.ownerClerkUserId,
    vendorType: "helper",
    vendorSiteId: params.vendorSiteId,
    status: "active",
    displayName: params.displayName,
    alias: null,
    timezoneOffsetMin: params.timezoneOffsetMin,
    displayTimezone: params.displayTimezone,
  });
  console.log(
    `[DeviceWriter] Created helper device ${created.id} (${params.vendorSiteId})`,
  );
  return created;
}

/**
 * Update a device, addressed by its integer handle.
 *
 * Splits across the two tables that now hold what `systems` used to: descriptive/config columns go to
 * `devices`, placement (tz + location) to the device's area-of-one. Both in ONE transaction, so a
 * placement edit can never be half-applied. `updatedAt` is always stamped to now; a caller-supplied one
 * is ignored.
 *
 * ⚠️ `areas.name` is deliberately NOT updated when `displayName` changes. The pre-1a mirror copied
 * `systems.display_name` into `devices.name` only; the area's name was set at mint and never re-copied,
 * and `/api/v4/areas/*` can rename an area independently. Following `displayName` through to `areas.name`
 * would be a NEW behaviour that silently overwrites a user-set area name — out of scope for a
 * conversion, and the kind of blanket copy-down `ensureAreaOfOne` explicitly refused.
 */
async function updateDevice(
  systemId: number,
  patch: DevicePatch,
): Promise<void> {
  const deviceSet: Partial<typeof devices.$inferInsert> = {};
  if (patch.ownerClerkUserId !== undefined)
    deviceSet.ownerUserId = patch.ownerClerkUserId;
  if (patch.displayName !== undefined) deviceSet.name = patch.displayName;
  if (patch.alias !== undefined) deviceSet.slug = patch.alias;
  if (patch.status !== undefined) deviceSet.status = patch.status;
  if (patch.vendorSiteId !== undefined)
    deviceSet.vendorSiteId = patch.vendorSiteId;
  if (patch.model !== undefined) deviceSet.model = patch.model;
  if (patch.serial !== undefined) deviceSet.serial = patch.serial;
  if (patch.config !== undefined) deviceSet.config = patch.config;
  if (patch.metadata !== undefined)
    deviceSet.adapterState = patch.metadata as never;
  if (patch.commissionedOn !== undefined)
    deviceSet.commissionedOn = patch.commissionedOn;
  deviceSet.updatedAt = new Date();

  const areaSet: Partial<typeof areas.$inferInsert> = {};
  if (patch.timezoneOffsetMin !== undefined) {
    areaSet.timezoneOffsetMin = patch.timezoneOffsetMin;
    // `dayOffsetMin` moves with the tz offset, matching `updateAreaMeta` (lib/areas/create.ts) — the
    // area's own writer — rather than inventing a second coupling rule.
    areaSet.dayOffsetMin = patch.timezoneOffsetMin;
  }
  if (patch.displayTimezone !== undefined)
    areaSet.displayTimezone = patch.displayTimezone;
  if (patch.location !== undefined) areaSet.location = patch.location;

  await requirePlanetscaleDb().transaction(async (tx) => {
    await tx.update(devices).set(deviceSet).where(eq(devices.rid, systemId));
    if (Object.keys(areaSet).length > 0) {
      areaSet.updatedAt = new Date();
      // config-v4 Phase 13 PR 5: the target area is located through `legacy_handles`, not the dropped
      // `areas.legacy_system_id`. An UPDATE cannot join, so the handle is resolved to a uuid first —
      // inside the SAME transaction, so it cannot race the `ensureAreaForHandle` in `ensureAreaOfOne`.
      // A handle naming no area updates nothing, exactly as the old 0-row-match predicate did.
      const targets = await DeviceRegistry.resolveHandle(systemId, tx);
      if (targets?.areaId) {
        await tx.update(areas).set(areaSet).where(eq(areas.id, targets.areaId));
      }
    }
  });
}

/**
 * Delete a device, addressed by its integer handle.
 *
 * ⚠️ **Behaviour CHANGED in 1a, deliberately — read this rather than assuming continuity.** Pre-1a this
 * deleted the `systems` row and left the mirrored `devices` row ORPHANED, and that orphan was recorded as
 * load-bearing for the terminal window's FK-coverage gate. Post-1a there is no `systems` row to delete,
 * so "preserve the orphaning" has no referent: `devices` IS the row. Nor is the gate weakened —
 * `devices`-without-`systems` is now the state of EVERY newly created device, since nothing writes
 * `systems` at all, which is exactly why PR 2's G2 treats that direction as report-only rather than
 * fatal. The orphan G2 must tolerate is generic, not this function's.
 *
 * So this now performs the real inverse of {@link insertDeviceToPg}, in reverse FK order: membership
 * edge, then the handle's `device_id`, then the device. Safe because the sole caller is the
 * create-rollback path in `POST /api/devices`, where the device was minted moments earlier.
 *
 * The **area-of-one is intentionally left behind.** Deleting it is not needed for a correct rollback (the
 * slug and the handle's device column are both freed above), and `areas` is referenced by
 * `point_readings_flow_attr_1d` — a table with a deliberate data-loss firewall. Widening a rollback path
 * into that blast radius is slice N's call to make explicitly, not a side effect of this conversion. A
 * stranded area-of-one with no member is inert.
 *
 * ⚠️ **The stranded area is inert but it is not invisible: its `legacy_handles` row still names it.**
 * This function frees the handle's `device_id` and NOT its `area_id`, so handle N keeps resolving to the
 * orphaned area. Re-creating a device on a RECYCLED rid (dev's `allocateRid` is `max(devices.rid)+1`, so
 * deleting the highest device recycles its rid on the very next create) therefore re-collides on that
 * handle. Until migration 0052 the collision surfaced as a 23505 on `areas_legacy_system_unique`;
 * `ensureAreaForHandle` now raises {@link HandleAreaConflictError} in its place, so the alarm is
 * preserved rather than downgraded to a silent mis-mapping. Freeing `area_id` here (or deleting the
 * area) remains out of scope for the reason above — the fix is to make the failure loud, not to widen
 * the rollback's blast radius.
 */
async function deleteDevice(systemId: number): Promise<void> {
  await requirePlanetscaleDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.rid, systemId))
      .limit(1);
    if (!row) return;
    await tx.delete(areaMembers).where(eq(areaMembers.deviceId, row.id));
    await tx.execute(
      sql`UPDATE legacy_handles SET device_id = NULL WHERE device_id = ${row.id}::uuid`,
    );
    await tx.delete(devices).where(eq(devices.rid, systemId));
  });
}

/**
 * The four device writers. A plain object, like `DeviceRegistry` / `DeviceConfigRegistry`.
 *
 * The names keep their v3 spelling (`createDevice`, `updateDevice`, `deleteDevice`) for the same reason
 * {@link DevicePatch} keeps its field names: renaming them is churn across ten call sites that says
 * nothing about storage. Phase 13 re-grammars the whole handle vocabulary at once.
 */
export const DeviceWriter = {
  createDevice,
  createHelperDevice,
  updateDevice,
  deleteDevice,
};
