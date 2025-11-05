-- Migration: Add valueStr column to point_readings for text data
-- This allows storing non-numeric data (like fault codes) alongside numeric values

ALTER TABLE point_readings ADD COLUMN value_str TEXT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0022_add_value_str_to_point_readings');
