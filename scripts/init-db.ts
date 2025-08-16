#!/usr/bin/env tsx

/**
 * Initialize the database with tables
 * Run with: tsx scripts/init-db.ts
 */

import Database from 'better-sqlite3';
import { DATABASE_CONFIG } from '../config';

const dbPath = DATABASE_CONFIG.url.replace('file:', '');
console.log(`Initializing database at: ${dbPath}`);

const db = new Database(dbPath);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Create tables
const createTables = () => {
  // Systems table
  db.exec(`
    CREATE TABLE IF NOT EXISTS systems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      system_number TEXT NOT NULL,
      display_name TEXT,
      model TEXT,
      serial TEXT,
      ratings TEXT,
      solar_size TEXT,
      battery_size TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS user_system_idx ON systems (user_id, system_number)`);
  
  // Readings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id INTEGER NOT NULL,
      inverter_time INTEGER NOT NULL,
      received_time INTEGER NOT NULL,
      delay_seconds INTEGER,
      solar_power REAL NOT NULL,
      load_power REAL NOT NULL,
      battery_power REAL NOT NULL,
      grid_power REAL NOT NULL,
      battery_soc REAL NOT NULL,
      solar_wh_today REAL,
      load_wh_today REAL,
      battery_in_wh_today REAL,
      battery_out_wh_today REAL,
      grid_in_wh_today REAL,
      grid_out_wh_today REAL,
      solar_wh_total REAL,
      load_wh_total REAL,
      battery_in_wh_total REAL,
      battery_out_wh_total REAL,
      grid_in_wh_total REAL,
      grid_out_wh_total REAL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
    )
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS system_inverter_time_idx ON readings (system_id, inverter_time)`);
  db.exec(`CREATE INDEX IF NOT EXISTS inverter_time_idx ON readings (inverter_time)`);
  db.exec(`CREATE INDEX IF NOT EXISTS received_time_idx ON readings (received_time)`);
  
  // Hourly aggregates
  db.exec(`
    CREATE TABLE IF NOT EXISTS hourly_aggregates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id INTEGER NOT NULL,
      hour_start INTEGER NOT NULL,
      avg_solar_power REAL NOT NULL,
      avg_load_power REAL NOT NULL,
      avg_battery_power REAL NOT NULL,
      avg_grid_power REAL NOT NULL,
      max_solar_power REAL NOT NULL,
      max_load_power REAL NOT NULL,
      max_battery_charge REAL NOT NULL,
      max_battery_discharge REAL NOT NULL,
      max_grid_import REAL NOT NULL,
      max_grid_export REAL NOT NULL,
      min_battery_soc REAL NOT NULL,
      max_battery_soc REAL NOT NULL,
      avg_battery_soc REAL NOT NULL,
      solar_energy REAL NOT NULL,
      load_energy REAL NOT NULL,
      battery_charge_energy REAL NOT NULL,
      battery_discharge_energy REAL NOT NULL,
      grid_import_energy REAL NOT NULL,
      grid_export_energy REAL NOT NULL,
      reading_count INTEGER NOT NULL,
      avg_delay_seconds REAL,
      max_delay_seconds INTEGER,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
    )
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS system_hour_idx ON hourly_aggregates (system_id, hour_start)`);
  
  // Daily aggregates
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_aggregates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id INTEGER NOT NULL,
      date INTEGER NOT NULL,
      solar_energy REAL NOT NULL,
      load_energy REAL NOT NULL,
      battery_charge_energy REAL NOT NULL,
      battery_discharge_energy REAL NOT NULL,
      grid_import_energy REAL NOT NULL,
      grid_export_energy REAL NOT NULL,
      peak_solar_power REAL NOT NULL,
      peak_load_power REAL NOT NULL,
      peak_solar_time INTEGER,
      min_battery_soc REAL NOT NULL,
      max_battery_soc REAL NOT NULL,
      self_sufficiency_percent REAL,
      solar_utilization_percent REAL,
      total_readings INTEGER NOT NULL,
      avg_delay_seconds REAL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
    )
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS system_date_idx ON daily_aggregates (system_id, date)`);
  
  // Polling status
  db.exec(`
    CREATE TABLE IF NOT EXISTS polling_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id INTEGER NOT NULL,
      last_poll_time INTEGER,
      last_success_time INTEGER,
      last_error_time INTEGER,
      last_error TEXT,
      consecutive_errors INTEGER DEFAULT 0 NOT NULL,
      is_active INTEGER DEFAULT 1 NOT NULL,
      total_polls INTEGER DEFAULT 0 NOT NULL,
      successful_polls INTEGER DEFAULT 0 NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
    )
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS polling_system_idx ON polling_status (system_id)`);
};

try {
  createTables();
  
  // Verify tables were created
  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' 
    ORDER BY name
  `).all();
  
  console.log('✅ Database initialized successfully');
  console.log('📊 Tables created:');
  tables.forEach((table: any) => {
    const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get() as any;
    console.log(`   - ${table.name} (${count.count} rows)`);
  });
  
} catch (error) {
  console.error('❌ Failed to initialize database:', error);
  process.exit(1);
} finally {
  db.close();
}