-- Migration: Add updated_at column to point_info table

BEGIN TRANSACTION;

-- Add updated_at column (Unix milliseconds)
-- SQLite doesn't allow non-constant defaults in ALTER TABLE, so we add NULL first then backfill
ALTER TABLE point_info ADD COLUMN updated_at INTEGER;

-- Backfill with current timestamp for existing rows
UPDATE point_info SET updated_at = unixepoch() * 1000 WHERE updated_at IS NULL;

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0050_add_updated_at_to_point_info');
