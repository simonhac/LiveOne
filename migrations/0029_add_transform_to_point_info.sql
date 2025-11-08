-- Migration: Add transform field to point_info table
-- The transform field allows data transformation on point values
-- null = no transform (default)
-- 'i' = invert (multiply by -1)

BEGIN TRANSACTION;

-- Add transform column to point_info
ALTER TABLE point_info ADD COLUMN transform TEXT DEFAULT NULL;

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0029_add_transform_to_point_info');
