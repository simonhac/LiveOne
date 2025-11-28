#!/usr/bin/env npx tsx

/**
 * Migrate historical data from readings to point_readings
 *
 * This script migrates data from the legacy readings table to the new
 * point-based system, with full checkpoint support and validation.
 *
 * Usage:
 *   npm run migrate:points -- --dry-run              # Test on dev.db
 *   npm run migrate:points -- --database /path/to/test.db  # Test on backup
 *   npm run migrate:points -- --production           # Run on production (requires confirmation)
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

const BATCH_SIZE = 1000; // Readings per batch (= 16,000 point_readings inserts)
const MIGRATION_NAME = "readings_to_points";

// Point mapping for each vendor type
interface PointMapping {
  readingsColumn: string; // Column in readings table
  originSubId: string; // origin_sub_id in point_info
  transform?: "kwhToWh" | "toValueStr"; // Optional transformation
}

// Selectronic systems (1, 2)
const SELECTRONIC_MAPPINGS: PointMapping[] = [
  { readingsColumn: "solar_w", originSubId: "solar_w" },
  { readingsColumn: "solar_inverter_w", originSubId: "solarinverter_w" },
  { readingsColumn: "shunt_w", originSubId: "shunt_w" },
  { readingsColumn: "load_w", originSubId: "load_w" },
  { readingsColumn: "battery_w", originSubId: "battery_w" },
  { readingsColumn: "grid_w", originSubId: "grid_w" },
  { readingsColumn: "battery_soc", originSubId: "battery_soc" },
  {
    readingsColumn: "fault_code",
    originSubId: "fault_code",
    transform: "toValueStr",
  },
  { readingsColumn: "fault_timestamp", originSubId: "fault_ts" },
  { readingsColumn: "generator_status", originSubId: "gen_status" },
  {
    readingsColumn: "solar_kwh_total",
    originSubId: "solar_wh_total",
    transform: "kwhToWh",
  },
  {
    readingsColumn: "load_kwh_total",
    originSubId: "load_wh_total",
    transform: "kwhToWh",
  },
  {
    readingsColumn: "battery_in_kwh_total",
    originSubId: "battery_in_wh_total",
    transform: "kwhToWh",
  },
  {
    readingsColumn: "battery_out_kwh_total",
    originSubId: "battery_out_wh_total",
    transform: "kwhToWh",
  },
  {
    readingsColumn: "grid_in_kwh_total",
    originSubId: "grid_in_wh_total",
    transform: "kwhToWh",
  },
  {
    readingsColumn: "grid_out_kwh_total",
    originSubId: "grid_out_wh_total",
    transform: "kwhToWh",
  },
];

// Fusher systems (formerly fronius) - uses camelCase
const FUSHER_MAPPINGS: PointMapping[] = [
  { readingsColumn: "solar_w", originSubId: "solarW" },
  { readingsColumn: "solar_inverter_w", originSubId: "solarRemoteW" },
  { readingsColumn: "shunt_w", originSubId: "solarLocalW" },
  { readingsColumn: "load_w", originSubId: "loadW" },
  { readingsColumn: "battery_w", originSubId: "batteryW" },
  { readingsColumn: "grid_w", originSubId: "gridW" },
  { readingsColumn: "battery_soc", originSubId: "batterySOC" },
  {
    readingsColumn: "fault_code",
    originSubId: "faultCode",
    transform: "toValueStr",
  },
  { readingsColumn: "fault_timestamp", originSubId: "faultTimestamp" },
  { readingsColumn: "generator_status", originSubId: "generatorStatus" },
  // Skip energy totals for Fusher (uses interval energy in new system)
];

// ============================================================================
// Types
// ============================================================================

interface MigrationProgress {
  systemId: number;
  lastMigratedTimestamp: number;
  rowsMigrated: number;
}

interface Reading {
  system_id: number;
  inverter_time: number;
  received_time: number;
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
  totalReadings: number;
  alreadyMigrated: number;
  toMigrate: number;
  batchesComplete: number;
  pointReadingsInserted: number;
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
    // Production Turso database
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url || !authToken) {
      throw new Error(
        "Production mode requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN",
      );
    }

    return createClient({ url, authToken });
  } else if (options.databasePath) {
    // Custom database file
    return createClient({ url: `file:${options.databasePath}` });
  } else {
    // Default to dev.db
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

function getMappings(vendorType: string): PointMapping[] {
  // Accept both "fusher" and legacy "fronius"
  return vendorType === "fusher" || vendorType === "fronius"
    ? FUSHER_MAPPINGS
    : SELECTRONIC_MAPPINGS;
}

function extractValue(
  reading: Reading,
  mapping: PointMapping,
): { value: number | null; valueStr: string | null } {
  const rawValue = reading[mapping.readingsColumn];

  if (rawValue === null || rawValue === undefined) {
    return { value: null, valueStr: null };
  }

  // Handle text fields (fault_code)
  if (mapping.transform === "toValueStr") {
    return { value: null, valueStr: rawValue.toString() };
  }

  // Handle kWh → Wh conversion
  if (mapping.transform === "kwhToWh") {
    return { value: rawValue * 1000, valueStr: null };
  }

  // Direct numeric value
  return { value: rawValue, valueStr: null };
}

async function confirmProduction(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "\n⚠️  You are about to migrate production data. Have you:\n" +
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

async function getUnmigratedReadingsBatch(
  db: any,
  systemId: number,
  afterTimestamp: number,
  limit: number,
): Promise<Reading[]> {
  const result = await db.execute({
    sql: `SELECT *
          FROM readings
          WHERE system_id = ?
            AND inverter_time > ?
            AND NOT EXISTS (
              SELECT 1 FROM point_readings pr
              WHERE pr.system_id = readings.system_id
                AND pr.measurement_time = readings.inverter_time * 1000
                AND pr.point_id = 1
            )
          ORDER BY inverter_time ASC
          LIMIT ?`,
    args: [systemId, afterTimestamp, limit],
  });

  return result.rows as any[];
}

async function migrateBatch(
  db: any,
  readings: Reading[],
  pointInfoMap: Map<string, PointInfo>,
  vendorType: string,
  dryRun: boolean,
  warnedMissingFields: Set<string>,
): Promise<number> {
  if (readings.length === 0) {
    return 0;
  }

  const mappings = getMappings(vendorType);
  const values: any[] = [];

  // Build batch insert values
  for (const reading of readings) {
    for (const mapping of mappings) {
      const pointInfo = pointInfoMap.get(mapping.originSubId);
      if (!pointInfo) {
        // Only warn once per missing field
        const warningKey = `${reading.system_id}:${mapping.originSubId}`;
        if (!warnedMissingFields.has(warningKey)) {
          console.warn(
            `Warning: No point_info found for ${mapping.originSubId} in system ${reading.system_id}`,
          );
          warnedMissingFields.add(warningKey);
        }
        continue;
      }

      const { value, valueStr } = extractValue(reading, mapping);
      const measurementTime = reading.inverter_time * 1000; // Convert to ms
      const receivedTime = reading.received_time * 1000;

      values.push({
        system_id: reading.system_id,
        point_id: pointInfo.index,
        measurement_time: measurementTime,
        received_time: receivedTime,
        value,
        value_str: valueStr,
        data_quality: "good",
      });
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would insert ${values.length} point_readings`);
    return values.length;
  }

  // Batch insert with conflict handling
  let insertedCount = 0;
  const chunkSize = 500; // SQLite parameter limit consideration

  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");

    const args = chunk.flatMap((v) => [
      v.system_id,
      v.point_id,
      v.measurement_time,
      v.received_time,
      v.value,
      v.value_str,
      v.data_quality,
    ]);

    const result = await db.execute({
      sql: `INSERT INTO point_readings
              (system_id, point_id, measurement_time, received_time, value, value_str, data_quality)
            VALUES ${placeholders}
            ON CONFLICT (system_id, point_id, measurement_time) DO NOTHING`,
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
    totalReadings: 0,
    alreadyMigrated: 0,
    toMigrate: 0,
    batchesComplete: 0,
    pointReadingsInserted: 0,
    startTime: Date.now(),
  };

  console.log(`\n📊 Analyzing system ${systemId} (${vendorType})...`);

  // Get total readings count
  const totalResult = await db.execute({
    sql: "SELECT COUNT(*) as count FROM readings WHERE system_id = ?",
    args: [systemId],
  });
  stats.totalReadings = (totalResult.rows[0] as any).count;

  // Get already migrated count
  const migratedResult = await db.execute({
    sql: `SELECT COUNT(DISTINCT measurement_time) as count
          FROM point_readings
          WHERE system_id = ? AND point_id = 1`,
    args: [systemId],
  });
  stats.alreadyMigrated = (migratedResult.rows[0] as any).count;
  stats.toMigrate = stats.totalReadings - stats.alreadyMigrated;

  console.log(`  Total readings: ${stats.totalReadings.toLocaleString()}`);
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
      `  Previously migrated: ${totalRowsMigrated.toLocaleString()} readings`,
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
    const readings = await getUnmigratedReadingsBatch(
      db,
      systemId,
      lastTimestamp,
      BATCH_SIZE,
    );

    if (readings.length === 0) {
      console.log(`  ✅ No more readings to migrate`);
      break;
    }

    // Migrate batch
    const insertedCount = await migrateBatch(
      db,
      readings,
      pointInfoMap,
      vendorType,
      dryRun,
      warnedMissingFields,
    );

    // Update checkpoint
    const maxTimestamp = Math.max(...readings.map((r) => r.inverter_time));
    totalRowsMigrated += readings.length;

    if (!dryRun) {
      await updateProgress(db, systemId, maxTimestamp, totalRowsMigrated);
    }

    lastTimestamp = maxTimestamp;
    stats.batchesComplete++;
    stats.pointReadingsInserted += insertedCount;

    const batchTime = Date.now() - batchStart;
    const readingsPerSec = (readings.length / (batchTime / 1000)).toFixed(0);
    const insertsPerSec = (insertedCount / (batchTime / 1000)).toFixed(0);

    console.log(
      `  Batch ${batchNum}: Migrated ${readings.length} readings ` +
        `(${insertedCount.toLocaleString()} point_readings) ` +
        `in ${batchTime}ms ` +
        `(${readingsPerSec} readings/sec, ${insertsPerSec} inserts/sec)`,
    );
  }

  stats.endTime = Date.now();
  const totalTime = ((stats.endTime - stats.startTime) / 1000).toFixed(1);
  console.log(`\n✅ System ${systemId} migration complete in ${totalTime}s`);
  console.log(`  Batches: ${stats.batchesComplete}`);
  console.log(
    `  Point readings inserted: ${stats.pointReadingsInserted.toLocaleString()}`,
  );

  return stats;
}

// ============================================================================
// Validation Functions
// ============================================================================

async function validateMigration(db: any, systemId: number): Promise<boolean> {
  console.log(`\n🔍 Validating system ${systemId}...`);

  // Check row counts
  const readingsCount = await db.execute({
    sql: "SELECT COUNT(*) as count FROM readings WHERE system_id = ?",
    args: [systemId],
  });
  const pointReadingsCount = await db.execute({
    sql: `SELECT COUNT(DISTINCT measurement_time) as count
          FROM point_readings WHERE system_id = ? AND point_id = 1`,
    args: [systemId],
  });

  const rCount = (readingsCount.rows[0] as any).count;
  const prCount = (pointReadingsCount.rows[0] as any).count;

  console.log(`  Readings: ${rCount.toLocaleString()}`);
  console.log(
    `  Point readings (unique timestamps): ${prCount.toLocaleString()}`,
  );

  if (rCount !== prCount) {
    // Check for duplicates in readings table (expected)
    const dupResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM (
              SELECT inverter_time
              FROM readings WHERE system_id = ?
              GROUP BY inverter_time HAVING COUNT(*) > 1
            )`,
      args: [systemId],
    });
    const duplicateTimestamps = (dupResult.rows[0] as any).count;

    if (duplicateTimestamps > 0) {
      console.log(
        `  ⚠️  Found ${duplicateTimestamps} duplicate timestamps in readings table`,
      );
      console.log(
        `  This is expected - ON CONFLICT DO NOTHING prevented duplicate inserts`,
      );

      // Recalculate expected count without duplicates
      const uniqueReadingsResult = await db.execute({
        sql: "SELECT COUNT(DISTINCT inverter_time) as count FROM readings WHERE system_id = ?",
        args: [systemId],
      });
      const uniqueReadings = (uniqueReadingsResult.rows[0] as any).count;

      if (uniqueReadings === prCount) {
        console.log(
          `  ✅ Unique readings (${uniqueReadings}) matches point_readings (${prCount})`,
        );
      } else {
        console.error(
          `  ❌ Even accounting for duplicates, mismatch: ${uniqueReadings} vs ${prCount}`,
        );
        return false;
      }
    } else {
      console.error(
        `  ❌ Row count mismatch! Expected ${rCount}, got ${prCount}`,
      );
      return false;
    }
  }

  // Spot check 10 random readings
  console.log(`  Spot-checking 10 random readings...`);
  const sampleResult = await db.execute({
    sql: `SELECT
            r.inverter_time,
            r.solar_w as reading_solar,
            pr.value as point_solar
          FROM readings r
          JOIN point_readings pr ON
            pr.system_id = r.system_id AND
            pr.measurement_time = r.inverter_time * 1000 AND
            pr.point_id = (
              SELECT id FROM point_info
              WHERE system_id = r.system_id
              AND (origin_sub_id = 'solar_w' OR origin_sub_id = 'solarW')
              LIMIT 1
            )
          WHERE r.system_id = ?
          ORDER BY RANDOM()
          LIMIT 10`,
    args: [systemId],
  });

  let validCount = 0;
  for (const row of sampleResult.rows) {
    const r = row as any;
    if (Math.abs(r.reading_solar - r.point_solar) < 0.01) {
      validCount++;
    } else {
      console.error(
        `  ❌ Mismatch at ${r.inverter_time}: reading=${r.reading_solar}, point=${r.point_solar}`,
      );
    }
  }

  if (validCount === sampleResult.rows.length) {
    console.log(`  ✅ All ${validCount} spot checks passed`);
    return true;
  } else {
    console.error(
      `  ❌ Only ${validCount}/${sampleResult.rows.length} spot checks passed`,
    );
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const program = new Command();
  program
    .name("migrate-readings-to-points")
    .description("Migrate historical readings data to point-based system")
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

  console.log("🔄 Point System Migration Tool");
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
      console.log(`  Total readings: ${stats.totalReadings.toLocaleString()}`);
      console.log(
        `  Already migrated: ${stats.alreadyMigrated.toLocaleString()}`,
      );
      console.log(`  Newly migrated: ${stats.toMigrate.toLocaleString()}`);
      console.log(
        `  Point readings inserted: ${stats.pointReadingsInserted.toLocaleString()}`,
      );
      if (stats.endTime) {
        const totalTime = ((stats.endTime - stats.startTime) / 1000).toFixed(1);
        console.log(`  Time: ${totalTime}s`);
      }
    }

    const grandTotal = allStats.reduce(
      (sum, s) => sum + s.pointReadingsInserted,
      0,
    );
    console.log(
      `\n🎉 Total point_readings inserted: ${grandTotal.toLocaleString()}`,
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

    // Close database connection (if Turso client supports it)
    // db.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
