-- Migration: Add logical_path and physical_path columns to point_info
-- Both columns are unique within a system_id

BEGIN TRANSACTION;

-- Add columns
ALTER TABLE point_info ADD COLUMN logical_path TEXT;
ALTER TABLE point_info ADD COLUMN physical_path TEXT;

-- Backfill physical_path (always non-null since origin_id and origin_sub_id are non-null)
UPDATE point_info SET physical_path = origin_id || '.' || origin_sub_id;

-- Backfill logical_path (only for rows with type != null)
UPDATE point_info
SET logical_path =
  CASE
    WHEN type IS NULL THEN NULL
    WHEN subtype IS NULL THEN type || '/' || metric_type
    WHEN extension IS NULL THEN type || '.' || subtype || '/' || metric_type
    ELSE type || '.' || subtype || '.' || extension || '/' || metric_type
  END;

-- Create unique indexes (within system_id)
CREATE UNIQUE INDEX pi_system_logical_path_unique ON point_info(system_id, logical_path);
CREATE UNIQUE INDEX pi_system_physical_path_unique ON point_info(system_id, physical_path);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('0057_add_logical_physical_path');
