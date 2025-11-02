-- Migration: Convert point_info, point_readings, and point_readings_agg_5m to use composite primary keys
-- This migration changes point_info to use (system_id, id) as composite PK instead of auto-increment id

-- Step 1: Create new point_info table with composite primary key
CREATE TABLE point_info_new (
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  point_id TEXT NOT NULL,
  point_sub_id TEXT,
  point_name TEXT NOT NULL,
  subsystem TEXT,
  type TEXT,
  subtype TEXT,
  extension TEXT,
  display_name TEXT NOT NULL,
  short_name TEXT,
  metric_type TEXT NOT NULL,
  metric_unit TEXT NOT NULL,
  PRIMARY KEY (system_id, id)
);

-- Step 2: Copy data from old point_info to new (IDs remain the same)
INSERT INTO point_info_new
SELECT
  system_id,
  id,
  point_id,
  point_sub_id,
  point_name,
  subsystem,
  type,
  subtype,
  extension,
  display_name,
  short_name,
  metric_type,
  metric_unit
FROM point_info;

-- Step 3: Create new point_readings table with composite FK
CREATE TABLE point_readings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  point_id INTEGER NOT NULL,
  session_id INTEGER,
  measurement_time INTEGER NOT NULL,
  received_time INTEGER NOT NULL,
  value REAL,
  error TEXT,
  data_quality TEXT NOT NULL DEFAULT 'good',
  FOREIGN KEY (system_id, point_id) REFERENCES point_info_new(system_id, id) ON DELETE CASCADE
);

-- Step 4: Copy data from old point_readings to new
INSERT INTO point_readings_new
SELECT
  id,
  system_id,
  point_id,
  session_id,
  measurement_time,
  received_time,
  value,
  error,
  data_quality
FROM point_readings;

-- Step 5: Create new point_readings_agg_5m table with composite PK and FK
CREATE TABLE point_readings_agg_5m_new (
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  point_id INTEGER NOT NULL,
  interval_end INTEGER NOT NULL,
  avg REAL,
  min REAL,
  max REAL,
  last REAL,
  sample_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (system_id, point_id, interval_end),
  FOREIGN KEY (system_id, point_id) REFERENCES point_info_new(system_id, id) ON DELETE CASCADE
);

-- Step 6: Copy data from old point_readings_agg_5m to new
INSERT INTO point_readings_agg_5m_new
SELECT
  system_id,
  point_id,
  interval_end,
  avg,
  min,
  max,
  last,
  sample_count,
  error_count,
  created_at,
  updated_at
FROM point_readings_agg_5m;

-- Step 7: Drop old tables
DROP TABLE point_readings_agg_5m;
DROP TABLE point_readings;
DROP TABLE point_info;

-- Step 8: Rename new tables to original names
ALTER TABLE point_info_new RENAME TO point_info;
ALTER TABLE point_readings_new RENAME TO point_readings;
ALTER TABLE point_readings_agg_5m_new RENAME TO point_readings_agg_5m;

-- Step 9: Create indexes on point_info
CREATE UNIQUE INDEX pi_system_point_unique ON point_info(system_id, point_id, point_sub_id);
CREATE INDEX pi_system_idx ON point_info(system_id);
CREATE INDEX pi_subsystem_idx ON point_info(subsystem);
CREATE INDEX pi_metric_type_idx ON point_info(metric_type);
CREATE UNIQUE INDEX pi_system_short_name_unique ON point_info(system_id, short_name);

-- Step 10: Create indexes on point_readings
CREATE UNIQUE INDEX pr_point_time_unique ON point_readings(system_id, point_id, measurement_time);
CREATE INDEX pr_system_time_idx ON point_readings(system_id, measurement_time);
CREATE INDEX pr_point_idx ON point_readings(point_id);
CREATE INDEX pr_session_idx ON point_readings(session_id);
CREATE INDEX pr_measurement_time_idx ON point_readings(measurement_time);

-- Step 11: Create indexes on point_readings_agg_5m
CREATE INDEX pr5m_system_time_idx ON point_readings_agg_5m(system_id, interval_end);
CREATE INDEX pr5m_interval_end_idx ON point_readings_agg_5m(interval_end);

-- Step 12: Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)  -- Unix timestamp in milliseconds
);

INSERT INTO migrations (id) VALUES ('0016_composite_primary_keys_point_tables');
