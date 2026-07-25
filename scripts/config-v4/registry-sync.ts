#!/usr/bin/env tsx
/**
 * Populate the config-v4 registries (`devices`, `points`, `area_members`, `device_state`) from the
 * legacy ones (`systems`, `point_info`, `area_devices`, `polling_status`).
 *
 * This is the ADDITIVE, DARK half of the cutover transform's stage 2, lifted out so it can run on prod
 * days BEFORE the window instead of inside it. Nothing reads these tables until the cutover build, so a
 * run here cannot affect serving — and running it early means the C7 mirror invariant
 * (`/api/health?v4mirror=1`) is armed and monitored for the whole pre-window period rather than being
 * asserted for the first time at 3am.
 *
 * DELIBERATELY EXCLUDED, both of which stay in `config-transform.ts`:
 *   - stage 2e's `areas` column RENAMES (owner_clerk_user_id→owner_user_id, display_name→name,
 *     alias→slug). Those BREAK the deployed build, so they belong in the window, not a dark run.
 *   - stage 2i's composite delete — removed entirely (defect D-d); see `retire-empty-composites.ts`.
 *
 * Differences from the original stage 2, all deliberate:
 *   - **Transactional** (defect: stage 2 was a sequence of autocommitting statements, so a mid-stage
 *     abort left the registries half-populated with no way to tell how far it got).
 *   - **`RAISE EXCEPTION` pre-flights** for the conditions the row-count guards structurally cannot see
 *     — most importantly a `legacy_handles` row pointing at a system that no longer exists, which would
 *     make stage 2c's VALIDATED foreign key abort after the inserts.
 *   - **`device_state` refreshes** on conflict rather than `DO NOTHING`. Populating it once at T-7d and
 *     then no-op-ing at the window would hand the cutover build week-old polling status.
 *
 * Idempotent: safe to re-run any number of times, including immediately before the window as a top-up
 * for anything minted since.
 *
 * Usage:
 *   npx tsx scripts/config-v4/registry-sync.ts                     # dry run (default)
 *   npx tsx scripts/config-v4/registry-sync.ts --commit
 *   PLANETSCALE_DATABASE_URL="<prod url>" ALLOW_PROD_DB_IN_DEV=true \
 *     npx tsx scripts/config-v4/registry-sync.ts --commit          # the T-7d prod run
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { assertRehearsalTarget } from "./guard";
import {
  PREFLIGHTS,
  populateRegistries,
  type RowsExec,
} from "./registry-populate";

const commit = process.argv.includes("--commit");

async function main() {
  // Same target guard as the rest of the config-v4 suite (guard.ts). These three scripts WRITE and are
  // invoked by the cutover runbook, but used to carry no target assertion at all — so the mode/branch-id
  // proof that protects config-transform did not protect them. `CONFIG_V4_TARGET` selects the mode; prod
  // needs `--i-understand-this-is-prod` (+ `ALLOW_PROD_DB_IN_DEV=true`, which these already document).
  // Called BEFORE requirePlanetscaleDb() so a wrong target is reported as a wrong target, rather than as
  // the pool's own prod refusal, which names a different fix.
  assertRehearsalTarget();
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const db = requirePlanetscaleDb();
  const rows = async (t: string) =>
    ((await db.execute(sql.raw(t))) as unknown as { rows: any[] }).rows;
  const scalar = async (t: string) =>
    Number(Object.values((await rows(t))[0])[0]);

  const [{ u: user, d: dbName }] = await rows(
    "SELECT current_user AS u, current_database() AS d",
  );
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
  const isProd = !!prodToken && String(user).includes(prodToken);
  console.log(
    `target: ${dbName} as ${user} ${isProd ? "\x1b[31m[PRODUCTION]\x1b[0m" : "[non-prod]"}`,
  );

  // ── pre-flights ────────────────────────────────────────────────────────────
  console.log("\npre-flights (each must be 0):");
  let bad = 0;
  for (const p of PREFLIGHTS) {
    const n = await scalar(p.sql);
    console.log(`  ${n === 0 ? "✓" : "✗"} ${p.name}: ${n}`);
    if (n !== 0) {
      console.error(`      → ${p.why}`);
      bad++;
    }
  }
  if (bad > 0)
    throw new Error(`${bad} pre-flight(s) failed — refusing to write`);

  // ── plan ───────────────────────────────────────────────────────────────────
  const plan = {
    systems: await scalar("SELECT count(*) FROM systems"),
    devices: await scalar("SELECT count(*) FROM devices"),
    pointInfo: await scalar("SELECT count(*) FROM point_info"),
    points: await scalar("SELECT count(*) FROM points"),
    areasOfOneToMint: await scalar(
      "SELECT count(*) FROM systems s WHERE NOT EXISTS (SELECT 1 FROM areas a WHERE a.legacy_system_id = s.id)",
    ),
    areaDevices: await scalar("SELECT count(*) FROM area_devices"),
    areaMembers: await scalar("SELECT count(*) FROM area_members"),
    pollingStatus: await scalar("SELECT count(*) FROM polling_status"),
    deviceState: await scalar("SELECT count(*) FROM device_state"),
  };
  console.log("\nplan:", JSON.stringify(plan, null, 2));

  if (!commit) {
    console.log("\nDry-run only; rerun with --commit to write.");
    return;
  }

  // ── the sync, in ONE transaction ───────────────────────────────────────────
  // The additive population is single-sourced in registry-populate.ts (shared verbatim with the cutover
  // transform's stage 2, so the two can never drift again). This driver owns the transaction boundary.
  const t0 = Date.now();
  await db.transaction(async (tx) => {
    const exec: RowsExec = async (q) =>
      ((await tx.execute(q)) as unknown as { rows: Record<string, unknown>[] })
        .rows;
    await populateRegistries(exec);
  });

  console.log(`\ncommitted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── post-conditions (the same invariant /api/health?v4mirror=1 reports) ─────
  const post = {
    devicesMissing: await scalar(
      "SELECT count(*) FROM systems s WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = s.id)",
    ),
    pointsMissing: await scalar(
      "SELECT count(*) FROM point_info pi WHERE NOT EXISTS (SELECT 1 FROM points p WHERE p.id = pi.point_uid)",
    ),
    devicesWithoutArea: await scalar(
      "SELECT count(*) FROM devices WHERE primary_area_id IS NULL",
    ),
    ridMismatch: await scalar(
      "SELECT count(*) FROM points p JOIN point_info pi ON pi.point_uid = p.id WHERE p.rid <> pi.rid",
    ),
  };
  console.log("post-conditions (all must be 0):", JSON.stringify(post));
  if (Object.values(post).some((n) => n !== 0))
    throw new Error("post-condition check FAILED");
  console.log("\nregistry-sync: OK");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
