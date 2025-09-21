-- Migration: Change fault_code from INTEGER to TEXT
-- Date: 2025-01-21
-- Changes:
--   1. Change fault_code column from INTEGER to TEXT
--   2. Keep old table as backup (readings_backup_before_text_fault_code)

-- Step 1: Rename current table as backup
ALTER TABLE readings RENAME TO readings_backup_before_text_fault_code;

-- Step 2: Create new table with fault_code as TEXT
CREATE TABLE readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  system_id INTEGER NOT NULL,
  inverter_time INTEGER NOT NULL, -- Unix timestamp from inverter
  received_time INTEGER NOT NULL, -- Unix timestamp when received by server
  delay_seconds INTEGER,
  
  -- Power readings (Watts)
  solar_w INTEGER,
  solar_local_w INTEGER,   -- Local solar from shunt/CT
  solar_remote_w INTEGER,  -- Remote solar from inverter
  load_w INTEGER,
  battery_w INTEGER,
  grid_w INTEGER,
  
  -- Battery data
  battery_soc REAL,
  
  -- System status
  fault_code TEXT,  -- Changed from INTEGER to TEXT
  fault_timestamp INTEGER, -- Unix timestamp of fault
  generator_status INTEGER,
  
  -- Energy counters (Wh) - interval values (energy in this period)
  solar_wh_interval INTEGER,
  load_wh_interval INTEGER,
  battery_in_wh_interval INTEGER,
  battery_out_wh_interval INTEGER,
  grid_in_wh_interval INTEGER,
  grid_out_wh_interval INTEGER,
  
  -- Energy counters (kWh) - lifetime totals
  solar_kwh_total REAL,
  load_kwh_total REAL,
  battery_in_kwh_total REAL,
  battery_out_kwh_total REAL,
  grid_in_kwh_total REAL,
  grid_out_kwh_total REAL,
  
  -- Database metadata
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 3: Copy data from backup table, converting fault_code to text
INSERT INTO readings 
SELECT 
  id,
  system_id,
  inverter_time,
  received_time,
  delay_seconds,
  solar_w,
  solar_local_w,
  solar_remote_w,
  load_w,
  battery_w,
  grid_w,
  battery_soc,
  CASE 
    WHEN fault_code IS NULL THEN NULL
    ELSE CAST(fault_code AS TEXT)
  END,  -- Convert fault_code to TEXT, preserving NULLs
  fault_timestamp,
  generator_status,
  solar_wh_interval,
  load_wh_interval,
  battery_in_wh_interval,
  battery_out_wh_interval,
  grid_in_wh_interval,
  grid_out_wh_interval,
  solar_kwh_total,
  load_kwh_total,
  battery_in_kwh_total,
  battery_out_kwh_total,
  grid_in_kwh_total,
  grid_out_kwh_total,
  created_at
FROM readings_backup_before_text_fault_code;

-- Step 4: Recreate indexes
CREATE UNIQUE INDEX readings_system_inverter_time_unique ON readings (system_id, inverter_time);
CREATE INDEX system_inverter_time_idx ON readings (system_id, inverter_time);
CREATE INDEX inverter_time_idx ON readings (inverter_time);
CREATE INDEX received_time_idx ON readings (received_time);

-- Step 5: Verify the migration
-- You can check the backup table with: SELECT * FROM readings_backup_before_text_fault_code LIMIT 5;
-- To rollback: DROP TABLE readings; ALTER TABLE readings_backup_before_text_fault_code RENAME TO readings;