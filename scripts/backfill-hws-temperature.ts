#!/usr/bin/env tsx
/**
 * Backfill the modelled hot-water temperature over the full history.
 *
 * Reconstructs the derived `load.hws/temperature` agg_5m rows from the persisted `load.hws/power`
 * agg_5m, using the same chunked recompute the minutely cron uses (14-day chunks, 2-day warmup
 * lead-in, UPSERT — safe to re-run). Writes ONLY agg_5m (not the KV latest; the next minutely
 * reconcile sets that).
 *
 * Prereqs: the temperature point must already be registered (scripts/seed-hws-point.ts).
 *
 * SAFETY: defaults to a DRY RUN. Pass --apply to write. ⚠️ Run with `--env-file=.env.local`.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-hws-temperature.ts
 *   npx tsx --env-file=.env.local scripts/backfill-hws-temperature.ts --start=2025-08-16
 *   npx tsx --env-file=.env.local scripts/backfill-hws-temperature.ts --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { listHwsPairs, recomputeRange } from "../lib/hws/recompute";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
const startArg = process.argv.find((a) => a.startsWith("--start="));
const DEFAULT_START = "2025-08-16"; // LIVEONE birthdate
const startStr = startArg ? startArg.split("=")[1] : DEFAULT_START;

async function main() {
  const startMs = Date.parse(`${startStr}T00:00:00Z`);
  if (isNaN(startMs)) throw new Error(`Invalid --start: ${startStr}`);
  const nowMs = Date.now();

  const pairs = await listHwsPairs();
  console.log(
    `${tag} backfill ${new Date(startMs).toISOString()} .. ${new Date(nowMs).toISOString()} ` +
      `for ${pairs.length} pair(s): ${pairs.map((p) => p.systemId).join(", ") || "(none)"}`,
  );

  if (pairs.length === 0) {
    console.log("No HWS pairs — register one first (seed-hws-point.ts).");
    return;
  }
  if (!APPLY) {
    console.log(
      "Dry run — pass --apply to write. Recompute runs in 14-day chunks.",
    );
    return;
  }

  const started = nowMs;
  const summary = await recomputeRange(startMs, nowMs, (info) => {
    console.log(
      `  system ${info.system} ${new Date(info.chunkStartMs).toISOString().slice(0, 10)}` +
        `..${new Date(info.chunkEndMs).toISOString().slice(0, 10)} → ${info.rows}`,
    );
  });
  console.log(
    `${tag} done in ${Math.round((Date.now() - started) / 1000)}s: ${summary.rowsWritten} rows written.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
