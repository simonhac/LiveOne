#!/usr/bin/env tsx
/**
 * Fix mismatched session_ids in point_readings and point_readings_agg_5m
 *
 * This script identifies and NULLs out session_ids where the session's system_id
 * doesn't match the point reading's system_id. This is typically caused by
 * database sync artifacts where point_readings were synced from production
 * with their original session_ids, but the sessions table wasn't fully synced.
 *
 * Usage:
 *   npx tsx scripts/utils/fix-session-ids.ts [--dry-run]
 */

import { rawClient } from "@/lib/db";

async function main() {
  const isDryRun = process.argv.includes("--dry-run");

  console.log("🔍 Checking for mismatched session_ids...\n");

  if (isDryRun) {
    console.log("⚠️  DRY RUN MODE - No changes will be made\n");
  }

  // Check point_readings table
  console.log("📊 Analyzing point_readings table...");
  const prMismatches = await rawClient.execute(`
    SELECT
      pr.system_id as pr_system,
      s.system_id as s_system,
      COUNT(*) as count,
      COUNT(DISTINCT pr.session_id) as unique_sessions
    FROM point_readings pr
    LEFT JOIN sessions s ON pr.session_id = s.id
    WHERE pr.session_id IS NOT NULL
      AND (s.id IS NULL OR s.system_id != pr.system_id)
    GROUP BY pr.system_id, s.system_id
  `);

  if (prMismatches.rows.length > 0) {
    console.log("❌ Found mismatched session_ids in point_readings:");
    for (const row of prMismatches.rows) {
      console.log(
        `   System ${row.pr_system}: ${row.count} readings with ${row.unique_sessions} wrong sessions`,
      );
    }

    if (!isDryRun) {
      console.log("\n🔧 Fixing point_readings...");
      const result = await rawClient.execute(`
        UPDATE point_readings
        SET session_id = NULL
        WHERE session_id IN (
          SELECT pr.session_id
          FROM point_readings pr
          LEFT JOIN sessions s ON pr.session_id = s.id
          WHERE pr.session_id IS NOT NULL
            AND (s.id IS NULL OR s.system_id != pr.system_id)
        )
      `);
      console.log(
        `✅ Cleared ${result.rowsAffected || 0} mismatched session_ids from point_readings`,
      );
    }
  } else {
    console.log("✅ No mismatches found in point_readings");
  }

  // Check point_readings_agg_5m table
  console.log("\n📊 Analyzing point_readings_agg_5m table...");
  const pr5mMismatches = await rawClient.execute(`
    SELECT
      pr.system_id as pr_system,
      s.system_id as s_system,
      COUNT(*) as count,
      COUNT(DISTINCT pr.session_id) as unique_sessions
    FROM point_readings_agg_5m pr
    LEFT JOIN sessions s ON pr.session_id = s.id
    WHERE pr.session_id IS NOT NULL
      AND (s.id IS NULL OR s.system_id != pr.system_id)
    GROUP BY pr.system_id, s.system_id
  `);

  if (pr5mMismatches.rows.length > 0) {
    console.log("❌ Found mismatched session_ids in point_readings_agg_5m:");
    for (const row of pr5mMismatches.rows) {
      console.log(
        `   System ${row.pr_system}: ${row.count} aggregates with ${row.unique_sessions} wrong sessions`,
      );
    }

    if (!isDryRun) {
      console.log("\n🔧 Fixing point_readings_agg_5m...");
      const result = await rawClient.execute(`
        UPDATE point_readings_agg_5m
        SET session_id = NULL
        WHERE session_id IN (
          SELECT pr.session_id
          FROM point_readings_agg_5m pr
          LEFT JOIN sessions s ON pr.session_id = s.id
          WHERE pr.session_id IS NOT NULL
            AND (s.id IS NULL OR s.system_id != pr.system_id)
        )
      `);
      console.log(
        `✅ Cleared ${result.rowsAffected || 0} mismatched session_ids from point_readings_agg_5m`,
      );
    }
  } else {
    console.log("✅ No mismatches found in point_readings_agg_5m");
  }

  console.log("\n✨ Done!");

  if (isDryRun) {
    console.log("\n💡 Run without --dry-run to apply fixes");
  }
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
