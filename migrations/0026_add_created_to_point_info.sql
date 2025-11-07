-- Migration: Add created timestamp field to point_info table
-- This field stores the creation time as Unix milliseconds

BEGIN TRANSACTION;

-- Add created column with constant default value
-- Using 0 as placeholder, will update immediately after
ALTER TABLE point_info ADD COLUMN created INTEGER NOT NULL DEFAULT 0;

-- Update all existing rows to have current timestamp
UPDATE point_info SET created = (unixepoch() * 1000);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0026_add_created_to_point_info');
