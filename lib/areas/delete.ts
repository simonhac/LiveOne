/**
 * Hard-deleting an Area — the row, not `status = 'archived'`.
 *
 * ## Why this is a separate file from `create.ts`
 *
 * Because the ORDER is the whole content. An area is referenced by nine FKs with four different
 * `ON DELETE` behaviours (the census is `lib/integrity/ledger.ts`), and exactly one of them has to
 * be dealt with by hand before Postgres will allow the delete at all. Everything else about this
 * function is arranging for that one statement to be correct and for the caches to be told.
 *
 * The dependency refusal lives IN HERE, not in the route, and that placement is the fix for a real
 * defect rather than a preference. It was in the route, one statement before the call — which meant
 * the scan and the delete ran on different connections with a committable gap between them. This
 * function now locks the area row and re-scans under that lock, so "nothing depends on it" is a fact
 * about the instant of the delete rather than about a moment shortly before it.
 *
 * The ARCHIVED-first interlock is checked here too, for the same reason.
 *
 * ## 🛑 `legacy_handles` is UPDATEd, never DELETEd
 *
 * `legacy_handles` has one row per integer handle, and that row can name a device AND an area — the
 * area-of-one shells minted before 0073/0074 share their row with the device they shadowed. On prod,
 * 16 of the 17 empty areas are in exactly that state. `DELETE FROM legacy_handles WHERE area_id = $1`
 * would therefore destroy a LIVE DEVICE's `?systemId=N` mapping, which is a permanently-retained
 * compatibility alias. Nulling the column keeps the device leg answering, which is the documented
 * resolution contract ("device leg first, else area", `lib/registry/device-registry.ts:189`).
 *
 * Keeping the row also protects handle allocation: `allocateAreaHandle` (`./handles.ts`) computes
 * `max(max(devices.rid), max(legacy_handles.handle), 1_000_000) + 1`, so deleting the top row would
 * let the next area re-use an integer that old links still name. A row left with both columns NULL
 * is the intended resting state, not litter.
 *
 * @see `scripts/utils/v4-surface-smoke.ts` `sweepScratchAreas` — the same ordering, discovered the
 * hard way on throwaway areas. It DELETEs the handle row, which is safe only because the areas it
 * sweeps minted their own.
 */
import { and, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, legacyHandles } from "@/lib/db/planetscale/schema";
import { findDependents, type Dependent } from "@/lib/integrity/relied-upon";
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";
import { kv } from "@/lib/kv";
import { areaSubject, latestValuesKey } from "@/lib/kv-keys";
import { Area } from "@/lib/ids";
import { PointManager } from "@/lib/point/point-manager";

interface HardDeletedArea {
  id: string;
  name: string;
  /** The integer handle the area held, if any — captured BEFORE the delete. */
  handle: number | null;
}

/**
 * Deleted, or refused with the reasons. Never both, and never a throw for the ordinary refusal.
 *
 * `HardDeletedArea` is deliberately NOT exported: it is only ever reached through this union, and
 * exporting a name nothing outside this module can use is the kind of finding that makes `knip`
 * noise rather than signal. Consumers destructure `result.deleted`.
 */
export type HardDeleteResult =
  | { ok: true; deleted: HardDeletedArea }
  | { ok: false; dependents: Dependent[] };

/** Raised when the area was not in the state the delete was decided against. */
export class AreaNotArchivedError extends Error {
  constructor(readonly areaId: string) {
    super(`area ${areaId} is not archived`);
    this.name = "AreaNotArchivedError";
  }
}

/**
 * Delete an archived Area and release its handle. Returns what went.
 *
 * Throws {@link AreaNotArchivedError} if the row is not `status = 'archived'` at the moment of the
 * delete — including the case where it was un-archived while the caller was deciding. That check is
 * restated in the `WHERE` rather than read first and trusted, for the same reason
 * `derivation delete` restates `enabled = false`: a precondition verified in a separate statement is
 * a precondition that can expire between the two.
 */
export async function hardDeleteArea(
  areaUuid: string,
): Promise<HardDeleteResult> {
  const db = requirePlanetscaleDb();

  const outcome = await db.transaction(async (tx) => {
    // 🛑 THE LOCK IS THE WHOLE POINT OF DOING THIS IN HERE.
    //
    // `SELECT … FOR UPDATE` on the parent row conflicts with `FOR KEY SHARE`, which is the lock
    // Postgres takes on a parent row when it validates a foreign key on INSERT. So while this is
    // held, nothing can commit a new `area_calendar_tokens`, `area_bindings`,
    // `derived_interval_provenance`, `point_readings_flow_attr_1d` or `battery_provenance_daily`
    // row for this area, and nothing can point a `devices.area_id` or `users.default_area_id` at
    // it. That is what makes the scan below authoritative rather than advisory.
    //
    // Without it the scan and the delete ran on different connections, and the gap between them was
    // enough to let a freshly-minted calendar feed — a live credential — be CASCADEd away by a
    // delete that had just reported nothing depended on the area.
    //
    // ⚠️ It does NOT cover the two non-FK legs (`dashboards.doc`, a helper's `vendor_site_id`),
    // because there is no FK to take a lock through. Their effects are `silently-dropped` and
    // `dangles` — a reference left pointing at nothing — not destruction, so racing them costs a
    // stale reference rather than data.
    const [locked] = await tx
      .select({ id: areas.id, status: areas.status })
      .from(areas)
      .where(eq(areas.id, areaUuid))
      .for("update")
      .limit(1);
    if (!locked || locked.status !== "archived")
      throw new AreaNotArchivedError(areaUuid);

    // Re-scanned under the lock, on the transaction's own connection.
    const dependents = await findDependents("area", areaUuid, {
      destructive: true,
      exec: tx,
    });
    if (dependents.length > 0)
      return { refused: dependents } as
        | { refused: Dependent[] }
        | { deleted: HardDeletedArea };

    // Captured BEFORE the update, because after it there is nothing left to read it from — and the
    // cache invalidation below is keyed on it.
    const [handleRow] = await tx
      .select({ handle: legacyHandles.handle })
      .from(legacyHandles)
      .where(eq(legacyHandles.areaId, areaUuid))
      .limit(1);

    // See the file header: UPDATE, not DELETE. This is the one statement Postgres requires before
    // the delete — `legacy_handles.area_id` is a NO ACTION FK.
    await tx
      .update(legacyHandles)
      .set({ areaId: null })
      .where(eq(legacyHandles.areaId, areaUuid));

    // 🛑 `status` is restated HERE as well as checked under the lock above. Belt and braces is not
    // the reason: the lock is released at COMMIT, so this is the statement that would notice if the
    // predicate were ever loosened independently of the check.
    const rows = await tx
      .delete(areas)
      .where(and(eq(areas.id, areaUuid), eq(areas.status, "archived")))
      .returning({ id: areas.id, name: areas.name });

    // Thrown INSIDE the transaction, on purpose: returning a sentinel and throwing outside would
    // commit the nulled `legacy_handles.area_id` for an area that still exists, silently unhooking
    // a live area from its handle.
    if (rows.length === 0) throw new AreaNotArchivedError(areaUuid);

    return { deleted: { ...rows[0], handle: handleRow?.handle ?? null } } as
      | { refused: Dependent[] }
      | { deleted: HardDeletedArea };
  });

  if ("refused" in outcome) return { ok: false, dependents: outcome.refused };
  const { deleted } = outcome;

  // Best-effort, and AFTER the commit: a KV that is unconfigured (dev) must not fail a delete that
  // has already happened in Postgres.
  //
  // 🛑 Deliberately NOT `refreshAreaServing` (`./create.ts`). That helper resolves the handle FROM
  // `legacy_handles` — the column this function has just nulled — so it would find nothing and the
  // invalidation would silently no-op, leaving the deleted area's series cached and its
  // `area:<handle>:latest` fields served. Passing the captured handle is the whole point.
  try {
    if (deleted.handle != null)
      PointManager.getInstance().invalidateSeriesCache(deleted.handle);

    // 🛑 DELETE THE HASH EXPLICITLY. `buildSubscriptionRegistry`'s `gcAreaLatestFields` sweeps
    // per-FIELD, and it iterates `servedPathsByArea` — the areas the rebuild found in SQL. A deleted
    // area is not in that map, so the sweep never visits its key and every value it was serving
    // survives in Redis forever, readable by `getLatestValuesForSubject(areaSubject(id))`. The GC is
    // built to prune fields from a LIVE area; nothing in it is built to notice an area that stopped
    // existing, which is exactly what this function does.
    await kv.del(latestValuesKey(areaSubject(Area.encode(areaUuid))));

    await buildSubscriptionRegistry();
  } catch (err) {
    console.warn(
      `[areas] post-delete serving refresh for ${areaUuid} failed (KV may be unconfigured in dev):`,
      err,
    );
  }

  return {
    ok: true,
    deleted: { id: deleted.id, name: deleted.name, handle: deleted.handle },
  };
}
