/**
 * The ADDITIVE, DARK half of the config-v4 cutover transform's stage 2 — the single source of truth for
 * populating the v4 registries (`devices`, `points`, `area_members`, `device_state`) from the legacy ones
 * (`systems`, `point_info`, `area_devices`, `polling_status`), minting the areas-of-one, and backfilling
 * `areas.day_offset_min`.
 *
 * Two callers share this so they can NEVER drift again (they diverged once — the live proof was
 * `device_state`'s `DO NOTHING` in the transform vs the `DO UPDATE` refresh here):
 *   - `registry-sync.ts` — runs it DARK on prod at T-7d and again as a top-up just before the window.
 *   - `config-transform.ts` stage 2 — runs it IN the window, on top of whatever registry-sync populated.
 *
 * This module is deliberately SIDE-EFFECT-FREE (no top-level `main()`), so importing it never runs a
 * driver. Callers own the transaction boundary and pass a `RowsExec` that returns already-unwrapped rows
 * — that keeps this module free of drizzle's generic execute() types and works identically for a `db` or a
 * `tx` handle.
 *
 * DELIBERATELY EXCLUDED (stays in `config-transform.ts`, IN-WINDOW only):
 *   - stage 2e's `areas` column RENAMES (owner_clerk_user_id→owner_user_id, display_name→name, alias→slug).
 *     Those break the deployed build, so they must not happen in a dark run.
 *
 * Properties, all deliberate and asserted rather than assumed:
 *   - Idempotent: safe to re-run any number of times (ON CONFLICT / coalesce / guarded DDL throughout).
 *   - Transactional: the CALLER wraps this in one `db.transaction`, so a mid-run abort leaves nothing half
 *     populated.
 *   - `device_state` REFRESHES on conflict (a T-7d populate followed by a window no-op would otherwise hand
 *     the cutover build week-old polling status).
 *   - The seam invariant `points.rid == point_info.rid` is asserted inside the transaction.
 */
import { sql, type SQL } from "drizzle-orm";
import { Area } from "@/lib/ids";

/** Runs an SQL query and returns the already-unwrapped result rows. Both `db` and `tx` adapt to this. */
export type RowsExec = (query: SQL) => Promise<Record<string, unknown>[]>;

/**
 * Conditions the row-count guards cannot detect, checked BEFORE any write. Each returns a count that must be
 * zero. The migration-0056 lesson in CLAUDE.md is that validation belongs in the operation itself, not the
 * operator's head.
 */
export const PREFLIGHTS: { name: string; sql: string; why: string }[] = [
  {
    name: "systems with an unmappable status",
    sql: `SELECT count(*) FROM systems WHERE status NOT IN ('active','disabled','removed')`,
    why: "devices_status_check would reject the row mid-insert",
  },
  {
    name: "legacy_handles.device_id pointing at a missing system",
    sql: `SELECT count(*) FROM legacy_handles lh
           WHERE lh.device_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM systems s WHERE s.id = lh.handle)`,
    why: "the devices↔systems join would silently skip it, then the VALIDATED legacy_handles→devices FK would abort",
  },
  {
    name: "systems with no legacy_handles row",
    sql: `SELECT count(*) FROM systems s
           WHERE NOT EXISTS (SELECT 1 FROM legacy_handles lh WHERE lh.handle = s.id AND lh.device_id IS NOT NULL)`,
    why: "devices is populated by joining legacy_handles; an unmapped system is silently dropped and only the row-count guard would notice — run backfill-foundation.ts --commit first",
  },
  {
    name: "point_info rows whose system has no legacy_handles mapping",
    sql: `SELECT count(*) FROM point_info pi
           WHERE NOT EXISTS (SELECT 1 FROM legacy_handles lh WHERE lh.handle = pi.system_id AND lh.device_id IS NOT NULL)`,
    why: "those points would be silently dropped from the points copy",
  },
  {
    name: "point_info rows with a NULL rid or point_uid",
    sql: `SELECT count(*) FROM point_info WHERE rid IS NULL OR point_uid IS NULL`,
    why: "points.id/rid are copied verbatim — a NULL breaks the seam invariant the hot rewrite depends on",
  },
  {
    name: "duplicate (owner, alias) pairs in systems",
    sql: `SELECT coalesce(sum(c - 1), 0) FROM (
            SELECT count(*) c FROM systems WHERE alias IS NOT NULL
             GROUP BY owner_clerk_user_id, alias HAVING count(*) > 1) d`,
    why: "devices_owner_slug_unique would reject the second row",
  },
];

const scalarOf = (rows: Record<string, unknown>[]) =>
  Number(Object.values(rows[0])[0]);

/** Run every pre-flight; throw naming each failure. Reads only, so a throw rolls back before any write. */
export async function assertPreflights(exec: RowsExec): Promise<void> {
  const failed: string[] = [];
  for (const p of PREFLIGHTS) {
    const n = scalarOf(await exec(sql.raw(p.sql)));
    if (n !== 0) failed.push(`${p.name}: ${n} → ${p.why}`);
  }
  if (failed.length > 0)
    throw new Error(
      `${failed.length} pre-flight(s) failed — refusing to write:\n  ${failed.join("\n  ")}`,
    );
}

/**
 * Populate the v4 registries. The caller MUST wrap this in a single transaction and pass a `RowsExec` bound
 * to that transaction. Excludes the in-window `areas` column renames (see module header).
 */
export async function populateRegistries(exec: RowsExec): Promise<void> {
  const x = (t: string) => exec(sql.raw(t));
  const sc = async (t: string) => scalarOf(await exec(sql.raw(t)));

  // Pre-flights first: a fail rolls the whole transaction back before any write. Guarantees BOTH callers run
  // all six — the transform's stage 2 previously checked only the status one.
  await assertPreflights(exec);

  // 2a. Mint an area-of-one for every area-less device FIRST, so `devices` can carry a non-null
  // primary_area_id from the start. (Filling it later trips NOT NULL on a re-run: ON CONFLICT suppresses
  // UNIQUE violations, not NOT NULL, which is checked before conflict resolution.) tz/location are copied up —
  // post-cutover the area is the SOLE home for placement.
  const areaLess = await exec(
    sql.raw(`SELECT s.id AS handle, s.owner_clerk_user_id AS owner, s.display_name AS name,
                    s.timezone_offset_min AS tzoff, s.display_timezone AS tz, s.location AS loc
               FROM systems s
              WHERE NOT EXISTS (SELECT 1 FROM areas a WHERE a.legacy_system_id = s.id)`),
  );
  for (const r of areaLess) {
    const areaId = Area.toUuid(Area.generate());
    await exec(sql`
      INSERT INTO areas (id, owner_clerk_user_id, legacy_system_id, display_name, alias,
                         timezone_offset_min, display_timezone, day_offset_min, location, status,
                         created_at, updated_at)
      VALUES (${areaId}, ${r.owner}, ${r.handle}, ${r.name}, NULL,
              ${r.tzoff}, ${r.tz}, ${r.tzoff}, ${r.loc as object}, 'active', now(), now())
      ON CONFLICT (id) DO NOTHING`);
    await exec(
      sql`INSERT INTO area_devices (area_id, system_id, ordinal)
          VALUES (${areaId}, ${r.handle}, 0) ON CONFLICT DO NOTHING`,
    );
    await exec(
      sql`UPDATE legacy_handles SET area_id = coalesce(area_id, ${areaId}::uuid) WHERE handle = ${r.handle}`,
    );
  }
  if (areaLess.length)
    console.log(`  minted ${areaLess.length} area(s)-of-one`);

  // areas.day_offset_min: backfill + NOT NULL. (The v4 COLUMN RENAMES stay in the window — they break the
  // deployed build, so they must not happen in a dark run.)
  await x(
    "UPDATE areas SET day_offset_min = timezone_offset_min WHERE day_offset_min IS NULL",
  );
  if ((await sc("SELECT count(*) FROM areas WHERE day_offset_min IS NULL")) > 0)
    throw new Error("areas.day_offset_min still NULL after backfill");
  await x("ALTER TABLE areas ALTER COLUMN day_offset_min SET NOT NULL");

  // 2b. devices ← systems (id from the pre-minted legacy_handles.device_id; rid = systems.id verbatim).
  await x(`
    INSERT INTO devices (id, rid, owner_user_id, vendor, vendor_site_id, status, name, slug, model, serial,
                         primary_area_id, config, adapter_state, commissioned_on, created_at, updated_at)
    SELECT lh.device_id, s.id, s.owner_clerk_user_id, s.vendor_type, s.vendor_site_id, s.status,
           s.display_name, s.alias, s.model, s.serial,
           (SELECT a.id FROM areas a WHERE a.legacy_system_id = s.id),
           coalesce(s.config, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
             'legacyRatings', s.ratings, 'legacySolarSize', s.solar_size, 'legacyBatterySize', s.battery_size)),
           s.metadata, s.commissioned_on, s.created_at, s.updated_at
      FROM systems s JOIN legacy_handles lh ON lh.handle = s.id
     WHERE lh.device_id IS NOT NULL
    ON CONFLICT (id) DO NOTHING`);
  const [dev, sys] = [
    await sc("SELECT count(*) FROM devices"),
    await sc("SELECT count(*) FROM systems"),
  ];
  if (dev !== sys) throw new Error(`devices(${dev}) != systems(${sys})`);

  // 2c. Seed device_rid_seq past the highest copied rid; tighten primary_area_id; wire the deferred FK.
  await x(
    "SELECT setval('device_rid_seq', (SELECT coalesce(max(rid),0) FROM devices), true)",
  );
  const orphan = await sc(
    "SELECT count(*) FROM devices WHERE primary_area_id IS NULL",
  );
  if (orphan > 0) throw new Error(`${orphan} devices have no area-of-one`);
  await x("ALTER TABLE devices ALTER COLUMN primary_area_id SET NOT NULL");
  await x(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legacy_handles_device_id_devices_fk') THEN
      ALTER TABLE legacy_handles ADD CONSTRAINT legacy_handles_device_id_devices_fk
        FOREIGN KEY (device_id) REFERENCES devices(id);
    END IF; END $$`);

  // 2f. area_members ← area_devices (system_id int → device uuid).
  await x(`
    INSERT INTO area_members (area_id, device_id, ordinal)
    SELECT ad.area_id, lh.device_id, ad.ordinal
      FROM area_devices ad
      JOIN legacy_handles lh ON lh.handle = ad.system_id AND lh.device_id IS NOT NULL
    ON CONFLICT DO NOTHING`);
  const [am, adMapped] = [
    await sc("SELECT count(*) FROM area_members"),
    await sc(`SELECT count(*) FROM area_devices ad
                JOIN legacy_handles lh ON lh.handle = ad.system_id AND lh.device_id IS NOT NULL`),
  ];
  if (am !== adMapped)
    throw new Error(`area_members(${am}) != mapped area_devices(${adMapped})`);

  // 2g. device_state ← polling_status. REFRESHES on conflict: this runs days before the window, and DO
  // NOTHING would leave the cutover build reading week-old polling status.
  await x(`
    INSERT INTO device_state (device_id, last_poll_time, last_success_time, last_error_time, last_error,
                              last_response, consecutive_errors, total_polls, successful_polls, updated_at)
    SELECT lh.device_id, ps.last_poll_time, ps.last_success_time, ps.last_error_time, ps.last_error,
           ps.last_response, ps.consecutive_errors, ps.total_polls, ps.successful_polls, ps.updated_at
      FROM polling_status ps JOIN legacy_handles lh ON lh.handle = ps.system_id AND lh.device_id IS NOT NULL
    ON CONFLICT (device_id) DO UPDATE SET
      last_poll_time = EXCLUDED.last_poll_time, last_success_time = EXCLUDED.last_success_time,
      last_error_time = EXCLUDED.last_error_time, last_error = EXCLUDED.last_error,
      last_response = EXCLUDED.last_response, consecutive_errors = EXCLUDED.consecutive_errors,
      total_polls = EXCLUDED.total_polls, successful_polls = EXCLUDED.successful_polls,
      updated_at = EXCLUDED.updated_at`);

  // 2h. points ← point_info (id = point_uid, rid = point_info.rid — BOTH verbatim; the seam invariant).
  // NB the DB column point_info."id" is the TS field `index` (a per-device address), NOT a uuid.
  await x(`
    INSERT INTO points (id, rid, device_id, physical_path, logical_path, metric_type, unit, name,
                        default_name, subsystem, transform, active, created_at, updated_at)
    SELECT pi.point_uid, pi.rid, lh.device_id, pi.physical_path_tail, pi.logical_path_stem, pi.metric_type,
           pi.metric_unit, pi.display_name, pi.point_name, pi.subsystem, pi.transform, pi.active,
           pi.created_at, pi.updated_at
      FROM point_info pi JOIN legacy_handles lh ON lh.handle = pi.system_id AND lh.device_id IS NOT NULL
    ON CONFLICT (id) DO NOTHING`);
  const [pts, pinfo] = [
    await sc("SELECT count(*) FROM points"),
    await sc("SELECT count(*) FROM point_info"),
  ];
  if (pts !== pinfo) throw new Error(`points(${pts}) != point_info(${pinfo})`);

  // The seam invariant, asserted rather than assumed.
  const ridMismatch = await sc(`
    SELECT count(*) FROM points p JOIN point_info pi ON pi.point_uid = p.id WHERE p.rid <> pi.rid`);
  if (ridMismatch > 0)
    throw new Error(`${ridMismatch} points.rid != point_info.rid`);
}
