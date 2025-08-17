-- Fix created_at timestamps from text to integer Unix timestamps
-- Safe version that handles NULL values in columns

-- First populate the new integer columns from the old float columns if they're NULL
UPDATE readings 
SET solar_w = ROUND(solar_power),
    solar_inverter_w = COALESCE(ROUND(solar_inverter_power), 0),
    shunt_w = COALESCE(ROUND(shunt_power), 0),
    load_w = ROUND(load_power),
    battery_w = ROUND(battery_power),
    grid_w = ROUND(grid_power)
WHERE solar_w IS NULL;

-- Now fix the timestamp columns by recreating tables with proper integer timestamps

-- 1. Fix readings table
CREATE TABLE readings_fixed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  inverter_time INTEGER NOT NULL,
  received_time INTEGER NOT NULL,
  delay_seconds INTEGER,
  solar_w INTEGER NOT NULL,
  solar_inverter_w INTEGER NOT NULL,
  shunt_w INTEGER NOT NULL,
  load_w INTEGER NOT NULL,
  battery_w INTEGER NOT NULL,
  grid_w INTEGER NOT NULL,
  battery_soc REAL NOT NULL,
  fault_code INTEGER NOT NULL,
  fault_timestamp INTEGER NOT NULL,
  generator_status INTEGER NOT NULL,
  solar_kwh_total REAL,
  load_kwh_total REAL,
  battery_in_kwh_total REAL,
  battery_out_kwh_total REAL,
  grid_in_kwh_total REAL,
  grid_out_kwh_total REAL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);

-- Copy data, converting text timestamps to integers and using new column names
INSERT INTO readings_fixed 
SELECT 
  id, 
  system_id, 
  inverter_time, 
  received_time, 
  delay_seconds,
  COALESCE(solar_w, ROUND(solar_power), 0) as solar_w,
  COALESCE(solar_inverter_w, ROUND(solar_inverter_power), 0) as solar_inverter_w,
  COALESCE(shunt_w, ROUND(shunt_power), 0) as shunt_w,
  COALESCE(load_w, ROUND(load_power), 0) as load_w,
  COALESCE(battery_w, ROUND(battery_power), 0) as battery_w,
  COALESCE(grid_w, ROUND(grid_power), 0) as grid_w,
  battery_soc,
  COALESCE(fault_code, 0) as fault_code,
  COALESCE(fault_timestamp, 0) as fault_timestamp,
  COALESCE(generator_status, 0) as generator_status,
  solar_kwh_total,
  load_kwh_total,
  battery_in_kwh_total,
  battery_out_kwh_total,
  grid_in_kwh_total,
  grid_out_kwh_total,
  CAST(strftime('%s', created_at) AS INTEGER) as created_at
FROM readings;

-- Drop old table and rename
DROP TABLE readings;
ALTER TABLE readings_fixed RENAME TO readings;

-- Recreate indexes
CREATE INDEX system_inverter_time_idx ON readings (system_id, inverter_time);
CREATE INDEX inverter_time_idx ON readings (inverter_time);
CREATE INDEX received_time_idx ON readings (received_time);

-- 2. Fix polling_status table
CREATE TABLE polling_status_fixed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  last_poll_time INTEGER,
  last_success_time INTEGER,
  last_error_time INTEGER,
  last_error TEXT,
  last_response TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  total_polls INTEGER NOT NULL DEFAULT 0,
  successful_polls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);

INSERT INTO polling_status_fixed
SELECT 
  id, 
  system_id, 
  last_poll_time, 
  last_success_time, 
  last_error_time,
  last_error, 
  last_response, 
  consecutive_errors, 
  is_active, 
  total_polls, 
  successful_polls,
  CAST(strftime('%s', updated_at) AS INTEGER) as updated_at
FROM polling_status;

DROP TABLE polling_status;
ALTER TABLE polling_status_fixed RENAME TO polling_status;
CREATE INDEX polling_system_idx ON polling_status (system_id);

-- 3. Fix systems table  
CREATE TABLE systems_fixed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  system_number TEXT NOT NULL,
  display_name TEXT,
  model TEXT,
  serial TEXT,
  ratings TEXT,
  solar_size TEXT,
  battery_size TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO systems_fixed
SELECT 
  id, 
  user_id, 
  system_number, 
  display_name, 
  model, 
  serial,
  ratings, 
  solar_size, 
  battery_size,
  CAST(strftime('%s', created_at) AS INTEGER) as created_at,
  CAST(strftime('%s', updated_at) AS INTEGER) as updated_at
FROM systems;

DROP TABLE systems;
ALTER TABLE systems_fixed RENAME TO systems;
CREATE INDEX user_system_idx ON systems (user_id, system_number);

-- Verify the fix
SELECT 
  'Test Results:' as info
UNION ALL
SELECT 
  'readings.created_at type: ' || typeof(created_at) || ', sample: ' || created_at
FROM readings 
WHERE id = (SELECT MAX(id) FROM readings)
UNION ALL
SELECT 
  'systems.created_at type: ' || typeof(created_at) || ', sample: ' || created_at
FROM systems 
WHERE id = (SELECT MAX(id) FROM systems)
UNION ALL
SELECT 
  'polling_status.updated_at type: ' || typeof(updated_at) || ', sample: ' || updated_at
FROM polling_status 
WHERE id = (SELECT MAX(id) FROM polling_status);