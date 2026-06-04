#!/usr/bin/env tsx
/**
 * Purge the observations QStash queue's pending backlog, then recreate it paused.
 *
 * Why: messages enqueued before the full-fidelity fixes (enriched 5m payload +
 * preserved session ids) use the old lossy shape. Draining them would write lossy
 * point_readings_agg_5m rows that the (deferred) Turso backfill — which uses
 * onConflictDoNothing — could not later overwrite. Purging ensures only new,
 * full-fidelity messages reach Postgres. The purged data is NOT lost: every
 * observation is also in Turso (dual-write), and history is backfilled from Turso.
 *
 * Deleting the queue removes its pending messages; we immediately recreate it
 * paused so publishing keeps succeeding (messages accumulate) until you resume.
 *
 * Usage:
 *   npx tsx scripts/purge-observations-queue.ts            # dry run: show lag only
 *   npx tsx scripts/purge-observations-queue.ts --confirm  # actually purge + recreate
 */

import { Client } from "@upstash/qstash";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const QUEUE_NAME = "observations";

async function main() {
  const confirm = process.argv.includes("--confirm");

  const token = process.env.OBSERVATIONS_QSTASH_TOKEN;
  if (!token) {
    console.error("❌ OBSERVATIONS_QSTASH_TOKEN not set in environment");
    process.exit(1);
  }

  const client = new Client({ token });
  const queue = client.queue({ queueName: QUEUE_NAME });

  // Report current state
  try {
    const info = await queue.get();
    console.log(
      `Queue "${QUEUE_NAME}": paused=${info.paused ?? false}, lag=${info.lag ?? 0}, parallelism=${info.parallelism ?? 1}`,
    );
  } catch (error: any) {
    if (error?.message?.includes("not found") || error?.status === 404) {
      console.log(
        `Queue "${QUEUE_NAME}" does not exist yet — nothing to purge.`,
      );
      return;
    }
    throw error;
  }

  if (!confirm) {
    console.log(
      "\nDRY RUN — pass --confirm to delete the pending backlog and recreate the queue paused.",
    );
    return;
  }

  console.log("\nDeleting queue (purges pending messages)...");
  await queue.delete();

  console.log("Recreating queue (paused, parallelism 1)...");
  await queue.upsert({ parallelism: 1, paused: true });

  const info = await queue.get();
  console.log(
    `✓ Done. Queue "${QUEUE_NAME}": paused=${info.paused ?? false}, lag=${info.lag ?? 0}, parallelism=${info.parallelism ?? 1}`,
  );
  console.log("Resume from the admin UI (/admin/observations) when ready.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Purge failed:", err);
    process.exit(1);
  });
