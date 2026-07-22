#!/usr/bin/env tsx
/**
 * ⚠️ ABANDONED 2026-07-22 — DO NOT RUN. Superseded by the approved config-v4 clean-sheet redesign
 * (Option A: eager areas). config-v4 KEEPS and re-mints the implied areas-of-one this script would
 * delete — they hold the only tz/location and the uuid-keyed flow_attr_1d / battery_provenance_daily
 * history the cutover preserves. Retained for historical context only. See
 * docs/plans/config-v4-clean-sheet.md §14 and docs/plans/config-v4-execution-plan.md.
 *
 * Part A2 of the areas cleanup: retire the implied "area-of-one" rows + the stray "Kuti House"
 * composite. Areas are EXPLICIT now (A1 removed the eager mint + lazy heal + flow-for-devices), so these
 * rows are inert duplicates. DELETES areas {1,2,3,4,5,6,9,10,11,12,14, 1000001} and their orphaned
 * device flow/provenance rows; KEEPS the real areas {7,8,13,1000002}.
 *
 * SAFETY: dry-run by default (read-only, prints the full plan). `--apply` writes, and additionally
 * requires CONFIRM_DELETE to be a substring of the printed [DB] identity — so you must have SEEN which
 * database you're deleting from. Aborts if the expected KEEP areas are missing, or if any doomed area
 * has bindings / a dashboard reference / a device-tracker / a run-period (nothing should — belt & braces).
 *
 * ORDER: A1 must be DEPLOYED first (else the old enumeration/heal regenerates these). 1000001 is deleted
 * first so the Kutis(13) flow-eligibility predicate becomes correct immediately.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/cleanup/retire-implied-areas.ts            # dry run (dev)
 *   CONFIRM_DELETE=<db-substring> npx tsx --env-file=.env.local scripts/cleanup/retire-implied-areas.ts --apply
 *   # prod: point PLANETSCALE_DATABASE_URL at the sydney branch, re-confirm the [DB] line, then --apply.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { planetscaleDb } from "../../lib/db/planetscale";

/** Real areas that MUST survive (a sanity anchor — their absence means wrong DB / partial run). */
const KEEP = [7, 8, 13, 1000002];
/** Implied area-of-one rows + the stray Kuti House composite. 1000001 first (fixes Kutis predicate). */
const DOOMED = [1000001, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 14];

const APPLY = process.argv.includes("--apply");
const inList = (hs: number[]) =>
  sql.join(
    hs.map((h) => sql.raw(String(h))),
    sql`, `,
  );

interface DoomedRow {
  handle: number;
  uuid: string;
  name: string;
  flowattr: number;
  bpdaily: number;
  bindings: number;
  members: number;
  trackers: number;
  runperiods: number;
  dashrefs: number;
}

async function main() {
  const db = planetscaleDb;
  if (!db)
    throw new Error("No Postgres connection (run with --env-file=.env.local)");

  const [ident] = (
    await db.execute(sql`SELECT current_user AS usr, current_database() AS db`)
  ).rows as { usr: string; db: string }[];
  const identity = `${ident?.usr}/${ident?.db}`;
  console.log(
    `\n[DB] ${identity}    ${APPLY ? "*** APPLY (WILL DELETE) ***" : "[DRY-RUN]"}`,
  );
  console.log(`KEEP:   ${KEEP.join(", ")}`);
  console.log(`DOOMED: ${DOOMED.join(", ")}\n`);

  // Anchor: every KEEP area must exist. If not, we're on the wrong DB or a partial run — refuse.
  const keepFound = new Set(
    (
      (
        await db.execute(
          sql`SELECT legacy_system_id AS h FROM areas WHERE legacy_system_id IN (${inList(KEEP)})`,
        )
      ).rows as { h: number }[]
    ).map((r) => Number(r.h)),
  );
  const keepMissing = KEEP.filter((h) => !keepFound.has(h));
  if (keepMissing.length)
    throw new Error(
      `ABORT: expected KEEP areas missing: ${keepMissing.join(", ")} — wrong DB or already-mutated? Refusing.`,
    );

  // `point_readings_flow_1d` was retired (migration 0029) and this script no longer touches it. If the
  // table still exists its RESTRICT FK to `areas` would block the areas delete below, so refuse until
  // 0029 has been applied to this database.
  const flow1dGone =
    (
      (
        await db.execute(
          sql`SELECT to_regclass('public.point_readings_flow_1d') IS NULL AS gone`,
        )
      ).rows as unknown as { gone: boolean }[]
    )[0]?.gone === true;
  if (!flow1dGone)
    throw new Error(
      "ABORT: point_readings_flow_1d still exists — apply migration 0029 (drop flow_1d) before running this cleanup.",
    );

  const rows = (
    await db.execute(sql`
    SELECT a.legacy_system_id AS handle, a.id AS uuid, a.display_name AS name,
      (SELECT count(*)::int FROM point_readings_flow_attr_1d f WHERE f.area_id=a.id) AS flowattr,
      (SELECT count(*)::int FROM battery_provenance_daily b    WHERE b.area_id=a.id) AS bpdaily,
      (SELECT count(*)::int FROM area_bindings b               WHERE b.area_id=a.id) AS bindings,
      (SELECT count(*)::int FROM area_devices d                WHERE d.area_id=a.id) AS members,
      (SELECT count(*)::int FROM device_trackers t            WHERE t.area_id=a.id) AS trackers,
      (SELECT count(*)::int FROM device_run_periods r         WHERE r.area_id=a.id) AS runperiods,
      (SELECT count(*)::int FROM dashboards d WHERE d.descriptor::text LIKE '%' || a.id || '%') AS dashrefs
    FROM areas a WHERE a.legacy_system_id IN (${inList(DOOMED)})
  `)
  ).rows as unknown as DoomedRow[];

  const byHandle = new Map<number, DoomedRow>(
    rows.map((r) => [Number(r.handle), r]),
  );

  // Belt & braces: nothing doomed should have bindings, a dashboard ref, a tracker, or a run-period.
  const blockers = rows.filter(
    (r) =>
      Number(r.bindings) > 0 ||
      Number(r.dashrefs) > 0 ||
      Number(r.trackers) > 0 ||
      Number(r.runperiods) > 0,
  );
  if (blockers.length) {
    for (const b of blockers)
      console.error(
        `  BLOCKER handle=${b.handle} "${b.name}" bindings=${b.bindings} dashrefs=${b.dashrefs} trackers=${b.trackers} runperiods=${b.runperiods}`,
      );
    throw new Error(
      "ABORT: a doomed area has bindings / a dashboard ref / a tracker / a run-period — investigate before deleting.",
    );
  }

  // Plan preview.
  let tFlowAttr = 0,
    tBp = 0,
    tAreas = 0;
  for (const h of DOOMED) {
    const r = byHandle.get(h);
    if (!r) {
      console.log(
        `  handle ${String(h).padEnd(8)} — no area row (already gone)`,
      );
      continue;
    }
    tFlowAttr += Number(r.flowattr);
    tBp += Number(r.bpdaily);
    tAreas += 1;
    console.log(
      `  handle ${String(h).padEnd(8)} "${r.name}"  flowattr=${r.flowattr} bp=${r.bpdaily} members=${r.members}  ${r.uuid}`,
    );
  }
  console.log(
    `\nTOTAL: ${tAreas} areas, ${tFlowAttr} flow_attr_1d + ${tBp} battery_provenance_daily rows (area_bindings/area_devices cascade)\n`,
  );

  if (!APPLY) {
    console.log("Dry run — pass --apply (with CONFIRM_DELETE) to delete.\n");
    return;
  }

  const confirm = process.env.CONFIRM_DELETE;
  if (!confirm || !identity.includes(confirm))
    throw new Error(
      `ABORT: set CONFIRM_DELETE to a substring of the connection identity "${identity}" to apply.`,
    );

  for (const h of DOOMED) {
    const r = byHandle.get(h);
    if (!r) continue;
    if (KEEP.includes(h))
      throw new Error(`refusing to delete KEEP handle ${h}`); // unreachable guard
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM point_readings_flow_attr_1d WHERE area_id = ${r.uuid}`,
      );
      await tx.execute(
        sql`DELETE FROM battery_provenance_daily WHERE area_id = ${r.uuid}`,
      );
      // area_bindings + area_devices cascade on the areas delete (onDelete: cascade).
      await tx.execute(
        sql`DELETE FROM areas WHERE id = ${r.uuid} AND legacy_system_id = ${h}`,
      );
    });
    console.log(`  deleted handle ${h} "${r.name}"`);
  }
  console.log(`\nDone — deleted ${tAreas} implied areas.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
