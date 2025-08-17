-- Fix timestamps from text/mixed to integer Unix timestamps only
-- Skip power column conversion since that's already done

-- Clean up any previous failed attempts
DROP TABLE IF EXISTS readings_fixed;
DROP TABLE IF EXISTS polling_status_fixed;
DROP TABLE IF EXISTS systems_fixed;

-- Disable foreign key checks during migration
PRAGMA foreign_keys = OFF;

-- 1. Fix readings table timestamps
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

INSERT INTO readings_fixed 
SELECT 
  id, 
  system_id, 
  inverter_time, 
  received_time, 
  delay_seconds,
  solar_w,
  solar_inverter_w,
  shunt_w,
  load_w,
  battery_w,
  grid_w,
  battery_soc,
  fault_code,
  fault_timestamp,
  generator_status,
  solar_kwh_total,
  load_kwh_total,
  battery_in_kwh_total,
  battery_out_kwh_total,
  grid_in_kwh_total,
  grid_out_kwh_total,
  CASE 
    WHEN typeof(created_at) = 'integer' THEN created_at
    ELSE CAST(strftime('%s', created_at) AS INTEGER)
  END as created_at
FROM readings;

DROP TABLE readings;
ALTER TABLE readings_fixed RENAME TO readings;

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
  CASE 
    WHEN typeof(updated_at) = 'integer' THEN updated_at
    WHEN updated_at IS NULL THEN CAST(strftime('%s', 'now') AS INTEGER)
    ELSE CAST(strftime('%s', updated_at) AS INTEGER)
  END as updated_at
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
  CASE 
    WHEN typeof(created_at) = 'integer' THEN created_at
    ELSE CAST(strftime('%s', created_at) AS INTEGER)
  END as created_at,
  CASE 
    WHEN typeof(updated_at) = 'integer' THEN updated_at
    ELSE CAST(strftime('%s', updated_at) AS INTEGER)
  END as updated_at
FROM systems;

DROP TABLE systems;
ALTER TABLE systems_fixed RENAME TO systems;
CREATE INDEX user_system_idx ON systems (user_id, system_number);

-- Re-enable foreign key checks
PRAGMA foreign_keys = ON;

-- Verify the fix
SELECT 
  'Migration Complete!' as info
UNION ALL
SELECT 
  'readings: ' || COUNT(*) || ' rows, created_at type: ' || typeof(created_at)
FROM readings 
UNION ALL
SELECT 
  'systems: ' || COUNT(*) || ' rows, created_at type: ' || typeof(created_at)
FROM systems 
UNION ALL
SELECT 
  'polling_status: ' || COUNT(*) || ' rows, updated_at type: ' || typeof(updated_at)
FROM polling_status;