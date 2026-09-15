/**
 * `hardDeleteDevice` — destroy an archived device and everything it OWNS.
 *
 * ## The twin of `lib/areas/delete.ts`, with one deliberate difference
 *
 * The area verb refuses over every dependent, because an area's dependents all outlive it. A
 * device's do not: `points.device_id` is NOT NULL, so a point cannot exist without its device, and
 * readings cannot exist without their point. "Delete the device but keep its history" is not a state
 * the schema can hold, so refusing over it would make the verb unusable on every device that ever
 * recorded anything — which is all of them.
 *
 * So this deletes what the device OWNS and refuses over what merely REFERENCES it. That line is
 * drawn once, in `deviceDependents` (`lib/integrity/relied-upon.ts`), and this function implements
 * the owned half:
 *
 *   points → their raw readings and both aggregate rollups → the device's poll `sessions` and
 *   `amber_forecast_history` → `device_state` (CASCADE) → the `legacy_handles` device leg → the row
 *
 * 🛑 The two ARCHIVES — `sessions` (verbatim vendor payloads) and `amber_forecast_history` — are
 * owned, and that is a decision rather than a consequence. `./ledger.ts` files both under "records
 * what was true at a moment, and must outlive whatever it described", which is the right rule for a
 * CONFIG delete: deleting an area must not destroy the archive of the devices in it. This is not a
 * config delete. It destroys the device, its points and every reading they ever held, so an archive
 * of that device's vendor traffic outlives nothing — it becomes unreadable rows keyed on a rid that
 * will be reissued. Both are reported in `destroyed` so the operator sees the size of it.
 *
 * Order is forced, not chosen: every one of those FKs is NO ACTION (`./ledger.ts`), so each step
 * exists because the next one cannot run before it.
 *
 * 🛑 The readings go through `ReadingsDao`, not through drizzle here. `lib/devices/` is not on the
 * readings-seam allowlist (`scripts/check-readings-boundary.mjs`), and that is correct — this module
 * decides WHICH points die, the seam decides how their rows do.
 */
import { and, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  amberForecastHistory,
  devices,
  legacyHandles,
  points,
  sessions,
} from "@/lib/db/planetscale/schema";
import { findDependents, type Dependent } from "@/lib/integrity/relied-upon";
import { ReadingsDao } from "@/lib/readings";
import { kv } from "@/lib/kv";
import { deviceSubject, latestValuesKey } from "@/lib/kv-keys";
import { Device } from "@/lib/ids";
import { PointManager } from "@/lib/point/point-manager";

interface HardDeletedDevice {
  id: string;
  name: string;
  /** The integer handle the device held, captured BEFORE the delete — the KV/series keys use it. */
  handle: number | null;
  /** What went with it, so the caller can report a delete rather than assert one. */
  destroyed: {
    points: number;
    rawReadings: number;
    agg5m: number;
    agg1d: number;
    sessions: number;
    amberForecasts: number;
  };
}

/**
 * Deleted, or refused with the reasons. Never both, and never a throw for the ordinary refusal —
 * the same contract as `HardDeleteResult` next door in `lib/areas/delete.ts`.
 */
export type HardDeleteDeviceResult =
  | { ok: true; deleted: HardDeletedDevice }
  | { ok: false; dependents: Dependent[] };

/** Raised when the device was not in the state the delete was decided against. */
export class DeviceNotArchivedError extends Error {
  constructor(readonly deviceId: string) {
    super(`device ${deviceId} is not archived`);
    this.name = "DeviceNotArchivedError";
  }
}

/**
 * Delete an archived device, its points and its history. Returns what went.
 *
 * Throws {@link DeviceNotArchivedError} if the row is not `status = 'archived'` at the moment of the
 * delete — including the case where it was re-activated while the caller was deciding. The check is
 * restated in the final `WHERE` rather than read once and trusted, for the reason `hardDeleteArea`
 * gives: a precondition verified in a separate statement is one that can expire between the two.
 */
export async function hardDeleteDevice(
  deviceUuid: string,
): Promise<HardDeleteDeviceResult> {
  const db = requirePlanetscaleDb();

  const outcome = await db.transaction(async (tx) => {
    // 🛑 THE LOCK IS WHY THIS IS IN A TRANSACTION. `SELECT … FOR UPDATE` on the parent conflicts
    // with the `FOR KEY SHARE` Postgres takes when validating a foreign key on INSERT, so while it
    // is held nothing can commit a new point, session, derivation source, binding or poller against
    // this device. That is what makes the scan below authoritative rather than advisory — the same
    // TOCTOU window `hardDeleteArea` closes, and for the same reason.
    const [locked] = await tx
      .select({ id: devices.id, status: devices.status, rid: devices.rid })
      .from(devices)
      .where(eq(devices.id, deviceUuid))
      .for("update")
      .limit(1);
    if (!locked || locked.status !== "archived")
      throw new DeviceNotArchivedError(deviceUuid);

    // Re-scanned under the lock, on the transaction's own connection.
    const dependents = await findDependents("device", deviceUuid, {
      destructive: true,
      exec: tx,
    });
    if (dependents.length > 0)
      return { refused: dependents } as
        | { refused: Dependent[] }
        | { deleted: HardDeletedDevice };

    // 🛑 LOCK THE POINTS TOO — the device lock is NOT transitive.
    //
    // `SELECT … FOR UPDATE` on `devices` blocks an insert whose FK names the DEVICE. It does nothing
    // about an insert whose FK names one of its POINTS: `area_bindings.point_uid`,
    // `derivations.output_point_id`, `point_commands.point_id` and the readings tables all reference
    // `points`, and Postgres takes its `FOR KEY SHARE` on the point row, not on the device behind it.
    // So without this a binding could commit between the scan and the delete, and the point delete
    // below would raise a raw 23503 instead of returning the refusal this function promises.
    //
    // Locking here rather than in the scan is deliberate: the rows must be held for the whole
    // transaction, and this is the one place that knows which points those are.
    const own = await tx
      .select({ rid: points.rid })
      .from(points)
      .where(eq(points.deviceId, deviceUuid))
      .for("update");
    const pointRids = own.map((p) => p.rid);

    // Owned, innermost first. Each of these is a NO ACTION FK away from blocking the next.
    const rawReadings = await ReadingsDao.deleteRawForPoints(pointRids, tx);
    const { deleted5m, deleted1d } = await ReadingsDao.deleteAggsForPoints(
      pointRids,
      tx,
    );

    // The poll archive. `point_readings.session_id` pointed at these until the line above, so this
    // has to follow the readings; if another device's readings somehow reference one of these
    // sessions the FK refuses here, loudly, which is the right outcome rather than a silent orphan.
    const killedSessions = await tx
      .delete(sessions)
      .where(eq(sessions.deviceRid, locked.rid));

    // The vendor forecast archive, keyed on `device_rid` with a NO ACTION FK. Owned for the same
    // reason `sessions` is: it is this device's own recorded history, it cannot be re-derived, and
    // nothing else can read it once the device is gone. Untreated it is a 23503 on the FINAL
    // statement — the scan passes, the delete runs, and the whole transaction rolls back at the end.
    const killedForecasts = await tx
      .delete(amberForecastHistory)
      .where(eq(amberForecastHistory.deviceRid, locked.rid));

    const killedPoints =
      pointRids.length > 0
        ? await tx
            .delete(points)
            .where(
              and(
                eq(points.deviceId, deviceUuid),
                inArray(points.rid, pointRids),
              ),
            )
        : { rowCount: 0 };

    const [handleRow] = await tx
      .select({ handle: legacyHandles.handle })
      .from(legacyHandles)
      .where(eq(legacyHandles.deviceId, deviceUuid))
      .limit(1);

    // UPDATE, not DELETE: `legacy_handles.device_id` is a NO ACTION FK, and the ROW must survive
    // when it also carries an area leg — nulling one leg of a shared handle is the whole point.
    await tx
      .update(legacyHandles)
      .set({ deviceId: null })
      .where(eq(legacyHandles.deviceId, deviceUuid));

    // 🛑 `status` restated here as well as under the lock. The lock is released at COMMIT, so this
    // is the statement that would notice if the precondition were ever loosened independently.
    const rows = await tx
      .delete(devices)
      .where(and(eq(devices.id, deviceUuid), eq(devices.status, "archived")))
      .returning({ id: devices.id, name: devices.name });

    // Thrown INSIDE the transaction: returning a sentinel and throwing outside would commit the
    // destroyed history of a device that still exists.
    if (rows.length === 0) throw new DeviceNotArchivedError(deviceUuid);

    return {
      deleted: {
        ...rows[0],
        handle: handleRow?.handle ?? null,
        destroyed: {
          points: killedPoints.rowCount ?? 0,
          rawReadings,
          agg5m: deleted5m,
          agg1d: deleted1d,
          sessions: killedSessions.rowCount ?? 0,
          amberForecasts: killedForecasts.rowCount ?? 0,
        },
      },
    } as { refused: Dependent[] } | { deleted: HardDeletedDevice };
  });

  if ("refused" in outcome) return { ok: false, dependents: outcome.refused };
  const { deleted } = outcome;

  // Best-effort, and AFTER the commit — an unconfigured KV (dev) must not fail a delete that has
  // already happened in Postgres.
  //
  // 🛑 The hash is deleted EXPLICITLY, for `hardDeleteArea`'s reason: the subscription registry's GC
  // sweeps per-field over the subjects it finds in SQL, so a subject that no longer exists is never
  // visited and everything it was serving would survive in Redis forever.
  try {
    if (deleted.handle != null)
      PointManager.getInstance().invalidateSeriesCache(deleted.handle);
    await kv.del(latestValuesKey(deviceSubject(Device.encode(deleted.id))));
  } catch (err) {
    console.warn(
      `[hardDeleteDevice] cache invalidation failed for ${deleted.id}; Postgres is already committed`,
      err,
    );
  }

  return { ok: true, deleted };
}
