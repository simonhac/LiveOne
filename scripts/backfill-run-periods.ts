#!/usr/bin/env tsx
/**
 * Backfill device run periods over the full history (run-tracking feature).
 *
 * Data goes back to ~2025-08-16, so this is NOT something to run through the 60s serverless cron.
 * Run it from a workstation via tsx: it calls the same chunked, idempotent `recomputeRange` the
 * cron uses (14-day chunks, bounded read + delete-and-reinsert per chunk, per-system advisory
 * lock), but with no function-duration limit and a progress line per chunk. Safe to re-run / resume.
 *
 * Prereqs: the generator role + tracker must already be seeded (scripts/seed-generator-tracker.ts).
 *
 * SAFETY: defaults to a DRY RUN (prints the plan). Pass --apply to write. The DB target is
 * whatever .env.local points at.
 *
 * Usage:
 *   npx tsx scripts/backfill-run-periods.ts                       # dry run, full history
 *   npx tsx scripts/backfill-run-periods.ts --start=2025-08-16    # dry run from a date
 *   npx tsx scripts/backfill-run-periods.ts --apply               # write, full history
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { listEnabledTrackers } from "../lib/run-tracking/resolve";
import { recomputeRange } from "../lib/run-tracking/recompute";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
const startArg = process.argv.find((a) => a.startsWith("--start="));
const DEFAULT_START = "2025-08-16"; // LIVEONE birthdate
const startStr = startArg ? startArg.split("=")[1] : DEFAULT_START;

async function main() {
  const startMs = Date.parse(`${startStr}T00:00:00Z`);
  if (isNaN(startMs)) throw new Error(`Invalid --start: ${startStr}`);
  const nowMs = Date.now();

  const trackers = await listEnabledTrackers();
  console.log(
    `${tag} backfill ${new Date(startMs).toISOString()} .. ${new Date(nowMs).toISOString()} ` +
      `for ${trackers.length} enabled tracker(s): ${trackers.map((t) => `${t.systemId}/${t.role}`).join(", ") || "(none)"}`,
  );

  if (trackers.length === 0) {
    console.log(
      "No enabled trackers — seed one first (seed-generator-tracker.ts).",
    );
    return;
  }
  if (!APPLY) {
    console.log(
      "Dry run — pass --apply to write. Recompute runs in 14-day chunks.",
    );
    return;
  }

  const started = nowMs;
  const summary = await recomputeRange(startMs, nowMs, nowMs, (info) => {
    console.log(
      `  ${info.tracker} ${new Date(info.chunkStartMs).toISOString().slice(0, 10)}` +
        `..${new Date(info.chunkEndMs).toISOString().slice(0, 10)} → +${info.inserted}`,
    );
  });
  console.log(
    `${tag} done in ${Math.round((Date.now() - started) / 1000)}s: ` +
      `${summary.rowsInserted} periods inserted, ${summary.rowsDeleted} deleted, ${summary.openPeriods} open.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
