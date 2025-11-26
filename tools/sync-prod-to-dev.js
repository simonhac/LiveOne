#!/usr/bin/env node

/**
 * Script to sync system 1 data from production (Turso) to local dev database
 * Usage: node scripts/sync-prod-to-dev.js
 */

const { createClient } = require("@libsql/client");
const Database = require("better-sqlite3");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const SYSTEM_ID = 1;

// Tables to sync (in dependency order)
// Note: Legacy tables (readings, readings_agg_5m, readings_agg_1d) are deprecated
// and no longer synced - use point_* tables instead
const TABLES = [
  { name: "systems", idColumn: "id", idType: "INTEGER" },
  { name: "polling_status", idColumn: "system_id", idType: "INTEGER" },
  { name: "point_info", idColumn: "system_id", idType: "INTEGER" },
  { name: "point_readings", idColumn: "system_id", idType: "INTEGER" },
  { name: "point_readings_agg_5m", idColumn: "system_id", idType: "INTEGER" },
  { name: "point_readings_agg_1d", idColumn: "system_id", idType: "INTEGER" },
];

async function main() {
  console.log("🔄 Syncing System 1 data from production to dev database...\n");

  // Check environment variables
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error(
      "❌ Error: Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in .env.local",
    );
    process.exit(1);
  }

  try {
    // Connect to production database (Turso)
    console.log("📡 Connecting to production database...");
    const prodDb = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    // Connect to local dev database
    console.log("💾 Connecting to local dev database...");
    const devDb = new Database("dev.db");

    // Enable foreign keys in local database
    devDb.exec("PRAGMA foreign_keys = ON");

    console.log("\n📥 Fetching data from production...\n");

    const exportedData = {};

    for (const table of TABLES) {
      process.stdout.write(`  - ${table.name}... `);

      let query;
      let params;

      if (table.idType === "TEXT") {
        query = `SELECT * FROM ${table.name} WHERE ${table.idColumn} = ?`;
        params = [String(SYSTEM_ID)];
      } else {
        query = `SELECT * FROM ${table.name} WHERE ${table.idColumn} = ?`;
        params = [SYSTEM_ID];
      }

      const result = await prodDb.execute({ sql: query, args: params });
      exportedData[table.name] = result.rows;
      console.log(`${result.rows.length} rows`);
    }

    console.log("\n🗑️  Clearing existing system 1 data from dev database...\n");

    // Clear in reverse order to respect foreign keys
    for (let i = TABLES.length - 1; i >= 0; i--) {
      const table = TABLES[i];
      process.stdout.write(`  - ${table.name}... `);

      let deleteQuery;
      if (table.idType === "TEXT") {
        deleteQuery = `DELETE FROM ${table.name} WHERE ${table.idColumn} = '${SYSTEM_ID}'`;
      } else {
        deleteQuery = `DELETE FROM ${table.name} WHERE ${table.idColumn} = ${SYSTEM_ID}`;
      }

      try {
        const result = devDb.prepare(deleteQuery).run();
        console.log(`${result.changes} rows deleted`);
      } catch (error) {
        console.log(`skipped (table may not exist)`);
      }
    }

    console.log("\n📤 Importing data to dev database...\n");

    // Import in correct order
    for (const table of TABLES) {
      const data = exportedData[table.name];

      if (!data || data.length === 0) {
        console.log(`  - ${table.name}: no data to import`);
        continue;
      }

      process.stdout.write(
        `  - ${table.name}: importing ${data.length} rows... `,
      );

      // Get column names from first row
      const columns = Object.keys(data[0]);
      const placeholders = columns.map(() => "?").join(", ");
      const insertQuery = `INSERT INTO ${table.name} (${columns.join(", ")}) VALUES (${placeholders})`;

      const stmt = devDb.prepare(insertQuery);

      // Use transaction for better performance
      const insertMany = devDb.transaction((rows) => {
        for (const row of rows) {
          // Convert row object to array of values in correct order
          const values = columns.map((col) => {
            const value = row[col];
            // Handle BigInt conversion
            if (typeof value === "bigint") {
              return Number(value);
            }
            return value;
          });
          stmt.run(values);
        }
      });

      try {
        insertMany(data);
        console.log("✓");
      } catch (error) {
        console.log(`❌ Error: ${error.message}`);
      }
    }

    console.log("\n📊 Verification:\n");

    // Verify imported data
    const counts = {
      systems:
        devDb
          .prepare("SELECT COUNT(*) as count FROM systems WHERE id = ?")
          .get(SYSTEM_ID)?.count || 0,
      polling_status:
        devDb
          .prepare(
            "SELECT COUNT(*) as count FROM polling_status WHERE system_id = ?",
          )
          .get(SYSTEM_ID)?.count || 0,
      point_info:
        devDb
          .prepare(
            "SELECT COUNT(*) as count FROM point_info WHERE system_id = ?",
          )
          .get(SYSTEM_ID)?.count || 0,
      point_readings:
        devDb
          .prepare(
            "SELECT COUNT(*) as count FROM point_readings WHERE system_id = ?",
          )
          .get(SYSTEM_ID)?.count || 0,
      point_readings_agg_5m:
        devDb
          .prepare(
            "SELECT COUNT(*) as count FROM point_readings_agg_5m WHERE system_id = ?",
          )
          .get(SYSTEM_ID)?.count || 0,
      point_readings_agg_1d:
        devDb
          .prepare(
            "SELECT COUNT(*) as count FROM point_readings_agg_1d WHERE system_id = ?",
          )
          .get(SYSTEM_ID)?.count || 0,
    };

    console.log(`  Systems:            ${counts.systems} records`);
    console.log(`  Polling Status:     ${counts.polling_status} records`);
    console.log(`  Point Info:         ${counts.point_info} records`);
    console.log(`  Point Readings:     ${counts.point_readings} records`);
    console.log(
      `  Point 5-min Agg:    ${counts.point_readings_agg_5m} records`,
    );
    console.log(
      `  Point Daily Agg:    ${counts.point_readings_agg_1d} records`,
    );

    // Show date range from point_readings
    const dateRange = devDb
      .prepare(
        `
      SELECT
        datetime(MIN(measurement_time) / 1000, 'unixepoch') as first_date,
        datetime(MAX(measurement_time) / 1000, 'unixepoch') as last_date
      FROM point_readings
      WHERE system_id = ?
    `,
      )
      .get(SYSTEM_ID);

    if (dateRange && dateRange.first_date) {
      console.log(
        `\n📅 Date range: ${dateRange.first_date} to ${dateRange.last_date}`,
      );
    }

    // Close connections
    devDb.close();

    console.log(
      "\n✅ Sync complete! System 1 data has been copied from production to dev.db",
    );
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    process.exit(1);
  }
}

// Run the script
main().catch(console.error);
