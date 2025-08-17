-- Fix created_at column to use integer Unix timestamps instead of text
-- For production database with new schema (solar_w, etc.)

-- Backup and recreate readings table with proper timestamp storage
CREATE TABLE readings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
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
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Copy data with converted timestamps
INSERT INTO readings_new 
SELECT 
  id, system_id, inverter_time, received_time, delay_seconds,
  solar_w, solar_inverter_w, shunt_w, load_w, battery_w, grid_w,
  battery_soc, fault_code, fault_timestamp, generator_status,
  solar_kwh_total, load_kwh_total, battery_in_kwh_total, battery_out_kwh_total,
  grid_in_kwh_total, grid_out_kwh_total,
  strftime('%s', created_at) as created_at
FROM readings;

-- Drop old table and rename new one
DROP TABLE readings;
ALTER TABLE readings_new RENAME TO readings;

-- Recreate indexes
CREATE INDEX system_inverter_time_idx ON readings (system_id, inverter_time);
CREATE INDEX inverter_time_idx ON readings (inverter_time);
CREATE INDEX received_time_idx ON readings (received_time);

-- Fix polling_status table
CREATE TABLE polling_status_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  last_poll_time INTEGER,
  last_success_time INTEGER,
  last_error_time INTEGER,
  last_error TEXT,
  last_response TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  total_polls INTEGER NOT NULL DEFAULT 0,
  successful_polls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO polling_status_new
SELECT 
  id, system_id, last_poll_time, last_success_time, last_error_time,
  last_error, last_response, consecutive_errors, is_active, 
  total_polls, successful_polls,
  strftime('%s', updated_at) as updated_at
FROM polling_status;

DROP TABLE polling_status;
ALTER TABLE polling_status_new RENAME TO polling_status;
CREATE INDEX polling_system_idx ON polling_status (system_id);

-- Fix systems table  
CREATE TABLE systems_new (
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

INSERT INTO systems_new
SELECT 
  id, user_id, system_number, display_name, model, serial,
  ratings, solar_size, battery_size,
  strftime('%s', created_at) as created_at,
  strftime('%s', updated_at) as updated_at
FROM systems;

DROP TABLE systems;
ALTER TABLE systems_new RENAME TO systems;
CREATE INDEX user_system_idx ON systems (user_id, system_number);

-- Verify the fix worked
SELECT 
  'readings' as table_name,
  typeof(created_at) as type,
  created_at as sample_value
FROM readings 
WHERE id = (SELECT MAX(id) FROM readings)
UNION ALL
SELECT 
  'polling_status',
  typeof(updated_at),
  updated_at
FROM polling_status 
WHERE id = (SELECT MAX(id) FROM polling_status)
UNION ALL  
SELECT 
  'systems',
  typeof(created_at),
  created_at
FROM systems 
WHERE id = (SELECT MAX(id) FROM systems);