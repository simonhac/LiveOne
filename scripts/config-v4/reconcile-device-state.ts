#!/usr/bin/env tsx
/**
 * config-v4 Phase 12 slice C — bring `device_state` level with `polling_status`.
 *
 * Why this exists as a separate step from the dual-write. `total_polls`, `successful_polls` and
 * `consecutive_errors` are RUNNING TOTALS. `device_state` was seeded once by registry-populate at the
 * 2026-07-26 cutover and has had no runtime writer since, so it is behind by everything accrued in the
 * interim. Turning on the dual-write only makes the two tables move together — it cannot close a gap
 * that already exists. This does, with an ABSOLUTE copy of all nine payload columns.
 *
 * Runbook (slice C):
 *   1. run this against prod BEFORE the flip deploys, so device_state is current under the old build
 *      and the flip has nothing to catch up on. Re-run immediately before the merge: prod keeps
 *      writing only polling_status until the deploy lands, so drift re-accumulates at ~1/device/min.
 *   2. after the deploy, run it once more as a post-check — from here on a non-zero drift means a
 *      device_state write has been ERRORING, not that the tables are merely out of step.
 *
 * Idempotent and safe to re-run: it is a plain upsert, and it makes no decisions from prior state.
 *
 * ⚠️ Direction is one-way, polling_status → device_state. Do NOT invert it after the read-flip.
 *
 * Dies with the rest of scripts/config-v4/ at slice L.
 *
 * Usage:
 *   npx tsx scripts/config-v4/reconcile-device-state.ts                     # dry run (default)
 *   npx tsx scripts/config-v4/reconcile-device-state.ts --commit            # dev (CONFIG_V4_TARGET=dev)
 *   CONFIG_V4_TARGET=prod PLANETSCALE_DATABASE_URL="<prod url>" ALLOW_PROD_DB_IN_DEV=true \
 *     npx tsx scripts/config-v4/reconcile-device-state.ts --commit --i-understand-this-is-prod
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { assertRehearsalTarget } from "./guard";

const commit = process.argv.includes("--commit");

/**
 * The absolute copy. Joined on `devices.rid = polling_status.system_id` — the verbatim-rid invariant
 * (lib/registry/v4-mirror.ts) — NOT through legacy_handles, so this agrees with the join the dual-write
 * itself uses. Every column is overwritten from polling_status; nothing is incremented.
 */
const RECONCILE = `
  INSERT INTO device_state (device_id, last_poll_time, last_success_time, last_error_time, last_error,
                            last_response, consecutive_errors, total_polls, successful_polls, updated_at)
  SELECT d.id, ps.last_poll_time, ps.last_success_time, ps.last_error_time, ps.last_error,
         ps.last_response, ps.consecutive_errors, ps.total_polls, ps.successful_polls, ps.updated_at
    FROM polling_status ps JOIN devices d ON d.rid = ps.system_id
  ON CONFLICT (device_id) DO UPDATE SET
    last_poll_time = EXCLUDED.last_poll_time, last_success_time = EXCLUDED.last_success_time,
    last_error_time = EXCLUDED.last_error_time, last_error = EXCLUDED.last_error,
    last_response = EXCLUDED.last_response, consecutive_errors = EXCLUDED.consecutive_errors,
    total_polls = EXCLUDED.total_polls, successful_polls = EXCLUDED.successful_polls,
    updated_at = EXCLUDED.updated_at`;

/** Rows the copy structurally cannot reach. registry-populate's inner join drops these silently; report them. */
const UNMAPPED = `
  SELECT ps.system_id, ps.total_polls
    FROM polling_status ps WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = ps.system_id)
   ORDER BY ps.system_id`;

/** Per-device drift — must be zero before the read-flip deploys, and after. */
const DRIFT = `
  SELECT ps.system_id, ps.total_polls AS ps_total, ds.total_polls AS ds_total,
         ps.successful_polls AS ps_ok, ds.successful_polls AS ds_ok,
         ps.consecutive_errors AS ps_err, ds.consecutive_errors AS ds_err,
         ps.last_poll_time AS ps_last, ds.last_poll_time AS ds_last
    FROM polling_status ps
    JOIN devices d ON d.rid = ps.system_id
    LEFT JOIN device_state ds ON ds.device_id = d.id
   WHERE ds.device_id IS NULL
      OR ds.total_polls IS DISTINCT FROM ps.total_polls
      OR ds.successful_polls IS DISTINCT FROM ps.successful_polls
      OR ds.consecutive_errors IS DISTINCT FROM ps.consecutive_errors
      OR ds.last_poll_time IS DISTINCT FROM ps.last_poll_time
   ORDER BY ps.system_id`;

async function main() {
  // Same fail-closed target guard as the rest of the suite — this WRITES.
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
  // ⚠️ Read the branch id off the CONNECTION username, not `current_user`. PlanetScale routes by the
  // connection username (`pscale_api_<role>.<branchid>`); Postgres's `current_user` is just the role,
  // with no branch id in it — so the `current_user`-based check that registry-sync.ts uses always
  // reports "[non-prod]", including on prod. A banner that lies about the target is worse than none.
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID?.toLowerCase();
  const connUser = decodeURIComponent(
    new URL(process.env.PLANETSCALE_DATABASE_URL!).username,
  ).toLowerCase();
  const isProd = !!prodToken && connUser.includes(prodToken);
  console.log(
    `target: ${dbName} as ${user} ${isProd ? "\x1b[31m[PRODUCTION]\x1b[0m" : "[non-prod]"}`,
  );

  const before = {
    pollingStatus: await scalar("SELECT count(*) FROM polling_status"),
    deviceState: await scalar("SELECT count(*) FROM device_state"),
    mapped: await scalar(
      "SELECT count(*) FROM polling_status ps JOIN devices d ON d.rid = ps.system_id",
    ),
  };
  console.log("\nbefore:", JSON.stringify(before));

  // An unmapped row is a real defect (a polled system with no devices row), not a rounding error:
  // after the read-flip its polling status disappears from the admin table entirely.
  const unmapped = await rows(UNMAPPED);
  if (unmapped.length > 0) {
    console.error(
      `\n✗ ${unmapped.length} polling_status row(s) have NO devices row — they will be DROPPED by the read-flip:`,
    );
    for (const r of unmapped)
      console.error(
        `    system_id=${r.system_id} (total_polls=${r.total_polls}) → mint it via DeviceRegistry.ensureDeviceForHandle`,
      );
    throw new Error(
      `${unmapped.length} unmapped polling_status row(s) — refusing to report a clean reconcile`,
    );
  }
  console.log("✓ every polling_status row maps to a device");

  const driftBefore = await rows(DRIFT);
  console.log(`drift before: ${driftBefore.length} device(s)`);
  for (const r of driftBefore) console.log("   ", JSON.stringify(r));

  if (!commit) {
    console.log("\nDry-run only; rerun with --commit to write.");
    return;
  }

  await db.execute(sql.raw(RECONCILE));

  const after = {
    deviceState: await scalar("SELECT count(*) FROM device_state"),
    mapped: before.mapped,
  };
  // device_state may legitimately hold MORE rows than polling_status (a device whose system has never
  // been polled has no polling_status row). The invariant is coverage of the mapped set, not equality.
  const covered = await scalar(`
    SELECT count(*) FROM polling_status ps JOIN devices d ON d.rid = ps.system_id
      JOIN device_state ds ON ds.device_id = d.id`);
  console.log("\nafter:", JSON.stringify({ ...after, covered }));
  if (covered !== before.mapped)
    throw new Error(
      `coverage FAILED: ${covered} device_state rows for ${before.mapped} mapped polling_status rows`,
    );

  const driftAfter = await rows(DRIFT);
  if (driftAfter.length > 0) {
    for (const r of driftAfter) console.error("   ", JSON.stringify(r));
    throw new Error(
      `${driftAfter.length} device(s) still drifted after the copy — investigate before the read-flip`,
    );
  }
  console.log("✓ drift after: 0");
  console.log("\nreconcile-device-state: OK");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
