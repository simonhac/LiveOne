-- Migration: Simplify point_info table
-- - Remove columns: origin_id, origin_sub_id, type, subtype, extension, short_name
-- - Rename: logical_path → logical_path_stem (strip /metricType suffix from data)
-- - Rename: created → created_at_ms
-- - Rename: updated_at → updated_at_ms
-- - Build physicalPath from origin_id/origin_sub_id (e.g., "selectronic/solar_w")
-- - Keep old table as backup: point_info_YYYY_MM_DD_HH_MM

BEGIN TRANSACTION;

-- Step 1: Rename old table for backup (timestamp will be set when migration runs)
-- Note: Replace the timestamp suffix with actual date when running manually
ALTER TABLE point_info RENAME TO point_info_2025_11_27_backup;

-- Step 2: Create new simplified table
CREATE TABLE point_info (
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,

  -- Paths (physicalPath uses "/" separator, logicalPathStem uses ".")
  physical_path TEXT NOT NULL,           -- e.g., "selectronic/solar_w"
  logical_path_stem TEXT,                -- e.g., "source.solar" (nullable)

  -- Metric info
  metric_type TEXT NOT NULL,             -- e.g., "power", "energy", "soc"
  metric_unit TEXT NOT NULL,             -- e.g., "W", "Wh", "%"

  -- Display
  point_name TEXT NOT NULL,              -- default name from vendor
  display_name TEXT NOT NULL,            -- user-customizable
  subsystem TEXT,                        -- for UI color coding

  -- Flags
  transform TEXT DEFAULT NULL,           -- null | 'i' (invert) | 'd' (differentiate)
  active INTEGER NOT NULL DEFAULT 1,

  -- Timestamps (in milliseconds)
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER,

  PRIMARY KEY (system_id, id)
);

-- Step 3: Copy and transform data
INSERT INTO point_info (
  system_id, id,
  physical_path,
  logical_path_stem,
  metric_type, metric_unit,
  point_name, display_name, subsystem,
  transform, active,
  created_at_ms, updated_at_ms
)
SELECT
  system_id, id,
  -- Build physicalPath from origin_id/origin_sub_id: "selectronic/solar_w"
  origin_id || '/' || origin_sub_id,
  -- Extract logicalPathStem: "source.solar/power" → "source.solar" (strip after /)
  CASE
    WHEN logical_path IS NOT NULL AND INSTR(logical_path, '/') > 0
    THEN SUBSTR(logical_path, 1, INSTR(logical_path, '/') - 1)
    ELSE NULL
  END,
  metric_type, metric_unit,
  point_name, display_name, subsystem,
  transform, active,
  COALESCE(created, 0), updated_at
FROM point_info_2025_11_27_backup;

-- Step 4: Create indexes (drop first in case they exist on backup table)
DROP INDEX IF EXISTS pi_system_physical_path_unique;
DROP INDEX IF EXISTS pi_system_stem_metric_unique;
DROP INDEX IF EXISTS pi_system_idx;
DROP INDEX IF EXISTS pi_subsystem_idx;
CREATE UNIQUE INDEX pi_system_physical_path_unique ON point_info(system_id, physical_path);
-- Unique constraint on stem + metric_type (the full logical path must be unique)
CREATE UNIQUE INDEX pi_system_stem_metric_unique ON point_info(system_id, logical_path_stem, metric_type);
CREATE INDEX pi_system_idx ON point_info(system_id);
CREATE INDEX pi_subsystem_idx ON point_info(subsystem);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('0059_simplify_point_info');
