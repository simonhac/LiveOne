-- Migration: Rename solar fields and add interval energy columns
-- Date: 2025-01-21
-- Changes:
--   1. Rename shunt_w -> solar_local_w
--   2. Rename solar_inverter_w -> solar_remote_w
--   3. Add interval energy columns (in Wh as integers)
--   4. Fields remain nullable as per current schema
--   5. Keep old table as backup (readings_backup_before_intervals)

-- Create new readings table with correct schema
CREATE TABLE readings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  
  -- Timestamp management
  inverter_time INTEGER NOT NULL,
  received_time INTEGER NOT NULL,
  delay_seconds INTEGER,
  
  -- Power readings (Watts, stored as integers)
  solar_w INTEGER,
  solar_local_w INTEGER,   -- Renamed from shunt_w
  solar_remote_w INTEGER,  -- Renamed from solar_inverter_w
  load_w INTEGER,
  battery_w INTEGER,
  grid_w INTEGER,
  
  -- Battery data
  battery_soc REAL,
  
  -- System status
  fault_code INTEGER,
  fault_timestamp INTEGER,
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

-- Copy data from old table to new, mapping renamed columns
INSERT INTO readings_new (
  id,
  system_id,
  inverter_time,
  received_time,
  delay_seconds,
  solar_w,
  solar_local_w,    -- Map from shunt_w
  solar_remote_w,   -- Map from solar_inverter_w
  load_w,
  battery_w,
  grid_w,
  battery_soc,
  fault_code,
  fault_timestamp,
  generator_status,
  -- New interval columns default to NULL
  solar_wh_interval,
  load_wh_interval,
  battery_in_wh_interval,
  battery_out_wh_interval,
  grid_in_wh_interval,
  grid_out_wh_interval,
  -- Lifetime totals
  solar_kwh_total,
  load_kwh_total,
  battery_in_kwh_total,
  battery_out_kwh_total,
  grid_in_kwh_total,
  grid_out_kwh_total,
  created_at
)
SELECT 
  id,
  system_id,
  inverter_time,
  received_time,
  delay_seconds,
  solar_w,
  shunt_w,           -- Old column name -> solar_local_w
  solar_inverter_w,  -- Old column name -> solar_remote_w
  load_w,
  battery_w,
  grid_w,
  battery_soc,
  fault_code,
  fault_timestamp,
  generator_status,
  NULL,  -- solar_wh_interval
  NULL,  -- load_wh_interval
  NULL,  -- battery_in_wh_interval
  NULL,  -- battery_out_wh_interval
  NULL,  -- grid_in_wh_interval
  NULL,  -- grid_out_wh_interval
  solar_kwh_total,
  load_kwh_total,
  battery_in_kwh_total,
  battery_out_kwh_total,
  grid_in_kwh_total,
  grid_out_kwh_total,
  created_at
FROM readings;

-- Rename old table as backup
ALTER TABLE readings RENAME TO readings_backup_before_intervals;

-- Rename new table
ALTER TABLE readings_new RENAME TO readings;

-- Recreate indexes
CREATE UNIQUE INDEX readings_system_inverter_time_unique ON readings(system_id, inverter_time);
CREATE INDEX system_inverter_time_idx ON readings(system_id, inverter_time);
CREATE INDEX inverter_time_idx ON readings(inverter_time);
CREATE INDEX received_time_idx ON readings(received_time);