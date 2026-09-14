import { and, eq, max, ne, sql } from "drizzle-orm";
import { isProduction } from "@/lib/env";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { uniqueViolationDetail, violatedUniqueName } from "@/lib/db/pg-error";
import { areas, devices } from "@/lib/db/planetscale/schema";
import { resolveOnboardingArea } from "@/lib/areas/onboarding";
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
 * ⚠️ **The field names are deliberately the old `systems` ones** (`displayName`, `alias`,
 * `ownerClerkUserId`, `metadata`, …) even though each now writes a differently-named `devices`/`areas`
 * column. That is not laziness: these names are the vocabulary of all ten call sites and of the JSON
 * request bodies those routes parse, so renaming them here would churn ten unrelated files and their
 * tests to no benefit. The mapping to storage is done once, below, where it can be read.
 *
 * It is also a CLOSED shape rather than the old `Partial<Device>`, which accepted any `systems` column —
 * including ones with no `devices` counterpart, which it would have silently dropped.
 */
type DevicePatch = {
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
  /** Placement — written to the device's CURRENT area (`devices.area_id`), the home for it. */
  location?: AreaLocation | null;
  timezoneOffsetMin?: number;
  displayTimezone?: string;
  /**
   * Accepted and IGNORED: `updated_at` is always stamped to now. Present so callers that build one
   * generic patch object (the admin settings route) still type-check.
   */
  updatedAt?: Date;
};

/**
 * Input shape for creating a device (shared by createDevice and createHelperDevice).
 *
 * 🛑 The last three fields are PLACEMENT, and since the area-of-one was retired they no longer all
 * mean the same thing:
 *
 * - `timezoneOffsetMin` seeds `devices.day_offset_min`, the device's own immutable day bucket, and
 *   is therefore always used.
 * - `displayTimezone` and `location` describe the SITE, which lives on an area. They are used only
 *   when {@link resolveOnboardingArea} has to create one; when the owner already has a default area
 *   they are ignored, because that area has its own and overwriting it from a vendor payload would
 *   silently re-place every other device in it.
 */
type CreateDeviceData = {
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
type CreatedDevice = {
  /** 🛑 `devices.rid` — the integer handle. Read the type docstring before changing this. */
  id: number;
  /** `devices.id` — the v4 uuid identity. */
  deviceUuid: string;
  deviceId: DeviceId;
  /**
   * The area the device was placed in — `devices.area_id`. NULL for an OWNERLESS device, which is
   * ambient by design and which nothing may place. This used to be the area-of-one minted alongside
   * the device and was therefore never null.
   */
  areaId: string | null;
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
 * Insert a device and its handle mapping — one transaction, two steps.
 *
 * ⚠️ **THE STEP ORDER IS LOAD-BEARING**, and it is the one edge that remains: `devices` must precede
 * `legacy_handles`, because `legacy_handles.device_id` FKs `devices(id)` (migration 0036). Violating
 * it is the 2026-07-27 prod defect — the writer opened by filling the handle row for a uuid no
 * `devices` row carried yet, so **every first mint of a device raised 23503** and `POST /api/devices`
 * plus both OAuth connect callbacks 500'd. Re-mints masked it, because the `ON CONFLICT` `coalesce`
 * preserved the already-valid uuid.
 *
 * 🛑 **Two of the original four steps are gone, and neither may come back.**
 *
 * The `area_members` row went with Stage 4: membership is `devices.area_id`, written inline below,
 * so the step that needed both rows present no longer exists. Writing that table here would make it
 * disagree with the column everything reads.
 *
 * The **`areas` insert** went with Stage 5. This function used to mint an "area-of-one" per device
 * because `devices.primary_area_id` was NOT NULL; migration 0072 dropped that constraint and 0074
 * drops the column. Placement is now a DECISION, made once by {@link resolveOnboardingArea} and
 * handed in as `areaId` — so this writer no longer creates areas at all, and the `legacy_handles`
 * area leg went with it (an existing area already owns a handle, and `legacy_handles_area_unique`
 * would refuse a second one pointing at it).
 */
async function insertDeviceToPg(
  data: CreateDeviceData,
  areaId: string | null,
): Promise<CreatedDevice> {
  const pg = requirePlanetscaleDb();
  try {
    return await pg.transaction(async (tx) => {
      const rid = await allocateRid(tx);
      const uuid = Device.toUuid(Device.generate());
      const now = new Date();
      const tzOffset = data.timezoneOffsetMin ?? 600; // AEST
      const status = data.status || "active";
      const slug = data.alias ?? null;

      // ---- 1. devices ---------------------------------------------------------------------------
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
        // 🛑 Membership, and it must be set HERE — this insert is the only writer of it on the
        // create path. Between the Stage-3 resolver flip and Stage 4 every newly-minted device
        // landed AMBIENT because the only writer of membership was the `area_members` insert this
        // replaces, and `ensureHelperDevice` — which dedupes on this column — therefore missed on
        // every call and minted a fresh helper for ever.
        //
        // NULL here is not a fallback, it is the OWNERLESS case: an ownerless device is Home
        // Assistant's `entry_type=SERVICE` — an OpenElectricity NEM region, consumed by every area
        // in its state and contained by none — and `assertDevicesRehomable` refuses to place one.
        // Putting it in an area would trap it there: nothing, not even an admin, could take it out
        // again. `createDevice` is what enforces that; see its docstring.
        areaId,
        // The device's OWN day bucket, and IMMUTABLE from here: `point_readings_agg_1d` buckets on
        // this, so re-homing a device between areas must never move it. Only an explicit re-bucket
        // (`POST /api/v4/devices/{id}/change-offset`) may change it. It is seeded from the same
        // `timezoneOffsetMin` the onboarding area gets, which is what migration 0070's backfill
        // wrote for every existing device — but the two are separate columns from here on, and
        // `lib/integrity/ledger.ts` reports rather than repairs a divergence.
        dayOffsetMin: tzOffset,
        config: data.config ?? null,
        adapterState: (data.metadata ?? null) as never,
        createdAt: now,
        updatedAt: now,
      });

      // ---- 2. legacy_handles ---------------------------------------------------------------------
      // 🛑 The DEVICE leg only. The area leg is gone with the mint: an area this device is being
      // placed INTO already has its own handle (`createArea` minted one), and
      // `legacy_handles_area_unique` would refuse a second row naming it — so re-asserting it here
      // would turn every second device in a site into a 23505.
      await DeviceRegistry.ensureDeviceForHandle(rid, tx, Device.encode(uuid));

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
    // 🛑 Names the violated index, and must keep doing both halves of that. A private
    // `(e as {code?}).code === "23505"` predicate is never satisfied by drizzle ≥0.44, so the warning
    // silently never fires; and the name lives in the pg `message` and nowhere else on this database
    // (see `lib/db/pg-error.ts`). `insertDeviceToPg` can trip `devices_owner_slug_unique`,
    // `devices_rid_unique` and `legacy_handles_device_unique`, so asserting one of them
    // unconditionally — as this once did — is a misleading log line.
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
 * Create a new device, and place it.
 *
 * 🛑 **Placement is decided here and nowhere else, and it is not symmetric:**
 *
 * - an **owned** device is ALWAYS placed, via {@link resolveOnboardingArea} — the owner's default
 *   area if they have a usable one, otherwise a site area created for this connection (and recorded
 *   as their default if it is their first). It is never left ambient, because an area is the sole
 *   home of the display timezone and the location, so an ambient onboarding would silently discard
 *   the site address the vendor just handed us.
 * - an **ownerless** device is NEVER placed. It is Home Assistant's `entry_type=SERVICE` — an
 *   OpenElectricity NEM region, consumed by every area in its state and contained by none. There is
 *   no owner to have a default, `assertDevicesRehomable` refuses to move one, and an area minted for
 *   it would be a trap nothing could free it from.
 *
 * This REPLACES the eager area-of-one. Until migration 0072 the mint was structural —
 * `devices.primary_area_id` was NOT NULL, so a device with no area could be represented, resolved
 * and served but not INSERTED — and it produced 14 of prod's 17 areas as one-device shells. What is
 * left is the same outcome for a household connecting their first inverter, arrived at as a
 * decision rather than a constraint, and skipped entirely for everyone it was wrong for.
 */
async function createDevice(
  deviceData: CreateDeviceData,
): Promise<CreatedDevice> {
  const placement = deviceData.ownerClerkUserId
    ? await resolveOnboardingArea(deviceData.ownerClerkUserId, {
        displayName: deviceData.displayName,
        timezoneOffsetMin: deviceData.timezoneOffsetMin ?? 600,
        displayTimezone: deviceData.displayTimezone ?? "Australia/Melbourne",
        location: deviceData.location ?? null,
      })
    : null;
  const created = await insertDeviceToPg(deviceData, placement?.areaId ?? null);
  console.log(
    `[DeviceWriter] Created device ${created.id} (${deviceData.vendorType}) for user ${deviceData.ownerClerkUserId} in area ${
      placement
        ? `${placement.areaId}${placement.createdAreaId ? " (created" + (placement.recordedAsDefault ? ", now their default" : "") + ")" : " (their default)"}`
        : "(none — ownerless, ambient)"
    }`,
  );
  return created;
}

/**
 * Create a HELPER device — a derived, non-physical, never-polled device (`vendor='helper'`) that lives
 * in an Area and owns the Area's COMPUTED points (battery-provenance blend, …). Owned by the Area's
 * owner for access control (NOT ownerless — the blend is private household-derived data).
 *
 * 🛑 It is created **directly in the Area it serves**, which is the whole of its placement. It used
 * to be minted into an area-of-one like every other device and then MOVED by `ensureHelperDevice`,
 * leaving an inert shell behind and opening a window in which the helper existed but was not yet a
 * member — the window the duplicate-helper bug lived in. One insert, one area, no window.
 *
 * The caller passes the Area's own clock so the helper's `day_offset_min` matches the site it
 * derives from; it never creates an area, so it takes no location.
 */
async function createHelperDevice(params: {
  ownerClerkUserId: string | null;
  /** The Area this helper serves and lives in. */
  areaId: string;
  vendorSiteId: string;
  displayName: string;
  timezoneOffsetMin: number;
}): Promise<CreatedDevice> {
  const created = await insertDeviceToPg(
    {
      ownerClerkUserId: params.ownerClerkUserId,
      vendorType: "helper",
      vendorSiteId: params.vendorSiteId,
      status: "active",
      displayName: params.displayName,
      alias: null,
      timezoneOffsetMin: params.timezoneOffsetMin,
    },
    params.areaId,
  );
  console.log(
    `[DeviceWriter] Created helper device ${created.id} (${params.vendorSiteId})`,
  );
  return created;
}

/**
 * Update a device, addressed by its integer handle.
 *
 * Splits across the two tables that now hold what `systems` used to: descriptive/config columns go to
 * `devices`, placement (tz + location) to the device's CURRENT area (`devices.area_id`). Both in ONE
 * transaction, so a placement edit can never be half-applied. `updatedAt` is always stamped to now; a caller-supplied one
 * is ignored.
 *
 * ⚠️ `areas.name` is deliberately NOT updated when `displayName` changes. The pre-1a mirror copied
 * `systems.display_name` into `devices.name` only; the area's name was set at mint and never re-copied,
 * and `/api/v4/areas/*` can rename an area independently. Following `displayName` through to `areas.name`
 * would be a NEW behaviour that silently overwrites a user-set area name — out of scope for a
 * conversion, and the kind of blanket copy-down `ensureAreaOfOne` explicitly refused.
 */
/**
 * Why a DEVICE-addressed write may not change the site's placement.
 *
 * Shared, rather than inlined at each site, because the UI has to state the SAME rule the writer
 * enforces: `DeviceSettingsDialog` disables the timezone and location fields and prints the reason,
 * and a dialog that disagreed with the server would either refuse an edit that would have worked or
 * offer one that 409s on save.
 */
const PLACEMENT_REFUSAL = {
  noArea: "device is not in any site",
  gone: "the site no longer exists",
  otherOwner:
    "this device's site belongs to someone else — edit the site directly",
  shared:
    "this device shares a site with others — edit the site's location/timezone instead",
} as const;

/**
 * May a DEVICE-addressed write change this device's area's placement? Returns a refusal reason, or
 * null when it may.
 *
 * 🛑 Two conditions, and the SECOND one is the one that matters. Occupancy alone is not permission:
 * a device can legitimately be the only ordinary device in an area somebody ELSE owns (Craig's
 * inverter alone in a site Simon owns, alongside Simon's helper), and an Enphase reconnect handing
 * over the vendor's address would then rewrite that owner's site location — the exact operation this
 * guard exists to refuse. So ownership is checked too.
 *
 * 🛑 The area row is locked FOR UPDATE first. Without it the tenant count and the placement write
 * are two statements with a gap: a concurrent `PUT /members` moving a second device in commits
 * between them, and the placement lands on an area that is shared by the time it does. Locking the
 * AREA (not the device) is what serialises against membership changes, because that is the row both
 * sides agree on.
 */
async function placementRefusal(
  tx: DeviceRegistryExec,
  areaId: string,
  systemId: number,
  deviceOwnerUserId: string | null,
): Promise<string | null> {
  const [area] = await tx
    .select({ ownerUserId: areas.ownerUserId })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1)
    .for("update");
  if (!area) return PLACEMENT_REFUSAL.gone;
  if (area.ownerUserId !== deviceOwnerUserId)
    return PLACEMENT_REFUSAL.otherOwner;

  const others = await tx
    .select({ rid: devices.rid })
    .from(devices)
    .where(
      and(
        eq(devices.areaId, areaId),
        ne(devices.rid, systemId),
        ne(devices.vendor, "helper"),
      ),
    )
    .limit(1);
  return others.length > 0 ? PLACEMENT_REFUSAL.shared : null;
}

/**
 * The same question as {@link placementRefusal}, asked WITHOUT a transaction and without writing:
 * which site does this device's timezone and location live on, and may this caller edit them here?
 *
 * For `GET /api/admin/devices/{id}/settings`, so the dialog can render the split the model now has
 * — day offset is the DEVICE's, timezone and location are the SITE's — instead of offering a field
 * that will 409 on save. It duplicates the predicate rather than calling the writer's version
 * because that one takes `FOR UPDATE`, which is right for a write and wrong for a page load; the
 * reason STRINGS are shared so the two cannot drift apart in what they say.
 *
 * ⚠️ Advisory only. It is a read outside any lock, so a site can gain a tenant between this answer
 * and the save — at which point the save refuses, which is the correct end state. Never treat this
 * as the authorization.
 */
async function describeDevicePlacement(systemId: number): Promise<{
  areaId: string | null;
  areaName: string | null;
  editable: boolean;
  reason: string | null;
}> {
  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({
      areaId: devices.areaId,
      deviceOwner: devices.ownerUserId,
      areaName: areas.name,
      areaOwner: areas.ownerUserId,
    })
    .from(devices)
    .leftJoin(areas, eq(areas.id, devices.areaId))
    .where(eq(devices.rid, systemId))
    .limit(1);
  if (!row || !row.areaId)
    return {
      areaId: null,
      areaName: null,
      editable: false,
      reason: PLACEMENT_REFUSAL.noArea,
    };
  const base = { areaId: row.areaId, areaName: row.areaName };
  if (row.areaOwner !== row.deviceOwner)
    return { ...base, editable: false, reason: PLACEMENT_REFUSAL.otherOwner };
  const others = await db
    .select({ rid: devices.rid })
    .from(devices)
    .where(
      and(
        eq(devices.areaId, row.areaId),
        ne(devices.rid, systemId),
        ne(devices.vendor, "helper"),
      ),
    )
    .limit(1);
  return others.length > 0
    ? { ...base, editable: false, reason: PLACEMENT_REFUSAL.shared }
    : { ...base, editable: true, reason: null };
}

/**
 * What happened to the placement half of a patch. `applied: true` when there was nothing to place or
 * the write landed; a `reason` when the caller asked for a placement change that could not be made.
 */
interface PlacementOutcome {
  applied: boolean;
  reason?: string;
}

/**
 * Raised, and ROLLED BACK, when `placement: "require"` cannot be honoured. See {@link updateDevice}.
 */
export class PlacementRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`placement refused: ${reason}`);
    this.name = "PlacementRefusedError";
  }
}

async function updateDevice(
  systemId: number,
  patch: DevicePatch,
  opts: { placement?: "require" | "best-effort" } = {},
): Promise<PlacementOutcome> {
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

  let placement: PlacementOutcome = { applied: true };
  await requirePlanetscaleDb().transaction(async (tx) => {
    await tx.update(devices).set(deviceSet).where(eq(devices.rid, systemId));
    if (Object.keys(areaSet).length > 0) {
      areaSet.updatedAt = new Date();
      // 🛑 The device's CURRENT area (`devices.area_id`) — the same one `DeviceConfigRegistry`
      // resolves placement from. It used to be the handle's area (`legacy_handles`), i.e. the
      // eagerly-minted area-of-one, and once the placement READ moved to `devices.area_id` that
      // became a silent no-op: for any re-homed device, `PATCH /api/admin/devices/{id}/settings`
      // would answer 200, echo the new timezone, and the next GET would return the old one.
      const [current] = await tx
        .select({ areaId: devices.areaId, ownerUserId: devices.ownerUserId })
        .from(devices)
        .where(eq(devices.rid, systemId))
        .limit(1);
      if (!current?.areaId) {
        // An AMBIENT device has no place — that is what ambient means — so there is nowhere to write
        // this. Reported rather than swallowed: the caller was told to change something and nothing
        // changed, and a 200 over the top of that is how a user learns not to trust the form.
        const reason = PLACEMENT_REFUSAL.noArea;
        if (opts.placement === "require")
          throw new PlacementRefusedError(reason);
        placement = { applied: false, reason };
      } else {
        // 🛑 Placement belongs to the SITE. Writing it from a DEVICE-addressed route would let one
        // device's settings — or, worse, an OAuth reconnect handing over a vendor address — re-place
        // every other device in the site, and a site the caller may not own. Refused here rather
        // than authorized at each caller, because there are several and they do not all have a user
        // to ask.
        const refusal = await placementRefusal(
          tx,
          current.areaId,
          systemId,
          // The patch may be re-owning the device in this same call (the Enphase reconnect does);
          // the owner that matters is the one it will HAVE.
          patch.ownerClerkUserId !== undefined
            ? patch.ownerClerkUserId
            : current.ownerUserId,
        );
        if (refusal) {
          // 🛑 `require` ABORTS THE WHOLE PATCH. The device columns were written earlier in this same
          // transaction, so returning a refusal without throwing would commit half of what the caller
          // asked for and then report failure: name and alias persisted, timezone silently not, and
          // a dialog saying it failed. The one caller that genuinely wants the other half —
          // the Enphase reconnect, whose job is the device's owner/name/status — asks for
          // `best-effort` and is told what was skipped.
          if (opts.placement === "require")
            throw new PlacementRefusedError(refusal);
          placement = { applied: false, reason: refusal };
        } else
          await tx
            .update(areas)
            .set(areaSet)
            .where(eq(areas.id, current.areaId));
      }
    }
  });
  return placement;
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
 * So this now performs the real inverse of {@link insertDeviceToPg}, in reverse FK order: the
 * handle's `device_id`, then the device. Safe because the sole caller is the create-rollback path in
 * `POST /api/devices`, where the device was minted moments earlier.
 *
 * **The area the device was placed in is intentionally left behind**, and that is now a smaller
 * statement than it used to be. Before Stage 5 every create minted a private area-of-one and every
 * rollback stranded one; today the device is placed in an area that usually ALREADY EXISTED — the
 * owner's default — and deleting it would take a real site down with a failed connect. In the one
 * case where the create did make an area (the owner's first), leaving it is also what makes the
 * retry land in the same place, because `users.default_area_id` now points at it. A zero-device area
 * is first-class.
 *
 * ⚠️ **The `area_members` step is gone, and must not come back.** Nothing has written that table
 * since Stage 4, and this function's only caller deletes a device created moments earlier, so there
 * can be no row to clear; migration 0074 drops the table, at which point a `DELETE FROM area_members`
 * here would be a 42P01 on the rollback path — the failure mode of a failure path, which is the
 * worst place to learn about one.
 *
 * ⚠️ The `legacy_handles` AREA leg is likewise untouched, and no longer needs to be: a create no
 * longer claims it, so re-creating a device on a RECYCLED rid (dev's `allocateRid` is
 * `max(devices.rid)+1`) can no longer collide with an area this rollback stranded. That was the
 * {@link HandleAreaConflictError} path described here before; it remains reachable from `createArea`,
 * which is the only thing that mints handle→area rows now.
 */
async function deleteDevice(systemId: number): Promise<void> {
  await requirePlanetscaleDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.rid, systemId))
      .limit(1);
    if (!row) return;
    await tx.execute(
      sql`UPDATE legacy_handles SET device_id = NULL WHERE device_id = ${row.id}::uuid`,
    );
    await tx.delete(devices).where(eq(devices.rid, systemId));
  });
}

/**
 * The four device writers, plus the one READ that belongs beside them. A plain object, like
 * `DeviceRegistry` / `DeviceConfigRegistry`.
 *
 * The names keep their original spelling (`createDevice`, `updateDevice`, `deleteDevice`) for the
 * same reason {@link DevicePatch} keeps its field names: renaming them is churn across ten call
 * sites that says nothing about storage.
 *
 * `describeDevicePlacement` is here rather than in a registry because it answers a question only
 * the writer defines — whether THIS write would be refused — and the value of co-locating it is
 * that the refusal strings have one home.
 */
export const DeviceWriter = {
  createDevice,
  createHelperDevice,
  updateDevice,
  deleteDevice,
  describeDevicePlacement,
};
