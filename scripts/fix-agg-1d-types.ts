#!/usr/bin/env tsx

import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function main() {
  console.log('Fixing readings_agg_1d column types in production...\n');
  
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  try {
    // First, check if any data exists
    const countResult = await client.execute('SELECT COUNT(*) as count FROM readings_agg_1d');
    const count = countResult.rows[0]?.count || 0;
    console.log(`Found ${count} existing rows in readings_agg_1d`);
    
    // Run the migration to fix column types
    console.log('\nApplying column type fixes...');
    
    await client.batch([
      'PRAGMA foreign_keys=OFF',
      `CREATE TABLE __new_readings_agg_1d (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        system_id TEXT NOT NULL,
        day TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
        solar_kwh REAL,
        load_kwh REAL,
        battery_charge_kwh REAL,
        battery_discharge_kwh REAL,
        grid_import_kwh REAL,
        grid_export_kwh REAL,
        solar_w_min INTEGER,
        solar_w_avg INTEGER,
        solar_w_max INTEGER,
        load_w_min INTEGER,
        load_w_avg INTEGER,
        load_w_max INTEGER,
        battery_w_min INTEGER,
        battery_w_avg INTEGER,
        battery_w_max INTEGER,
        grid_w_min INTEGER,
        grid_w_avg INTEGER,
        grid_w_max INTEGER,
        battery_soc_max REAL,
        battery_soc_min REAL,
        battery_soc_avg REAL,
        battery_soc_end REAL,
        solar_alltime_kwh REAL,
        load_alltime_kwh REAL,
        battery_charge_alltime_kwh REAL,
        battery_discharge_alltime_kwh REAL,
        grid_import_alltime_kwh REAL,
        grid_export_alltime_kwh REAL,
        interval_count INTEGER,
        version INTEGER DEFAULT 1
      )`,
      `INSERT INTO __new_readings_agg_1d 
        SELECT 
          id, system_id, day, created_at, updated_at,
          solar_kwh, load_kwh, battery_charge_kwh, battery_discharge_kwh,
          grid_import_kwh, grid_export_kwh,
          CAST(solar_w_min AS INTEGER),
          CAST(solar_w_avg AS INTEGER),
          CAST(solar_w_max AS INTEGER),
          CAST(load_w_min AS INTEGER),
          CAST(load_w_avg AS INTEGER),
          CAST(load_w_max AS INTEGER),
          CAST(battery_w_min AS INTEGER),
          CAST(battery_w_avg AS INTEGER),
          CAST(battery_w_max AS INTEGER),
          CAST(grid_w_min AS INTEGER),
          CAST(grid_w_avg AS INTEGER),
          CAST(grid_w_max AS INTEGER),
          battery_soc_max, battery_soc_min, battery_soc_avg, battery_soc_end,
          solar_alltime_kwh, load_alltime_kwh,
          battery_charge_alltime_kwh, battery_discharge_alltime_kwh,
          grid_import_alltime_kwh, grid_export_alltime_kwh,
          interval_count, version
        FROM readings_agg_1d`,
      'DROP TABLE readings_agg_1d',
      'ALTER TABLE __new_readings_agg_1d RENAME TO readings_agg_1d',
      'PRAGMA foreign_keys=ON',
      'CREATE UNIQUE INDEX idx_readings_agg_1d_system_day ON readings_agg_1d (system_id, day)',
      'CREATE INDEX idx_readings_agg_1d_day ON readings_agg_1d (day)',
      'CREATE INDEX idx_readings_agg_1d_updated ON readings_agg_1d (updated_at)',
    ]);
    
    console.log('✅ Column types fixed successfully!');
    
    // Verify the fix
    const verifyResult = await client.execute('SELECT COUNT(*) as count FROM readings_agg_1d');
    const newCount = verifyResult.rows[0]?.count || 0;
    console.log(`\n✓ Verified: ${newCount} rows in readings_agg_1d after migration`);
    
  } catch (error) {
    console.error('❌ Error fixing column types:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

main().catch(console.error);