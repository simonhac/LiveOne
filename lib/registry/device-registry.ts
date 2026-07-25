/**
 * Stable device identity registry.
 *
 * `legacy_handles` is deliberately a two-column compatibility row: the same old integer may name an
 * Area and a physical device, so device/area writers fill only their own column. Device ids are
 * pre-minted UUIDv7 values and copied verbatim into `devices.id` at cutover.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { legacyHandles } from "@/lib/db/planetscale/schema";
import { Device, type DeviceId } from "@/lib/ids";
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
 * Fill a handle's device column without overwriting an existing identity. Returns the authoritative
 * mapping, which may pre-date the supplied candidate.
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
 * Today the polymorphic handle is disambiguated by `SystemsManager.isAreaHandle` — a lookup against
 * `areas.legacy_system_id` — and an area handle is then rendered through the fabricated virtual system
 * `synthesizeAreaView`. Phase 8 deletes both: `legacy_handles` already carries the authoritative mapping
 * (backfilled by `backfill-foundation.ts`, kept current by `registry-populate.ts`), so the handle
 * resolves in one indexed read and every device renders through its real area-of-one.
 *
 * Area-first, matching today's dispatch order: a handle that names BOTH (an area-of-one whose legacy id
 * equals its device's) must resolve as the area, or a `?systemId=N` request would narrow from the area's
 * bindings to the bare device. Callers land in Phase 8 — this is dark until then, and is also what backs
 * the permanently-retained `?systemId=N` compatibility alias.
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

/** Fill only the area column, preserving a colliding device mapping on the same handle. */
async function ensureAreaForHandle(
  handle: number,
  areaId: string,
  exec: DeviceRegistryExec = requirePlanetscaleDb(),
): Promise<void> {
  await exec
    .insert(legacyHandles)
    .values({ handle, areaId })
    .onConflictDoUpdate({
      target: legacyHandles.handle,
      set: { areaId: sql`coalesce(${legacyHandles.areaId}, ${areaId}::uuid)` },
    });
}

export const DeviceRegistry = {
  addrForHandle,
  addrsForHandles,
  addrForDevice,
  addrsForDevices,
  resolveHandle,
  ensureDeviceForHandle,
  ensureAreaForHandle,
};
