/**
 * A before/after snapshot of the config a live smoke run can damage, and the restore that undoes it.
 *
 * ## Why this is a whole-table snapshot and not a list of devices
 *
 * 🛑 Both live smoke scripts borrow REAL devices from the shared `liveone-dev` database. Since the
 * device→0..1-area change that borrowing is DESTRUCTIVE in two ways at once: moving a device into a
 * scratch area takes it out of its real one (`devices.area_id`), and it deletes that area's
 * `area_bindings` onto the device's points. Bindings are authored by hand and nothing rebuilds them.
 *
 * The obvious fix — capture the devices the script names — was tried and was wrong TWICE:
 *
 *   1. First cut restored `devices.area_id` only. A run destroyed 23 real bindings on `liveone-dev`
 *      and reported `✅ ALL CHECKS PASSED`, because membership came back byte-identical.
 *   2. Second cut captured bindings too — for `deviceA` and `deviceB`. It missed
 *      `fixture.helperDevice`, which a later assertion also moves, so a successful run still deleted
 *      that helper's six blend bindings.
 *
 * Both failures are the same failure: an ENUMERATION of what to protect, maintained by hand, next to
 * a script that grows. So this does not enumerate. It copies both tables — on this database that is
 * ~18 devices and ~100 bindings, i.e. nothing — and puts them back. A script cannot forget to add a
 * device to a set it does not have.
 *
 * ## And it is written to disk before anything moves
 *
 * The snapshot used to live only in memory, so a `SIGKILL` between the first move and the `finally`
 * destroyed the only copy of the wiring the run had just deleted. The journal below is written
 * BEFORE the first mutation and deleted only after a clean restore, so an interrupted run leaves the
 * evidence on disk and `restoreWorld` can be re-run against it.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaBindings, areas, devices } from "@/lib/db/planetscale/schema";

/**
 * One binding, reduced to the columns that MEAN something.
 *
 * 🛑 `id`, `created_at` and `updated_at` are deliberately absent, and their absence is what makes the
 * journal work at all. A snapshot round-trips through `JSON.stringify`, which turns a `Date` into a
 * string — and drizzle's timestamp mapper then calls `.toISOString()` on that string and throws, so
 * every restore FROM A JOURNAL failed while the in-memory path (real `Date` objects) passed. The
 * columns are also not identity: `area_bindings`' natural key is
 * `(area_id, role, metric_type, point_uid)`, which is what the re-insert conflicts on, and the
 * prod→dev sync excludes `id` for exactly the same reason.
 */
export interface BindingSnapshot {
  areaId: string;
  role: string;
  metricType: string;
  pointUid: string;
  ordinal: number;
  priority: number;
  transform: string | null;
}

export interface WorldSnapshot {
  capturedAt: string;
  /** `devices.id` → the area it was in. */
  placements: [string, string | null][];
  bindings: BindingSnapshot[];
}

/**
 * Capture, and journal to `journalPath` before returning — the caller must not mutate anything until
 * this has resolved.
 */
export async function captureWorld(
  journalPath: string,
): Promise<WorldSnapshot> {
  const db = requirePlanetscaleDb();
  const [devRows, bindRows] = await Promise.all([
    db.select({ id: devices.id, areaId: devices.areaId }).from(devices),
    db
      .select({
        areaId: areaBindings.areaId,
        role: areaBindings.role,
        metricType: areaBindings.metricType,
        pointUid: areaBindings.pointUid,
        ordinal: areaBindings.ordinal,
        priority: areaBindings.priority,
        transform: areaBindings.transform,
      })
      .from(areaBindings),
  ]);
  const snap: WorldSnapshot = {
    capturedAt: new Date().toISOString(),
    placements: devRows.map((d) => [d.id, d.areaId]),
    bindings: bindRows,
  };
  writeFileSync(journalPath, JSON.stringify(snap), "utf8");
  return snap;
}

/**
 * Put both tables back. Returns false if anything could not be restored — the caller must treat that
 * as a FAILING RUN and must not proceed to delete scratch areas, because the snapshot is the only
 * record of where the devices belong.
 *
 * 🛑 Bindings whose area no longer exists are SKIPPED, not an error. Nothing in a snapshot taken
 * before the run can reference a scratch area (none existed yet), so a missing area here means the
 * operator deleted a real one during the run — which is their business, not a restore failure.
 */
export async function restoreWorld(snap: WorldSnapshot): Promise<boolean> {
  const db = requirePlanetscaleDb();
  let ok = true;

  for (const [id, areaId] of snap.placements) {
    try {
      await db
        .update(devices)
        .set({ areaId })
        .where(inArray(devices.id, [id]));
    } catch (err) {
      console.error(`  ! could not restore device ${id} → ${areaId}:`, err);
      ok = false;
    }
  }

  const liveAreas = new Set(
    (await db.select({ id: areas.id }).from(areas)).map((a) => a.id),
  );
  for (const b of snap.bindings) {
    if (!liveAreas.has(b.areaId)) continue;
    try {
      await db
        .insert(areaBindings)
        .values(b)
        .onConflictDoNothing({
          target: [
            areaBindings.areaId,
            areaBindings.role,
            areaBindings.metricType,
            areaBindings.pointUid,
          ],
        });
    } catch (err) {
      console.error(
        `  ! could not restore binding ${b.areaId}/${b.role}/${b.metricType}:`,
        err,
      );
      ok = false;
    }
  }
  return ok;
}

/** Re-read a journal left behind by an interrupted run, if there is one. */
export function readJournal(journalPath: string): WorldSnapshot | null {
  if (!existsSync(journalPath)) return null;
  try {
    return JSON.parse(readFileSync(journalPath, "utf8")) as WorldSnapshot;
  } catch {
    return null;
  }
}

export function clearJournal(journalPath: string): void {
  try {
    unlinkSync(journalPath);
  } catch {
    /* already gone */
  }
}
