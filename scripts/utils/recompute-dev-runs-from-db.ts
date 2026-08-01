/**
 * Recompute derived run intervals on liveone-dev from its (just-synced) readings — the run-tracking
 * leg of the prod→dev sync, analogous to rebuild-dev-kv-from-db.ts.
 *
 * Why recompute instead of copying derived_intervals: dev crons are off (nothing recomputes
 * organically) AND the rows can't be cleanly mirrored — derived_intervals has a composite PK and
 * its periods shift/merge under recompute, so a row-copy would leave orphaned stale runs. The
 * config table (derivations) IS synced; here we rebuild the runs from the synced point_readings
 * via the same delete-and-reinsert recompute the prod cron uses, so dev's runs panel matches prod.
 *
 * Writes ONLY derived_intervals, ONLY to whatever PLANETSCALE_DATABASE_URL points at — and refuses
 * to run if that resolves to the prod branch.
 *
 *   PLANETSCALE_DATABASE_URL=<dev write url> npx tsx --env-file=.env.local \
 *     scripts/utils/recompute-dev-runs-from-db.ts [days=7]
 */
import { logConnectionPath, requirePlanetscaleDb } from "@/lib/db/planetscale";
import { recomputeRange } from "@/lib/run-tracking/recompute";

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const url = process.env.PLANETSCALE_DATABASE_URL ?? "";
  const prodToken = (
    process.env.PLANETSCALE_PROD_BRANCH_ID ?? ""
  ).toLowerCase();
  // Fail-closed: never write to prod. dev and prod share the PlanetScale gateway host, so the
  // prod branch id lives in the username — refuse if the write URL carries it.
  if (prodToken && url.toLowerCase().includes(prodToken)) {
    throw new Error(
      `refusing to run: PLANETSCALE_DATABASE_URL carries the production identifier (${prodToken})`,
    );
  }

  const days =
    parseInt(process.env.RUN_RECOMPUTE_DAYS ?? process.argv[2] ?? "7", 10) || 7;
  const nowMs = Date.now();
  const startMs = nowMs - days * DAY_MS;

  // Touch the pool early so a misconfigured/empty URL fails loudly before we claim to do work.
  requirePlanetscaleDb();
  // 3 of the 8 dropouts in the 2026-07-25 incident hit this leg ~4s in. Record which path
  // this connection actually takes (pooler vs direct) and the server-side timeouts.
  await logConnectionPath("recompute");

  console.log(
    `Recomputing dev run periods, last ${days}d ` +
      `(${new Date(startMs).toISOString()} .. ${new Date(nowMs).toISOString()})`,
  );
  const summary = await recomputeRange(startMs, nowMs, nowMs, {
    retry: { maxAttempts: 3, retryDelayMs: 500, failOnError: true },
  });
  console.log(
    `✓ ${summary.trackersProcessed} tracker(s): ` +
      `${summary.rowsInserted} periods inserted, ${summary.rowsDeleted} deleted, ` +
      `${summary.openPeriods} open`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
