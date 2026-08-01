/**
 * Stable device identity registry.
 *
 * `legacy_handles` is deliberately a two-column compatibility row: the same old integer may name an
 * Area and a physical device, so device/area writers fill only their own column. Device ids are
 * pre-minted UUIDv7 values and copied verbatim into `devices.id` at cutover.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices, legacyHandles } from "@/lib/db/planetscale/schema";
import { Area, Device, type AreaId, type DeviceId } from "@/lib/ids";
import type { DeviceRid } from "./registry-cache";

type PgDb = ReturnType<typeof requirePlanetscaleDb>;
type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
export type DeviceRegistryExec = PgDb | PgTx;

const asDeviceRid = (n: number): DeviceRid => n as DeviceRid;

export interface DeviceAddr {
  deviceId: DeviceId;
  uuid: string;
  /** Current systems.id; becomes devices.rid at cutover. */
  rid: DeviceRid;
  /** Permanent compatibility handle. */
  handle: number;
}

export class UnknownDeviceIdError extends Error {
  constructor(
    public readonly kind: "device" | "device-handle",
    public readonly id: DeviceId | number,
  ) {
    super(`unknown ${kind}: ${id}`);
    this.name = "UnknownDeviceIdError";
  }
}

function toAddr(row: { handle: number; deviceId: string }): DeviceAddr {
  return {
    deviceId: Device.encode(row.deviceId),
    uuid: row.deviceId,
    rid: asDeviceRid(row.handle),
    handle: row.handle,
  };
}

async function addrsForHandles(
  handles: number[],
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<Map<number, DeviceAddr>> {
  const unique = [...new Set(handles)];
  if (unique.length === 0) return new Map();
  const rows = await exec
    .select({
      handle: legacyHandles.handle,
      deviceId: legacyHandles.deviceId,
    })
    .from(legacyHandles)
    .where(inArray(legacyHandles.handle, unique));
  return new Map(
    rows
      .filter(
        (r): r is { handle: number; deviceId: string } => r.deviceId != null,
      )
      .map((r) => [r.handle, toAddr(r)]),
  );
}

async function addrForHandle(
  handle: number,
  exec?: DeviceRegistryExec,
): Promise<DeviceAddr> {
  const addr = (await addrsForHandles([handle], exec)).get(handle);
  if (!addr) throw new UnknownDeviceIdError("device-handle", handle);
  return addr;
}

async function addrsForDevices(
  ids: DeviceId[],
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<Map<DeviceId, DeviceAddr>> {
  const uuidToId = new Map(ids.map((id) => [Device.toUuid(id), id] as const));
  const uuids = [...uuidToId.keys()];
  if (uuids.length === 0) return new Map();
  const rows = await exec
    .select({
      handle: legacyHandles.handle,
      deviceId: legacyHandles.deviceId,
    })
    .from(legacyHandles)
    .where(inArray(legacyHandles.deviceId, uuids));
  return new Map(
    rows
      .filter(
        (r): r is { handle: number; deviceId: string } => r.deviceId != null,
      )
      .map((r) => {
        const id = uuidToId.get(r.deviceId)!;
        return [id, toAddr(r)];
      }),
  );
}

async function addrForDevice(
  id: DeviceId,
  exec?: DeviceRegistryExec,
): Promise<DeviceAddr> {
  const addr = (await addrsForDevices([id], exec)).get(id);
  if (!addr) throw new UnknownDeviceIdError("device", id);
  return addr;
}

/**
 * Device uuid -> integer handle, read from `devices.rid` rather than `legacy_handles`.
 *
 * Same direction as `addrsForDevices`, different source, and the difference is load-bearing for
 * `area_members` (config-v4 Phase 12 slice H). `area_members.device_id` FKs `devices.id`, so a member's
 * `devices` row is guaranteed to exist and this lookup can never come up short. `legacy_handles` carries
 * NO constraint tying it to either table — slice A found dev sitting two handles behind prod — and a
 * miss there would silently DROP a member from an area's point set rather than raise. The two agree
 * today (18/18 on dev, zero handle<>rid mismatches); this just makes agreement unnecessary.
 *
 * Callers are the membership consumers that still join int-keyed columns (`point_info.system_id`,
 * `systems.id`). Phase 13 moves those to uuid and deletes every one. (`area_bindings` no longer has an
 * int pair — slice E PR 2b / migration 0048.)
 */
async function ridsForDevices(
  ids: DeviceId[],
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<Map<DeviceId, DeviceRid>> {
  const uuidToId = new Map(ids.map((id) => [Device.toUuid(id), id] as const));
  const uuids = [...uuidToId.keys()];
  if (uuids.length === 0) return new Map();
  const rows = await exec
    .select({ id: devices.id, rid: devices.rid })
    .from(devices)
    .where(inArray(devices.id, uuids));
  return new Map(
    rows.map((r) => [uuidToId.get(r.id)!, asDeviceRid(r.rid)] as const),
  );
}

/**
 * Fill a handle's device column without overwriting an existing identity. Returns the authoritative
 * mapping, which may pre-date the supplied candidate.
 *
 * ⚠️ **`candidate` must already have a `devices` row.** `legacy_handles.device_id` FKs `devices(id)`
 * (migration 0036), so this raises 23503 for a brand-new uuid. Do not call it to mint an identity —
 * call `ensureDeviceRow` (lib/registry/v4-mirror.ts), which inserts `devices` first and then comes back
 * here. The `coalesce` on conflict is why the defect only bit the FIRST mint of a handle.
 */
async function ensureDeviceForHandle(
  handle: number,
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
  candidate: DeviceId = Device.generate(),
): Promise<DeviceAddr> {
  const uuid = Device.toUuid(candidate);
  await exec
    .insert(legacyHandles)
    .values({ handle, deviceId: uuid })
    .onConflictDoUpdate({
      target: legacyHandles.handle,
      set: {
        deviceId: sql`coalesce(${legacyHandles.deviceId}, ${uuid}::uuid)`,
      },
    });
  return addrForHandle(handle, exec);
}

/** What an old integer handle names — either or both columns may be filled. */
export interface HandleTargets {
  /** `areas.id`, when this handle addresses an Area. */
  areaId?: string;
  /** The pre-minted device identity, when this handle addresses a physical device. */
  deviceId?: DeviceId;
}

/**
 * Resolve an old integer handle to whatever it names, WITHOUT the structural `isAreaHandle` DB probe.
 *
 * The polymorphic handle used to be disambiguated by a lookup against `areas.legacy_system_id`.
 * `legacy_handles` carries the authoritative mapping (kept current by `createArea` and
 * `ensureAreaOfOne`, inside their own transactions), so the handle resolves in one indexed read against
 * a table that outlives `areas.legacy_system_id`. This is also what backs the permanently-retained
 * `?systemId=N` compatibility alias.
 *
 * ⚠️ **This function states no precedence, and the one live caller is DEVICE-first.** An earlier draft of
 * this comment asserted "area-first, matching today's dispatch order" — that was WRONG about the tree:
 * the v3 resolver was real-row-first, and the serving path keeps that — since Phase 13 PR 2 by asking
 * `deviceByHandle` before `areaByHandle` explicitly (`PointManager._resolvePointsForHandle`). Resolving area-first would silently widen handle 13 from its device's own points to
 * its area's bindings. Any future caller must
 * choose deliberately — the returned `HandleTargets` can carry BOTH.
 */
async function resolveHandle(
  handle: number,
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<HandleTargets | null> {
  const [row] = await exec
    .select({ areaId: legacyHandles.areaId, deviceId: legacyHandles.deviceId })
    .from(legacyHandles)
    .where(eq(legacyHandles.handle, handle))
    .limit(1);
  if (!row) return null;
  if (row.areaId == null && row.deviceId == null) return null;
  return {
    ...(row.areaId != null ? { areaId: row.areaId } : {}),
    ...(row.deviceId != null ? { deviceId: Device.encode(row.deviceId) } : {}),
  };
}

/**
 * Raised when a handle's `legacy_handles.area_id` is already claimed by a DIFFERENT area.
 *
 * 🛑 **This error is the alarm `areas_legacy_system_unique` used to raise, and it exists because
 * migration 0052 removed that index** (config-v4 Phase 13 PR 6). Until then, a handle collision
 * surfaced LOUDLY as a 23505 on the `areas` INSERT. After the drop the `areas` INSERT can no longer
 * collide at all, and `ensureAreaForHandle`'s `coalesce` would have SILENTLY kept the incumbent
 * `area_id` — leaving `legacy_handles.handle` naming one area while `devices.primary_area_id` names
 * another, i.e. an area unreachable via `?systemId=N`. `legacy_handles`' own PK does **not** catch it,
 * precisely because the upsert swallows the conflict. So the outcome is asserted instead.
 *
 * Two reachable collisions, both real:
 *  - two concurrent `createArea` calls allocating the same `max()+1` handle (`createArea` catches this
 *    and re-allocates — that retry used to hang off `areas_legacy_system_unique`);
 *  - a device re-created on a RECYCLED rid after `deleteDevice` left its area-of-one orphaned with the
 *    handle row still pointing at it. Pre-existing (`deleteDevice` deletes neither the `areas` row nor
 *    the `legacy_handles` row); reachable on dev, where `allocateRid` is `max(devices.rid)+1`.
 */
export class HandleAreaConflictError extends Error {
  constructor(
    readonly handle: number,
    readonly wanted: string,
    readonly incumbent: string,
  ) {
    super(
      `legacy_handles.handle ${handle} is already claimed by area ${incumbent}; refusing to point it at ${wanted}`,
    );
    this.name = "HandleAreaConflictError";
  }
}

/**
 * Fill only the area column, preserving a colliding DEVICE mapping on the same handle — then assert the
 * handle really does name `areaId`, throwing {@link HandleAreaConflictError} if it names another area.
 *
 * Idempotent for the same `areaId` (the `coalesce` re-writes the value already there and the check
 * passes), which is what every re-ensure path relies on.
 */
async function ensureAreaForHandle(
  handle: number,
  areaId: string,
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<void> {
  const [row] = await exec
    .insert(legacyHandles)
    .values({ handle, areaId })
    .onConflictDoUpdate({
      target: legacyHandles.handle,
      set: { areaId: sql`coalesce(${legacyHandles.areaId}, ${areaId}::uuid)` },
    })
    .returning({ areaId: legacyHandles.areaId });
  if (row?.areaId !== areaId)
    throw new HandleAreaConflictError(handle, areaId, String(row?.areaId));
}

/**
 * The device uuid for an integer handle, read straight from `devices.rid`.
 *
 * Replaces the four call sites that used `ensureDeviceRow` purely FOR ITS RETURN VALUE
 * (`lib/areas/create.ts` ×2, `lib/areas/helper.ts`, and the point mirror). Those were never mirroring
 * anything — they wanted "handle → device uuid" and got it as a side effect of a `systems` copy. Now
 * that `devices` is the registry rather than a mirror of one, the lookup IS the whole operation.
 *
 * Reads `devices.rid`, NOT `legacy_handles.device_id`, on purpose: `rid` is NOT NULL and uniquely
 * indexed (`devices_rid_unique`), whereas `legacy_handles.device_id` is nullable and is legitimately
 * unfilled for a handle that only ever named an Area. A miss here is a real error, so this throws
 * rather than returning null — every caller is about to use the uuid as an FK target.
 */
async function uuidForRid(
  rid: number,
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<string> {
  const [row] = await exec
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.rid, rid))
    .limit(1);
  if (!row) throw new UnknownDeviceIdError("device-handle", rid);
  return row.id;
}

/**
 * Area uuid -> integer addressing handle, from `legacy_handles.area_id`.
 *
 * The inverse of {@link resolveHandle}'s area leg, and the resolution behind the wire-native
 * `?areaId=ar_…` address (config-v4 Phase 13 PR 1). Reads `legacy_handles`, NOT
 * `areas.legacy_system_id`: the latter is a Phase-13 casualty, whereas `legacy_handles` is the
 * authoritative map both area write paths (`createArea`, `DeviceWriter`) fill inside the area's own
 * transaction. Null when the area has no handle — impossible today (22/22 on `liveone-dev`), but the
 * column is nullable so the caller must 404 rather than assume.
 */
async function handleForArea(
  id: AreaId,
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<number | null> {
  const [row] = await exec
    .select({ handle: legacyHandles.handle })
    .from(legacyHandles)
    .where(eq(legacyHandles.areaId, Area.toUuid(id)))
    .limit(1);
  return row?.handle ?? null;
}

/**
 * Device uuid -> integer addressing handle, from `devices.rid` (see {@link ridsForDevices} for why
 * `rid` and not `legacy_handles.device_id`). Backs the wire-native `?deviceId=dv_…` address.
 */
async function handleForDevice(
  id: DeviceId,
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<number | null> {
  const [row] = await exec
    .select({ rid: devices.rid })
    .from(devices)
    .where(eq(devices.id, Device.toUuid(id)))
    .limit(1);
  return row?.rid ?? null;
}

export const DeviceRegistry = {
  uuidForRid,
  handleForArea,
  handleForDevice,
  addrForHandle,
  addrsForHandles,
  addrForDevice,
  addrsForDevices,
  ridsForDevices,
  resolveHandle,
  ensureDeviceForHandle,
  ensureAreaForHandle,
};
