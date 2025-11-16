-- Migration: Add value_str column to 5-minute aggregates for text data
-- This allows storing text values (like tariff periods) in pre-aggregated data

-- Add value_str to 5-minute aggregates
ALTER TABLE point_readings_agg_5m ADD COLUMN value_str TEXT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0037_add_value_str_to_aggregates');
