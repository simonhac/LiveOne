/**
 * Allocate a synthetic **addressing handle** (`areas.legacy_system_id`) for a multi-device area.
 *
 * A multi-device (site) area has NO real `systems` row — it is addressed purely by its integer
 * `legacy_system_id`, which is the only shape `SystemsManager.isAreaHandle` recognises (and thus the
 * only shape the point resolver serves via membership/bindings). An area-of-one, by contrast, reuses
 * its device's real `systems.id` as the handle. So a freshly-created site needs a handle that collides
 * with NO real system id and NO existing area handle.
 *
 * We pick `max(max(systems.id), max(areas.legacy_system_id), BASE) + 1`. `BASE` is a reserved floor
 * that sits clearly above prod serial system ids and the dev id band (10000+), so a synthetic handle
 * can never later collide with a real serial `systems.id`. This is a `max()+1` allocation (not a DB
 * sequence — that would be a schema change), guarded at the call site by the `areas_legacy_system_unique`
 * index + a retry, exactly like `ensureAreaOfOne`'s handle race handling.
 */
import { max } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, systems } from "@/lib/db/planetscale/schema";

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
  const [{ maxSystemId }] = await db
    .select({ maxSystemId: max(systems.id) })
    .from(systems);
  const [{ maxHandle }] = await db
    .select({ maxHandle: max(areas.legacySystemId) })
    .from(areas);
  return Math.max(maxSystemId ?? 0, maxHandle ?? 0, AREA_HANDLE_BASE) + 1;
}
