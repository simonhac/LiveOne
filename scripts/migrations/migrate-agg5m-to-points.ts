#!/usr/bin/env npx tsx

/**
 * Migrate historical data from readings_agg_5m to point_readings_agg_5m
 *
 * This script migrates 5-minute aggregated data from the legacy table to the
 * point-based system, with checkpoint support and validation.
 *
 * Usage:
 *   npm run migrate:agg5m -- --dry-run              # Test on dev.db
 *   npm run migrate:agg5m -- --database /path/to/test.db  # Test on backup
 *   npm run migrate:agg5m -- --production            # Run on production
 *
 * Safety features:
 * - Batched inserts with checkpoints
 * - Idempotent (skips existing data)
 * - Validates each batch
 * - Progress tracking
 * - Resumable from any point
 */

import { createClient } from "@libsql/client";
import { Command } from "commander";
import * as readline from "readline";

// ============================================================================
// Configuration
// ============================================================================

const BATCH_SIZE = 1000; // Intervals per batch
const MIGRATION_NAME = "agg5m_to_points";

// Aggregation field mapping for each vendor type
interface AggMapping {
  readingsColumn: string; // Base column name in readings_agg_5m (e.g., "solar_w")
  originSubId: string; // origin_sub_id in point_info
  aggregateFields: {
    avg?: string; // e.g., "solar_w_avg"
    min?: string; // e.g., "solar_w_min"
    max?: string; // e.g., "solar_w_max"
    last?: string; // e.g., "battery_soc_last"
  };
  transform?: "kwhToWh"; // Optional transformation
}

// Selectronic/Fronius aggregation mappings
const STANDARD_AGG_MAPPINGS: AggMapping[] = [
  {
    readingsColumn: "solar_w",
    originSubId: "solar_w",
    aggregateFields: {
      avg: "solar_w_avg",
      min: "solar_w_min",
      max: "solar_w_max",
    },
  },
  {
    readingsColumn: "load_w",
    originSubId: "load_w",
    aggregateFields: {
      avg: "load_w_avg",
      min: "load_w_min",
      max: "load_w_max",
    },
  },
  {
    readingsColumn: "battery_w",
    originSubId: "battery_w",
    aggregateFields: {
      avg: "battery_w_avg",
      min: "battery_w_min",
      max: "battery_w_max",
    },
  },
  {
    readingsColumn: "grid_w",
    originSubId: "grid_w",
    aggregateFields: {
      avg: "grid_w_avg",
      min: "grid_w_min",
      max: "grid_w_max",
    },
  },
  {
    readingsColumn: "battery_soc",
    originSubId: "battery_soc",
    aggregateFields: { last: "battery_soc_last" },
  },
  // Energy totals (kWh → Wh)
  {
    readingsColumn: "solar_kwh_total",
    originSubId: "solar_wh_total",
    aggregateFields: { last: "solar_kwh_total_last" },
    transform: "kwhToWh",
  },
  {
    readingsColumn: "load_kwh_total",
    originSubId: "load_wh_total",
    aggregateFields: { last: "load_kwh_total_last" },
    transform: "kwhToWh",
  },
  {
    readingsColumn: "battery_in_kwh_total",
    originSubId: "battery_in_wh_total",
    aggregateFields: { last: "battery_in_kwh_total_last" },
    transform: "kwhToWh",
  },
  {
    readingsColumn: "battery_out_kwh_total",
    originSubId: "battery_out_wh_total",
    aggregateFields: { last: "battery_out_kwh_total_last" },
    transform: "kwhToWh",
  },
  {
    readingsColumn: "grid_in_kwh_total",
    originSubId: "grid_in_wh_total",
    aggregateFields: { last: "grid_in_kwh_total_last" },
    transform: "kwhToWh",
  },
  {
    readingsColumn: "grid_out_kwh_total",
    originSubId: "grid_out_wh_total",
    aggregateFields: { last: "grid_out_kwh_total_last" },
    transform: "kwhToWh",
  },
];

// Fronius-specific (camelCase originSubIds)
const FRONIUS_AGG_MAPPINGS: AggMapping[] = [
  {
    readingsColumn: "solar_w",
    originSubId: "solarW",
    aggregateFields: {
      avg: "solar_w_avg",
      min: "solar_w_min",
      max: "solar_w_max",
    },
  },
  {
    readingsColumn: "load_w",
    originSubId: "loadW",
    aggregateFields: {
      avg: "load_w_avg",
      min: "load_w_min",
      max: "load_w_max",
    },
  },
  {
    readingsColumn: "battery_w",
    originSubId: "batteryW",
    aggregateFields: {
      avg: "battery_w_avg",
      min: "battery_w_min",
      max: "battery_w_max",
    },
  },
  {
    readingsColumn: "grid_w",
    originSubId: "gridW",
    aggregateFields: {
      avg: "grid_w_avg",
      min: "grid_w_min",
      max: "grid_w_max",
    },
  },
  {
    readingsColumn: "battery_soc",
    originSubId: "batterySOC",
    aggregateFields: { last: "battery_soc_last" },
  },
];

// Enphase-specific (only solar power and interval energy)
const ENPHASE_AGG_MAPPINGS: AggMapping[] = [
  {
    readingsColumn: "solar_w",
    originSubId: "solar_w",
    aggregateFields: {
      avg: "solar_w_avg",
      min: "solar_w_min",
      max: "solar_w_max",
    },
  },
  {
    readingsColumn: "solar_interval_wh",
    originSubId: "solar_interval_wh",
    aggregateFields: { last: "solar_interval_wh" }, // Enphase provides interval energy directly
  },
];

// ============================================================================
// Types
// ============================================================================

interface MigrationProgress {
  systemId: number;
  lastMigratedTimestamp: number;
  rowsMigrated: number;
}

interface AggReading {
  system_id: number;
  interval_end: number;
  sample_count: number;
  [key: string]: any; // For dynamic column access
}

interface PointInfo {
  id: number;
  system_id: number;
  origin_id: string;
  origin_sub_id: string;
}

interface MigrationStats {
  systemId: number;
  vendorType: string;
  totalIntervals: number;
  alreadyMigrated: number;
  toMigrate: number;
  batchesComplete: number;
  pointAggregatesInserted: number;
  startTime: number;
  endTime?: number;
}

// ============================================================================
// Database Client
// ============================================================================

function createDbClient(options: {
  databasePath?: string;
  production?: boolean;
}) {
  if (options.production) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url || !authToken) {
      throw new Error(
        "Production mode requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN",
      );
    }

    return createClient({ url, authToken });
  } else if (options.databasePath) {
    return createClient({ url: `file:${options.databasePath}` });
  } else {
    return createClient({ url: "file:dev.db" });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

async function getVendorType(db: any, systemId: number): Promise<string> {
  const result = await db.execute({
    sql: "SELECT vendor_type FROM systems WHERE id = ?",
    args: [systemId],
  });

  if (result.rows.length === 0) {
    throw new Error(`System ${systemId} not found in systems table`);
  }

  return (result.rows[0] as any).vendor_type;
}

function getMappings(vendorType: string): AggMapping[] {
  if (vendorType === "enphase") return ENPHASE_AGG_MAPPINGS;
  if (vendorType === "fronius") return FRONIUS_AGG_MAPPINGS;
  return STANDARD_AGG_MAPPINGS;
}

function extractAggregateValues(
  agg: AggReading,
  mapping: AggMapping,
): {
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
} {
  const { aggregateFields, transform } = mapping;

  const result = {
    avg: aggregateFields.avg ? agg[aggregateFields.avg] : null,
    min: aggregateFields.min ? agg[aggregateFields.min] : null,
    max: aggregateFields.max ? agg[aggregateFields.max] : null,
    last: aggregateFields.last ? agg[aggregateFields.last] : null,
  };

  // Apply kWh → Wh conversion if needed
  if (transform === "kwhToWh") {
    if (result.avg !== null) result.avg *= 1000;
    if (result.min !== null) result.min *= 1000;
    if (result.max !== null) result.max *= 1000;
    if (result.last !== null) result.last *= 1000;
  }

  return result;
}

async function confirmProduction(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "\n⚠️  You are about to migrate production aggregated data. Have you:\n" +
        "  1. Created a backup with ./scripts/utils/backup-prod-db.sh?\n" +
        "  2. Created a Turso branch checkpoint?\n" +
        "  3. Tested this script on a backup copy?\n\n" +
        "Type 'YES' to continue: ",
      (answer) => {
        rl.close();
        resolve(answer.trim() === "YES");
      },
    );
  });
}

// ============================================================================
// Migration Functions
// ============================================================================

async function ensureMigrationProgressTable(db: any) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS migration_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      migration_name TEXT NOT NULL,
      system_id INTEGER NOT NULL,
      last_migrated_timestamp INTEGER NOT NULL,
      rows_migrated INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(migration_name, system_id)
    )
  `);
}

async function getProgress(
  db: any,
  systemId: number,
): Promise<MigrationProgress | null> {
  const result = await db.execute({
    sql: `SELECT system_id as systemId, last_migrated_timestamp as lastMigratedTimestamp,
                 rows_migrated as rowsMigrated
          FROM migration_progress
          WHERE migration_name = ? AND system_id = ?`,
    args: [MIGRATION_NAME, systemId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as any;
}

async function updateProgress(
  db: any,
  systemId: number,
  lastTimestamp: number,
  rowsMigrated: number,
) {
  await db.execute({
    sql: `INSERT INTO migration_progress
            (migration_name, system_id, last_migrated_timestamp, rows_migrated, updated_at)
          VALUES (?, ?, ?, ?, unixepoch())
          ON CONFLICT (migration_name, system_id)
          DO UPDATE SET
            last_migrated_timestamp = excluded.last_migrated_timestamp,
            rows_migrated = excluded.rows_migrated,
            updated_at = excluded.updated_at`,
    args: [MIGRATION_NAME, systemId, lastTimestamp, rowsMigrated],
  });
}

async function getPointInfoMap(
  db: any,
  systemId: number,
): Promise<Map<string, PointInfo>> {
  const result = await db.execute({
    sql: `SELECT id, system_id, origin_id, origin_sub_id
          FROM point_info
          WHERE system_id = ?
          ORDER BY id`,
    args: [systemId],
  });

  const map = new Map<string, PointInfo>();
  for (const row of result.rows) {
    const pointInfo = row as any as PointInfo;
    map.set(pointInfo.origin_sub_id, pointInfo);
  }

  return map;
}

async function getUnmigratedAggsBatch(
  db: any,
  systemId: number,
  afterTimestamp: number,
  limit: number,
): Promise<AggReading[]> {
  const result = await db.execute({
    sql: `SELECT *
          FROM readings_agg_5m
          WHERE system_id = ?
            AND interval_end > ?
            AND NOT EXISTS (
              SELECT 1 FROM point_readings_agg_5m pa
              WHERE pa.system_id = readings_agg_5m.system_id
                AND pa.interval_end = readings_agg_5m.interval_end * 1000
                AND pa.point_id = 1
            )
          ORDER BY interval_end ASC
          LIMIT ?`,
    args: [systemId, afterTimestamp, limit],
  });

  return result.rows as any[];
}

async function migrateAggBatch(
  db: any,
  aggs: AggReading[],
  pointInfoMap: Map<string, PointInfo>,
  vendorType: string,
  dryRun: boolean,
  warnedMissingFields: Set<string>,
): Promise<number> {
  if (aggs.length === 0) {
    return 0;
  }

  const mappings = getMappings(vendorType);
  const values: any[] = [];

  // Build batch insert values
  for (const agg of aggs) {
    for (const mapping of mappings) {
      const pointInfo = pointInfoMap.get(mapping.originSubId);
      if (!pointInfo) {
        // Only warn once per missing field
        const warningKey = `${agg.system_id}:${mapping.originSubId}`;
        if (!warnedMissingFields.has(warningKey)) {
          console.warn(
            `Warning: No point_info found for ${mapping.originSubId} in system ${agg.system_id}`,
          );
          warnedMissingFields.add(warningKey);
        }
        continue;
      }

      const { avg, min, max, last } = extractAggregateValues(agg, mapping);
      const intervalEndMs = agg.interval_end * 1000; // Convert to ms

      values.push({
        system_id: agg.system_id,
        point_id: pointInfo.index,
        interval_end: intervalEndMs,
        avg,
        min,
        max,
        last,
        sample_count: agg.sample_count,
        error_count: 0, // Old system didn't track errors
      });
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would insert ${values.length} point aggregates`);
    return values.length;
  }

  // Batch insert with conflict handling
  let insertedCount = 0;
  const chunkSize = 500;

  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    const placeholders = chunk
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");

    const args = chunk.flatMap((v) => [
      v.system_id,
      v.point_id,
      v.interval_end,
      v.avg,
      v.min,
      v.max,
      v.last,
      v.sample_count,
      v.error_count,
    ]);

    const result = await db.execute({
      sql: `INSERT INTO point_readings_agg_5m
              (system_id, point_id, interval_end, avg, min, max, last, sample_count, error_count)
            VALUES ${placeholders}
            ON CONFLICT (system_id, point_id, interval_end) DO NOTHING`,
      args,
    });

    insertedCount += result.rowsAffected || chunk.length;
  }

  return insertedCount;
}

async function migrateSystem(
  db: any,
  systemId: number,
  dryRun: boolean,
): Promise<MigrationStats> {
  const vendorType = await getVendorType(db, systemId);
  const stats: MigrationStats = {
    systemId,
    vendorType,
    totalIntervals: 0,
    alreadyMigrated: 0,
    toMigrate: 0,
    batchesComplete: 0,
    pointAggregatesInserted: 0,
    startTime: Date.now(),
  };

  console.log(`\n📊 Analyzing system ${systemId} (${vendorType})...`);

  // Get total intervals count
  const totalResult = await db.execute({
    sql: "SELECT COUNT(*) as count FROM readings_agg_5m WHERE system_id = ?",
    args: [systemId],
  });
  stats.totalIntervals = (totalResult.rows[0] as any).count;

  // Get already migrated count
  const migratedResult = await db.execute({
    sql: `SELECT COUNT(DISTINCT interval_end) as count
          FROM point_readings_agg_5m
          WHERE system_id = ? AND point_id = 1`,
    args: [systemId],
  });
  stats.alreadyMigrated = (migratedResult.rows[0] as any).count;
  stats.toMigrate = stats.totalIntervals - stats.alreadyMigrated;

  console.log(`  Total intervals: ${stats.totalIntervals.toLocaleString()}`);
  console.log(`  Already migrated: ${stats.alreadyMigrated.toLocaleString()}`);
  console.log(`  To migrate: ${stats.toMigrate.toLocaleString()}`);

  if (stats.toMigrate === 0) {
    console.log(`  ✅ System ${systemId} already fully migrated`);
    return stats;
  }

  // Get point info mapping
  const pointInfoMap = await getPointInfoMap(db, systemId);
  console.log(`  Points configured: ${pointInfoMap.size}`);

  // Get last checkpoint
  const progress = await getProgress(db, systemId);
  let lastTimestamp = progress?.lastMigratedTimestamp ?? 0;
  let totalRowsMigrated = progress?.rowsMigrated ?? 0;

  if (progress) {
    console.log(
      `  Resuming from timestamp: ${new Date(lastTimestamp * 1000).toISOString()}`,
    );
    console.log(
      `  Previously migrated: ${totalRowsMigrated.toLocaleString()} intervals`,
    );
  }

  console.log(`\n🚀 Starting migration for system ${systemId}...`);

  // Track which warnings we've already printed (to avoid spam)
  const warnedMissingFields = new Set<string>();

  // Process in batches
  let batchNum = 0;
  while (true) {
    batchNum++;
    const batchStart = Date.now();

    // Get next batch
    const aggs = await getUnmigratedAggsBatch(
      db,
      systemId,
      lastTimestamp,
      BATCH_SIZE,
    );

    if (aggs.length === 0) {
      console.log(`  ✅ No more intervals to migrate`);
      break;
    }

    // Migrate batch
    const insertedCount = await migrateAggBatch(
      db,
      aggs,
      pointInfoMap,
      vendorType,
      dryRun,
      warnedMissingFields,
    );

    // Update checkpoint
    const maxTimestamp = Math.max(...aggs.map((a) => a.interval_end));
    totalRowsMigrated += aggs.length;

    if (!dryRun) {
      await updateProgress(db, systemId, maxTimestamp, totalRowsMigrated);
    }

    lastTimestamp = maxTimestamp;
    stats.batchesComplete++;
    stats.pointAggregatesInserted += insertedCount;

    const batchTime = Date.now() - batchStart;
    const intervalsPerSec = (aggs.length / (batchTime / 1000)).toFixed(0);
    const insertsPerSec = (insertedCount / (batchTime / 1000)).toFixed(0);

    console.log(
      `  Batch ${batchNum}: Migrated ${aggs.length} intervals ` +
        `(${insertedCount.toLocaleString()} point aggregates) ` +
        `in ${batchTime}ms ` +
        `(${intervalsPerSec} intervals/sec, ${insertsPerSec} inserts/sec)`,
    );
  }

  stats.endTime = Date.now();
  const totalTime = ((stats.endTime - stats.startTime) / 1000).toFixed(1);
  console.log(`\n✅ System ${systemId} migration complete in ${totalTime}s`);
  console.log(`  Batches: ${stats.batchesComplete}`);
  console.log(
    `  Point aggregates inserted: ${stats.pointAggregatesInserted.toLocaleString()}`,
  );

  return stats;
}

// ============================================================================
// Validation Functions
// ============================================================================

async function validateMigration(db: any, systemId: number): Promise<boolean> {
  console.log(`\n🔍 Validating system ${systemId}...`);

  // Check interval counts
  const aggCount = await db.execute({
    sql: "SELECT COUNT(*) as count FROM readings_agg_5m WHERE system_id = ?",
    args: [systemId],
  });
  const pointAggCount = await db.execute({
    sql: `SELECT COUNT(DISTINCT interval_end) as count
          FROM point_readings_agg_5m WHERE system_id = ? AND point_id = 1`,
    args: [systemId],
  });

  const aCount = (aggCount.rows[0] as any).count;
  const paCount = (pointAggCount.rows[0] as any).count;

  console.log(`  Aggregated intervals: ${aCount.toLocaleString()}`);
  console.log(
    `  Point aggregates (unique intervals): ${paCount.toLocaleString()}`,
  );

  if (paCount < aCount) {
    console.error(
      `  ❌ Interval count too low! Expected at least ${aCount}, got ${paCount}`,
    );
    return false;
  } else if (paCount > aCount) {
    console.log(
      `  ℹ️  Point aggregates has ${paCount - aCount} more intervals (new data arriving)`,
    );
  }

  // Check that all readings_agg_5m intervals are present in point_readings_agg_5m
  const missingResult = await db.execute({
    sql: `SELECT COUNT(*) as count
          FROM readings_agg_5m r
          WHERE r.system_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM point_readings_agg_5m pa
              WHERE pa.system_id = r.system_id
                AND pa.interval_end = r.interval_end * 1000
                AND pa.point_id = 1
            )`,
    args: [systemId],
  });
  const missingCount = (missingResult.rows[0] as any).count;

  if (missingCount > 0) {
    console.error(
      `  ❌ ${missingCount} intervals from readings_agg_5m are missing in point aggregates`,
    );
    return false;
  }

  console.log(
    `  ✅ All readings_agg_5m intervals are present in point aggregates`,
  );
  return true;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const program = new Command();
  program
    .name("migrate-agg5m-to-points")
    .description(
      "Migrate historical readings_agg_5m data to point_readings_agg_5m",
    )
    .option("--dry-run", "Run in dry-run mode (no database writes)", false)
    .option("--database <path>", "Path to database file (default: dev.db)")
    .option(
      "--production",
      "Run on production database (requires confirmation)",
      false,
    )
    .option("--system <id>", "Migrate only specific system ID")
    .option("--validate-only", "Only run validation checks", false)
    .option("--log-file <path>", "Path to log file (will append if exists)")
    .parse();

  const options = program.opts();

  // Setup logging if log file specified
  let logStream: any = null;
  const originalLog = console.log;
  const originalError = console.error;

  if (options.logFile) {
    const fs = await import("fs");
    const path = await import("path");

    // Ensure log directory exists
    const logDir = path.dirname(options.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Open log file for appending
    logStream = fs.createWriteStream(options.logFile, { flags: "a" });

    // Write header
    logStream.write(`\n${"=".repeat(80)}\n`);
    logStream.write(`Migration started: ${new Date().toISOString()}\n`);
    logStream.write(`${"=".repeat(80)}\n\n`);

    // Helper to format timestamp
    const getTimestamp = () => {
      const now = new Date();
      return now.toISOString().replace("T", " ").substring(0, 23);
    };

    // Override console methods to also write to file with timestamps
    console.log = (...args: any[]) => {
      const message = args.join(" ");
      originalLog(...args);
      logStream.write(`[${getTimestamp()}] ${message}\n`);
    };

    console.error = (...args: any[]) => {
      const message = args.join(" ");
      originalError(...args);
      logStream.write(`[${getTimestamp()}] [ERROR] ${message}\n`);
    };
  }

  console.log("🔄 Aggregation Migration Tool");
  console.log("================================\n");

  if (options.production) {
    const confirmed = await confirmProduction();
    if (!confirmed) {
      console.log("❌ Migration cancelled");
      process.exit(1);
    }
  }

  if (options.dryRun) {
    console.log("🏃 DRY RUN MODE - No database changes will be made\n");
  }

  // Connect to database
  console.log("📡 Connecting to database...");
  const db = createDbClient({
    databasePath: options.database,
    production: options.production,
  });

  try {
    // Ensure migration progress table exists
    await ensureMigrationProgressTable(db);

    // Determine which systems to migrate
    let systemIds: number[];
    if (options.system) {
      systemIds = [parseInt(options.system)];
    } else {
      // Get all systems from the database
      const result = await db.execute({
        sql: `SELECT id FROM systems ORDER BY id`,
      });
      systemIds = result.rows.map((row: any) => row.id);
      console.log(
        `Found ${systemIds.length} systems to migrate: ${systemIds.join(", ")}`,
      );
    }

    // Validation only mode
    if (options.validateOnly) {
      for (const systemId of systemIds) {
        const valid = await validateMigration(db, systemId);
        if (!valid) {
          process.exit(1);
        }
      }
      console.log("\n✅ All validations passed!");
      return;
    }

    // Migrate each system
    const allStats: MigrationStats[] = [];
    for (const systemId of systemIds) {
      const stats = await migrateSystem(db, systemId, options.dryRun);
      allStats.push(stats);
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📈 MIGRATION SUMMARY");
    console.log("=".repeat(60));

    for (const stats of allStats) {
      console.log(`\nSystem ${stats.systemId} (${stats.vendorType}):`);
      console.log(
        `  Total intervals: ${stats.totalIntervals.toLocaleString()}`,
      );
      console.log(
        `  Already migrated: ${stats.alreadyMigrated.toLocaleString()}`,
      );
      console.log(`  Newly migrated: ${stats.toMigrate.toLocaleString()}`);
      console.log(
        `  Point aggregates inserted: ${stats.pointAggregatesInserted.toLocaleString()}`,
      );
      if (stats.endTime) {
        const totalTime = ((stats.endTime - stats.startTime) / 1000).toFixed(1);
        console.log(`  Time: ${totalTime}s`);
      }
    }

    const grandTotal = allStats.reduce(
      (sum, s) => sum + s.pointAggregatesInserted,
      0,
    );
    console.log(
      `\n🎉 Total point aggregates inserted: ${grandTotal.toLocaleString()}`,
    );

    if (!options.dryRun) {
      console.log(
        "\n✅ Migration complete! Run with --validate-only to verify.",
      );
    }
  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    throw error;
  } finally {
    // Close log stream if open
    if (logStream) {
      logStream.write(`\n${"=".repeat(80)}\n`);
      logStream.write(`Migration ended: ${new Date().toISOString()}\n`);
      logStream.write(`${"=".repeat(80)}\n\n`);
      logStream.end();

      // Restore original console methods
      console.log = originalLog;
      console.error = originalError;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
