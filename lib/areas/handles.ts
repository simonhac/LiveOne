/**
 * Allocate a synthetic **addressing handle** (`areas.legacy_system_id`) for a multi-device area.
 *
 * A multi-device (site) area has NO real `systems` row — it is addressed purely by its integer
 * `legacy_system_id`; `createArea` also registers it in `legacy_handles`, which is what
 * `DeviceConfigRegistry.isAreaHandle` reads (and thus the
 * only shape the point resolver serves via membership/bindings). So a freshly-created site needs a
 * handle that collides with NO real system id and NO existing area handle.
 *
 * We pick `max(max(devices.rid), max(areas.legacy_system_id), BASE) + 1`. `BASE` is a reserved floor
 * that sits clearly above prod serial device rids and the dev id band (10000+), so a synthetic handle
 * can never later collide with a real serial rid. This is a `max()+1` allocation (not a DB sequence —
 * that would be a schema change), guarded at the call site by the `areas_legacy_system_unique` index
 * + a retry.
 *
 * config-v4 slice K2: the device leg reads `max(devices.rid)`, not `max(systems.id)`. The two are equal
 * by the verbatim-rid invariant (`devices.rid == systems.id`, lib/registry/v4-mirror.ts) AND the floor
 * only ever ratchets UP, so the swap cannot lower a handle below a live id even transiently. `systems`
 * drops in the terminal window while `devices.rid` keeps allocating, so reading the dying table here
 * would have made the allocator the last thing standing between the drop and a handle collision.
 */
import { max } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, devices } from "@/lib/db/planetscale/schema";

type Db = ReturnType<typeof requirePlanetscaleDb>;

/** Reserved floor for synthetic area handles — well above prod serial ids and the dev 10000 band. */
export const AREA_HANDLE_BASE = 1_000_000;

/**
 * Compute the next free synthetic area handle. Race-safe only in combination with the
 * `areas_legacy_system_unique` index + a caller retry (two concurrent creates can compute the same
 * value; the loser hits the unique violation and re-allocates — see `createArea`).
 */
export async function allocateAreaHandle(
  db: Db = requirePlanetscaleDb(),
): Promise<number> {
  const [{ maxDeviceRid }] = await db
    .select({ maxDeviceRid: max(devices.rid) })
    .from(devices);
  const [{ maxHandle }] = await db
    .select({ maxHandle: max(areas.legacySystemId) })
    .from(areas);
  return Math.max(maxDeviceRid ?? 0, maxHandle ?? 0, AREA_HANDLE_BASE) + 1;
}
