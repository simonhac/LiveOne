-- Migration: Add delta column to point_readings_agg_5m
-- The delta column stores the difference between consecutive intervals for points with transform='d'

BEGIN TRANSACTION;

-- Add delta column to point_readings_agg_5m
ALTER TABLE point_readings_agg_5m ADD COLUMN delta REAL DEFAULT NULL;

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0030_add_delta_column');
