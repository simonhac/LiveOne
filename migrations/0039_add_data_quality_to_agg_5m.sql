-- Migration: Add data_quality field to point_readings_agg_5m
-- This allows tracking forecast vs actual vs billable data quality in aggregated readings

BEGIN TRANSACTION;

-- Add data_quality column (nullable, no default)
ALTER TABLE point_readings_agg_5m ADD COLUMN data_quality TEXT;

-- Existing records will have NULL data_quality (assumed 'good' if NULL)

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0039_add_data_quality_to_agg_5m');
