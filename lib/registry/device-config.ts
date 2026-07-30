/**
 * The device CONFIG registry — `devices` (+ `device_state`, + the area-of-one) read as the primary
 * config source, replacing `SystemsManager`'s eight `systems` reads.
 *
 * ## Why this is a sibling of `device-registry.ts`, not an extension of it
 *
 * `DeviceRegistry` is an ADDRESSING registry: handle ↔ uuid ↔ rid, `legacy_handles`, nothing else. It
 * reads no config column, has no counterpart to any `SystemsManager` method, and is one of the modules
 * the execution plan retains PERMANENTLY ("the seam rule": `registry-cache.ts` owns
 * uuid↔rid↔address). Folding config reads into it would blur exactly the seam that rule exists to keep
 * sharp — and the two have different lifetimes: addressing survives Phase 13, this module absorbs a
 * class that Phase 12 slice K3 deletes. So: same folder, same export barrel, separate file.
 *
 * ## Why the field names are still legacy-shaped
 *
 * `DeviceRecord` is deliberately field-for-field `SystemWithPolling` (minus the three spec columns,
 * which moved into `config.spec` — see below), NOT the `devices` column names. That is not laziness: it
 * makes slice K2's 89-call-site conversion a mechanical `getSystem(h)` → `deviceByHandle(h)` swap whose
 * correctness is checkable by a field-by-field diff (`scripts/config-v4/verify-slice-k1-parity.ts`)
 * rather than by reading 89 diffs. The `system`→`device` FIELD rename is Phase 13's wholesale pass,
 * where it is one rename against one already-converted reader set instead of two moving parts at once.
 *
 * ## What IS here as of slice K3
 *
 * **Area views** (`viewableByHandle` / `isAreaHandle` / `synthesizeAreaView`) — moved off
 * `SystemsManager`. The device leg is unchanged (`deviceByHandle`, i.e. `devices.rid`); only the AREA
 * leg changed source, from the `areas.legacy_system_id` probe to `DeviceRegistry.resolveHandle`
 * (`legacy_handles`, the authoritative handle map, kept current by `createArea` inside the area's own
 * transaction). Precedence stays DEVICE-FIRST — see {@link viewableByHandle}.
 *
 * ## What is NOT here
 *
 * - **Writes.** `devices.rid` is documented inert while `systems_id_seq` still allocates, so `devices`
 *   cannot become the write target until `systems` drops. Reads flip now; writes flip in the terminal
 *   window. This module is read-only by construction.
 * - **`ratings` / `solar_size` / `battery_size`.** `devices` has no counterpart, by design. They are
 *   `config.spec` now (`DeviceSpec`, lib/capabilities/config.ts).
 */
import { cache } from "react";
import { and, eq, getTableColumns, inArray, isNull, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas as pgAreas,
  deviceState as pgDeviceState,
  devices as pgDevices,
} from "@/lib/db/planetscale/schema";
import type { AreaLocation } from "@/lib/areas/types";
import type { DeviceConfig } from "@/lib/capabilities/config";
import { Device, type DeviceId } from "@/lib/ids";
import { getUserIdByUsername } from "@/lib/user-cache";
import { DeviceRegistry } from "./device-registry";
import type { DeviceRid } from "./registry-cache";

/**
 * Operational polling state — a `device_state` row, verbatim.
 *
 * `SystemsManager` reaches this through the `deviceStateByHandle` subquery, which re-keys
 * `device_state` onto the integer handle via `devices.rid` so eight `systems` reads can join it where
 * they used to join `polling_status`. `device_state` is keyed by `devices.id`, so a `devices`-native
 * read joins it directly: the subquery does not move here, it CEASES TO EXIST. (Deleted with the class
 * in K3, not here — K1 changes no call sites.)
 */
export type DevicePollingState = typeof pgDeviceState.$inferSelect;

/**
 * One device's full config, as the serving layer needs it.
 *
 * Field-compatible with `SystemWithPolling` (see the module header). Three columns are absent because
 * `devices` genuinely has no counterpart: `ratings`, `solarSize`, `batterySize` → `config.spec`.
 *
 * `location`, `timezoneOffsetMin` and `displayTimezone` come from the AREA-OF-ONE, not the device:
 * "eager areas — Option A" makes `devices.primary_area_id` NOT NULL and the area the sole home for
 * placement. The join is therefore inner and can never drop a device.
 */
export interface DeviceConfigView {
  // --- SystemWithPolling-compatible surface (see module header) ---
  /** `devices.rid` — still the integer handle, so `?systemId=N` keeps resolving. */
  readonly id: number;
  readonly ownerClerkUserId: string | null;
  readonly vendorType: string;
  readonly vendorSiteId: string;
  readonly status: string;
  readonly displayName: string;
  readonly alias: string | null;
  readonly model: string | null;
  readonly serial: string | null;
  readonly location: AreaLocation | null;
  /** ← `devices.adapter_state` (was `systems.metadata`): adapter-owned credentials/diagnostics. */
  readonly metadata: unknown;
  readonly config: DeviceConfig | null;
  readonly timezoneOffsetMin: number;
  readonly displayTimezone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly commissionedOn: string | null;
  readonly pollingStatus: DevicePollingState | null;
}

/**
 * One device's full config, WITH its v4 identity — what every read in this module returns.
 *
 * The identity is split out from {@link DeviceConfigView} because of ONE caller that cannot supply it:
 * `synthesizeAreaView` (below) fabricates this shape from a multi-device Area, which by definition
 * has no `devices` row and therefore no `deviceId`/`uuid`/`primary_area_id`. Making the identity
 * non-optional on the shape the serving and vendor layers consume would have forced K2 and K3 into a
 * single PR: `getSystem` and `getViewableSystem` converge on the same `system:` parameter in
 * `api-auth.ts`, `serve-data.ts`, `point-manager.ts` and `history/`, so the PARAMETER type has to be
 * satisfiable by both producers before either can move. Splitting the type lets the type conversion
 * land whole-tree in K2 while the area-view RESOLUTION stayed K3's problem. The split OUTLIVES K3: the
 * synthesis MOVED here rather than dying, so `DeviceConfigView` collapses back into `DeviceRecord` only
 * in Phase 13, when the handle stops being polymorphic and an area is addressed as an area.
 *
 * Rule of thumb: a function that only READS config takes `DeviceConfigView`; one that needs to address
 * a real device (points, readings, v4 writes) takes `DeviceRecord`.
 */
export interface DeviceRecord extends DeviceConfigView {
  /** `dv_…` TypeID — the identity every v4 caller should prefer. */
  readonly deviceId: DeviceId;
  /** Raw `devices.id`. Data-layer only; above this seam use `deviceId`. */
  readonly uuid: string;
  /** The device's area-of-one (`devices.primary_area_id`, NOT NULL). */
  readonly primaryAreaId: string;
}

/** The trimmed shape the device switcher renders — mirrors `getSystemsVisibleByUser`'s projection. */
export interface VisibleDevice {
  readonly id: number;
  readonly displayName: string;
  readonly vendorSiteId: string;
  readonly vendorType: string;
  readonly status: string;
  readonly ownerClerkUserId: string | null;
  readonly alias: string | null;
}

type JoinRow = {
  devices: typeof pgDevices.$inferSelect;
  areas: typeof pgAreas.$inferSelect;
  device_state: DevicePollingState | null;
};

/**
 * The one projection every read below shares.
 *
 * `getTableColumns` rather than a bare `.select()`: a projection-less select expands to whatever the
 * RUNNING build declares, which is what made a stale `areas` column name a runtime 42703 instead of a
 * type error (see the `areas` schema comment). Naming the three tables keeps the expansion explicit.
 */
function baseSelect(db = requirePlanetscaleDb()) {
  return db
    .select({
      devices: getTableColumns(pgDevices),
      areas: getTableColumns(pgAreas),
      device_state: getTableColumns(pgDeviceState),
    })
    .from(pgDevices)
    .innerJoin(pgAreas, eq(pgAreas.id, pgDevices.primaryAreaId))
    .leftJoin(pgDeviceState, eq(pgDeviceState.deviceId, pgDevices.id));
}

/** Flatten a devices⋈areas⋈device_state row into the serving shape. */
function toRecord(row: JoinRow): DeviceRecord {
  const d = row.devices;
  return {
    deviceId: Device.encode(d.id),
    uuid: d.id,
    primaryAreaId: d.primaryAreaId,
    id: d.rid,
    ownerClerkUserId: d.ownerUserId,
    vendorType: d.vendor,
    vendorSiteId: d.vendorSiteId,
    status: d.status,
    displayName: d.name,
    alias: d.slug,
    model: d.model,
    serial: d.serial,
    location: row.areas.location,
    metadata: d.adapterState,
    config: d.config ?? null,
    timezoneOffsetMin: row.areas.timezoneOffsetMin,
    displayTimezone: row.areas.displayTimezone,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    commissionedOn: d.commissionedOn,
    pollingStatus: row.device_state,
  };
}

/**
 * The device's rid, as a branded seam key. `DeviceRecord.id` is a plain number so it stays a drop-in
 * for `SystemWithPolling.id`; this is the typed accessor for anything crossing into the readings seam.
 */
export function ridOf(record: DeviceRecord): DeviceRid {
  return record.id as DeviceRid;
}

// ---------------------------------------------------------------------------
// Point lookups — per-request memoized, exactly as SystemsManager's are. React's `cache()` dedupes
// within one request and shares nothing across requests, so config is always fresh; outside a request
// (Jest / scripts) it runs unmemoized.
// ---------------------------------------------------------------------------

const fetchByHandle = cache(
  async (rid: number): Promise<DeviceRecord | null> => {
    const [row] = await baseSelect().where(eq(pgDevices.rid, rid)).limit(1);
    return row ? toRecord(row) : null;
  },
);

const fetchByVendorSite = cache(
  async (vendorSiteId: string): Promise<DeviceRecord | null> => {
    const [row] = await baseSelect()
      .where(eq(pgDevices.vendorSiteId, vendorSiteId))
      .limit(1);
    return row ? toRecord(row) : null;
  },
);

/** One device by its legacy integer handle (`devices.rid`). ← `SystemsManager.getSystem`. */
async function deviceByHandle(handle: number): Promise<DeviceRecord | null> {
  return fetchByHandle(handle);
}

/**
 * One device by vendor site id — first match; vendor site ids are NOT unique (indexed on
 * `systems`/`devices` for OAuth/webhook dedup). ← `SystemsManager.getSystemByVendorSiteId`.
 */
async function deviceByVendorSite(
  vendorSiteId: string,
): Promise<DeviceRecord | null> {
  return fetchByVendorSite(vendorSiteId);
}

/**
 * One device by its owner + slug — the `/device/{username}/{alias}` pretty URL.
 * ← `SystemsManager.getSystemByUsernameAndAlias`, minus the username→Clerk-id hop.
 *
 * Needs NO new index: `devices_owner_slug_unique` already covers `(owner_user_id, slug)`, the exact
 * counterpart of `systems`' `alias_unique`.
 */
async function deviceByOwnerSlug(
  ownerUserId: string,
  slug: string,
): Promise<DeviceRecord | null> {
  const [row] = await baseSelect()
    .where(
      and(eq(pgDevices.ownerUserId, ownerUserId), eq(pgDevices.slug, slug)),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

/** `/device/{username}/{alias}` end to end: resolve the username (cached), then the unique pair. */
async function deviceByUsernameAndSlug(
  username: string,
  slug: string,
): Promise<DeviceRecord | null> {
  const ownerUserId = await getUserIdByUsername(username);
  if (!ownerUserId) return null;
  return deviceByOwnerSlug(ownerUserId, slug);
}

/** All active devices. Inherently fleet-wide (poll-all cron / flow recompute). ← `getActiveSystems`. */
async function activeDevices(): Promise<DeviceRecord[]> {
  const rows = await baseSelect().where(eq(pgDevices.status, "active"));
  return rows.map(toRecord);
}

/**
 * All devices, any status. Inherently fleet-wide — the admin table, which a later phase paginates.
 * Avoid in request-hot paths. ← `getAllSystems`.
 */
async function allDevices(): Promise<DeviceRecord[]> {
  const rows = await baseSelect();
  return rows.map(toRecord);
}

/** Devices owned by a user, any status. ← `getSystemsByOwner`. */
async function devicesByOwner(userId: string): Promise<DeviceRecord[]> {
  const rows = await baseSelect().where(eq(pgDevices.ownerUserId, userId));
  return rows.map(toRecord);
}

/**
 * Devices visible to a user for the switcher: OWNED, PUBLIC (ownerless, readable by everyone), or
 * reached by a DASHBOARD GRANT. ← `getSystemsVisibleByUser`.
 *
 * The granted leg stays HANDLE-TYPED on purpose: `grantedSystemScopeForUser` returns integer handles
 * and keeps doing so until Phase 13 makes the grant scope TypeID-native. Converting it here would be a
 * second moving part in a PR whose whole value is that the diff is checkable.
 *
 * It is also load-bearing for Vercel preview — `reown-dev-data.ts` reowns mirrored devices to the DEV
 * Clerk id and grants the PROD id back, and a preview session authenticates against the LIVE prod
 * Clerk instance, so without it the switcher, the `/dashboard` landing redirect and the area candidate
 * list all go empty.
 *
 * Dynamic import of `lib/dashboard/grants` breaks a module cycle (grants → access → point-manager →
 * back here), the same reason `SystemsManager` and `lib/vendors/amber/client.ts` do it.
 */
async function devicesVisibleByUser(
  userId: string,
  activeOnly: boolean = true,
): Promise<VisibleDevice[]> {
  const db = requirePlanetscaleDb();

  const ownedOrPublic = await baseSelect(db).where(
    or(eq(pgDevices.ownerUserId, userId), isNull(pgDevices.ownerUserId)),
  );

  const byHandle = new Map<number, DeviceRecord>();
  for (const r of ownedOrPublic) {
    const rec = toRecord(r);
    byHandle.set(rec.id, rec);
  }

  const { grantedSystemScopeForUser } = await import("@/lib/dashboard/grants");
  const grantedHandles = [...(await grantedSystemScopeForUser(userId))].filter(
    (h) => !byHandle.has(h),
  );
  if (grantedHandles.length > 0) {
    const granted = await baseSelect(db).where(
      inArray(pgDevices.rid, grantedHandles),
    );
    for (const r of granted) {
      const rec = toRecord(r);
      byHandle.set(rec.id, rec);
    }
  }

  return Array.from(byHandle.values())
    .filter((d) => !activeOnly || d.status === "active")
    .filter((d) => d.displayName && d.vendorSiteId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((d) => ({
      id: d.id,
      displayName: d.displayName,
      vendorSiteId: d.vendorSiteId,
      vendorType: d.vendorType,
      status: d.status,
      ownerClerkUserId: d.ownerClerkUserId,
      alias: d.alias,
    }));
}

/**
 * The user's "primary" visible device — owned-first, else the first visible by display name, else
 * null. Single source of truth for the `/dashboard` landing and `/device` redirects.
 * ← `getPrimaryVisibleSystem`.
 */
async function primaryVisibleDevice(
  userId: string,
): Promise<VisibleDevice | null> {
  const visible = await devicesVisibleByUser(userId, true);
  if (visible.length === 0) return null;
  const owned = visible.filter((d) => d.ownerClerkUserId === userId);
  return owned.length > 0 ? owned[0] : visible[0];
}

// ---------------------------------------------------------------------------
// Area views — the polymorphic-handle leg (← `SystemsManager.getViewableSystem` / `isAreaHandle`).
// ---------------------------------------------------------------------------

/**
 * An "area view" — a {@link DeviceConfigView} synthesized from a multi-device Area whose integer
 * addressing handle has NO device of its own. It is the SERVER-ONLY resolution of that handle for the
 * dashboard data path (points/flow/auth then resolve via `area_bindings` + members); it is deliberately
 * kept OUT of the devices/admin lists. Owns no points and never polls, so device/polling fields are null.
 *
 * `id`/`vendorSiteId` come from the HANDLE the caller asked for, not from `areas.legacy_system_id`: the
 * handle is how we got here (via `legacy_handles`) and `legacy_system_id` is a Phase-13 casualty.
 */
function synthesizeAreaView(
  handle: number,
  area: typeof pgAreas.$inferSelect,
): DeviceConfigView {
  return {
    id: handle,
    ownerClerkUserId: area.ownerUserId,
    vendorType: "area",
    vendorSiteId: `area:${handle}`,
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

/**
 * The Area a handle names, per `legacy_handles` — per-request memoized, like every read above.
 *
 * The discriminator is `DeviceRegistry.resolveHandle`, NOT the old `areas.legacy_system_id` probe.
 * `legacy_handles` is the authoritative handle map (`createArea` fills it inside the area's own
 * transaction; `ensureAreaOfOne` fills it for devices), it is what survives Phase 13, and it is the one
 * place that knows a handle can name BOTH an area and a device. Verified 22/22 areas and 18/18 devices
 * agreeing with `legacy_system_id`/`devices.rid` on `liveone-dev` before the swap.
 */
const fetchAreaForHandle = cache(
  async (handle: number): Promise<typeof pgAreas.$inferSelect | null> => {
    const targets = await DeviceRegistry.resolveHandle(handle);
    if (!targets?.areaId) return null;
    const [area] = await requirePlanetscaleDb()
      .select()
      .from(pgAreas)
      .where(eq(pgAreas.id, targets.areaId))
      .limit(1);
    return area ?? null;
  },
);

/**
 * Resolve a handle for the DASHBOARD DATA PATH: a real device, OR an area view (an area handle with no
 * device of its own). Use this — not `deviceByHandle` — wherever an Area's whole-area data/auth/flow is
 * served; `deviceByHandle` stays device-only (devices/admin/polling).
 *
 * 🔒 **Precedence is DEVICE-FIRST and LOCKED.** A handle can name both an area and a device (handle 13
 * is a real Sigenergy device AND a multi-member area). Today's serving behaviour is real-row-first, so
 * device-first is the behaviour-preserving order; resolving area-first would silently WIDEN handle 13's
 * point set from the device's own 12 points to the area's bindings (6 on device 13 + 6 on the derived
 * helper 16) — a scope change on a shared dashboard, in the direction that removes access. See trap D-l
 * in `docs/plans/config-v4-phase8-cutover.md`, and the standing gate
 * `lib/point/__tests__/point-manager-area-of-one-parity.test.ts`. `DeviceRegistry.resolveHandle`'s own
 * doc argues for area-first; that ordering belongs to Phase 13, where areas are addressed as areas —
 * it must NOT be applied to this compatibility path.
 */
async function viewableByHandle(
  handle: number,
): Promise<DeviceConfigView | null> {
  const device = await deviceByHandle(handle); // device-first — LOCKED, see above
  if (device) return device;
  const area = await fetchAreaForHandle(handle);
  return area ? synthesizeAreaView(handle, area) : null;
}

/** Whether `handle` resolves to an area view (an area handle with no device of its own). */
async function isAreaHandle(handle: number): Promise<boolean> {
  if (await deviceByHandle(handle)) return false; // device-first — LOCKED, see viewableByHandle
  return (await fetchAreaForHandle(handle)) != null;
}

export const DeviceConfigRegistry = {
  deviceByHandle,
  viewableByHandle,
  isAreaHandle,
  deviceByVendorSite,
  deviceByOwnerSlug,
  deviceByUsernameAndSlug,
  activeDevices,
  allDevices,
  devicesByOwner,
  devicesVisibleByUser,
  primaryVisibleDevice,
};
