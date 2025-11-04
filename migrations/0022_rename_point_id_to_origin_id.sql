-- Migration: Rename point_id/point_sub_id to origin_id/origin_sub_id in point_info table
-- This clarifies that these are the original identifiers from the vendor system

-- SQLite doesn't support column rename directly, so we need to:
-- 1. Create new table with new column names
-- 2. Copy data
-- 3. Drop old table
-- 4. Rename new table

-- Create new point_info table with origin_id and origin_sub_id
CREATE TABLE point_info_new (
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,

  -- Renamed columns
  origin_id TEXT NOT NULL,
  origin_sub_id TEXT,

  -- Rest of columns unchanged
  point_name TEXT NOT NULL,
  subsystem TEXT,
  type TEXT,
  subtype TEXT,
  extension TEXT,
  display_name TEXT NOT NULL,
  short_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  metric_type TEXT NOT NULL,
  metric_unit TEXT NOT NULL,

  PRIMARY KEY (system_id, id)
);

-- Copy data from old table to new table
INSERT INTO point_info_new
SELECT
  system_id,
  id,
  point_id as origin_id,
  point_sub_id as origin_sub_id,
  point_name,
  subsystem,
  type,
  subtype,
  extension,
  display_name,
  short_name,
  active,
  metric_type,
  metric_unit
FROM point_info;

-- Drop old table
DROP TABLE point_info;

-- Rename new table to original name
ALTER TABLE point_info_new RENAME TO point_info;

-- Recreate indexes
CREATE UNIQUE INDEX pi_system_point_unique ON point_info(system_id, origin_id, origin_sub_id);
CREATE INDEX pi_system_idx ON point_info(system_id);
CREATE INDEX pi_subsystem_idx ON point_info(subsystem);
CREATE INDEX pi_metric_type_idx ON point_info(metric_type);
CREATE UNIQUE INDEX pi_system_short_name_unique ON point_info(system_id, short_name);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0022_rename_point_id_to_origin_id');
