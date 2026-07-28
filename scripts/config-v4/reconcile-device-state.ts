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
 * 🛑 SPENT TOOL — this was a PRE-flip step, and slice C has deployed (prod 2026-07-28 15:20 AEST).
 *
 * It ran against prod immediately before the merge, so device_state was current under the old build and
 * the flip had nothing to catch up on. From the moment the flip went live, BOTH halves of this script
 * stopped meaning what they meant:
 *
 *   - The COPY now runs backwards. polling_status is frozen; device_state is the live table. Committing
 *     would rewind the live counters and push last_success_time BACKWARDS — and
 *     `evaluateBoundarySchedule` (lib/vendors/base-adapter.ts) keys off exactly that, so every
 *     boundary-scheduled vendor would read "window not yet recorded" and re-poll on each tick until it
 *     next succeeded. main() detects the flip and refuses --commit; see the FLIPPED guard below.
 *   - The DRIFT report means nothing. Post-flip the two tables are SUPPOSED to diverge (~1 poll per
 *     device per minute), so a non-zero drift is the expected state, not a fault signal. An earlier
 *     version of this header claimed the opposite — that post-deploy drift proved a device_state write
 *     was erroring. It does not. That advice was wrong.
 *
 * To check the device_state writer instead, do not come here — read device_state directly:
 * per-device `last_poll_time` past the polling_status freeze, coverage against the mapped set, and
 * `grep DEVICE-STATE` in the prod logs (the write swallows its own errors, so the log line and a
 * stalled last_poll_time are the only two surfaces). Recorded in full under slice C in
 * docs/plans/config-v4-execution-plan.md.
 *
 * Idempotent, in that it is a plain upsert that makes no decisions from prior state — but idempotent is
 * not the same as harmless once the source table is the stale one.
 *
 * ⚠️ Direction is one-way, polling_status → device_state, and there is no reverse. A rollback is
 * redeploy-the-previous-build: it resumes reading/writing polling_status, stale by the length of the
 * flip, which over-polls rather than under-polls and self-heals within a tick.
 *
 * Dies with the rest of scripts/config-v4/ at slice L.
 *
 * Usage (historical — kept so the prod invocation is on the record):
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

/**
 * Has the slice C flip already happened? Once it has, polling_status is frozen and device_state
 * advances, so device_state's newest poll runs ahead — a condition that cannot occur while the old
 * build is the writer, because then polling_status is the one moving. `coalesce(..., false)` so an
 * empty table reads as "not flipped" rather than NULL.
 */
const FLIPPED = `
  SELECT coalesce((SELECT max(last_poll_time) FROM device_state)
                > (SELECT max(last_poll_time) FROM polling_status), false) AS flipped`;

/** Per-device drift — must be zero before the read-flip deploys. Meaningless after it; see the header. */
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

  // The one guard that makes the destructive direction unmakeable rather than merely undocumented.
  // Checked in dry-run too, because the drift list printed above is misleading post-flip.
  const [{ flipped }] = await rows(FLIPPED);
  if (flipped) {
    console.log(
      "\n⚠️  device_state is AHEAD of polling_status — the slice C read/write flip is LIVE.\n" +
        "    polling_status is frozen, so the drift above is the expected state, not a fault signal.\n" +
        "    To check the device_state writer, read device_state directly (see this file's header).",
    );
    if (commit)
      throw new Error(
        "refusing --commit: the flip is live, so this copy would REWIND device_state to the frozen " +
          "polling_status snapshot (counters lost, last_success_time backwards, boundary vendors re-polling)",
      );
  }

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
