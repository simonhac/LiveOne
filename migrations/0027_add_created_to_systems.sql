-- Migration: Add created timestamp field to systems table
-- This field stores the creation time as Unix milliseconds

BEGIN TRANSACTION;

-- Add created column with constant default value
-- Using 0 as placeholder, will update immediately after
ALTER TABLE systems ADD COLUMN created INTEGER NOT NULL DEFAULT 0;

-- Update all existing rows to have current timestamp
UPDATE systems SET created = (unixepoch() * 1000);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0027_add_created_to_systems');
