#!/usr/bin/env tsx
/**
 * Backfill the battery-provenance blend over full history for every battery-bearing Area (path a / prod
 * cutover). Calls the same chunked `recomputeRange` the daily heal uses — ensures each Area's helper
 * device + 3 blend points + bindings, and writes their agg_5m over the range. DRY-RUN by default; pass
 * --apply to write. Target DB = whatever .env.local points at (liveone-dev; prod has no stored URL).
 *
 * Usage:
 *   npx tsx scripts/backfill-battery-provenance.ts                 # dry run, full history
 *   npx tsx scripts/backfill-battery-provenance.ts --start=2025-10-01 --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
if (
  !process.env.PLANETSCALE_DATABASE_URL &&
  process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS
) {
  process.env.PLANETSCALE_DATABASE_URL =
    process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS;
}

import { sql } from "drizzle-orm";
import { planetscaleDb } from "../lib/db/planetscale";
import {
  listBatteryProvenanceHandles,
  learnEtaForAllHandles,
  recomputeRange,
} from "../lib/battery-provenance/recompute";

const APPLY = process.argv.includes("--apply");
const startArg = process.argv
  .find((a) => a.startsWith("--start="))
  ?.split("=")[1];
const DEFAULT_START = "2025-08-16"; // LIVEONE birthdate

async function main() {
  const db = planetscaleDb;
  if (!db) throw new Error("No Postgres connection.");
  const [id]: any =
    (
      await db.execute(
        sql`select current_user as usr, current_database() as dbname`,
      )
    ).rows ?? [];
  console.log(
    `[DB] ${id?.usr}@${id?.dbname}  ${APPLY ? "[APPLY]" : "[DRY-RUN]"}`,
  );

  const startMs = Date.parse(`${startArg ?? DEFAULT_START}T00:00:00Z`);
  const nowMs = Date.now();
  const handles = await listBatteryProvenanceHandles();
  console.log(
    `battery-bearing Area handles: ${handles.join(", ") || "(none)"}  range ${new Date(startMs).toISOString().slice(0, 10)} .. now`,
  );
  if (handles.length === 0) return;
  if (!APPLY) {
    console.log(
      "Dry run — pass --apply to backfill (14-day chunks per handle).",
    );
    return;
  }

  const started = Date.now();
  // Learn + persist η FIRST (from the fixed anchor) so recomputeRange reads the canonical, reproducible η
  // via inputs.etaSeries instead of an in-window fallback — otherwise the backfill isn't reproducible.
  const eta = await learnEtaForAllHandles(nowMs);
  console.log(`learned η for ${eta.handles} handles`);
  await recomputeRange(startMs, nowMs, undefined, (info) => {
    console.log(
      `  handle ${info.handle} ${new Date(info.chunkStartMs).toISOString().slice(0, 10)}..${new Date(info.chunkEndMs).toISOString().slice(0, 10)}`,
    );
  });
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
