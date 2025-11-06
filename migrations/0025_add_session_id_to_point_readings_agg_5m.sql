-- Migration: Add session_id column and index to point_readings_agg_5m table
-- This enables tracking which polling session created each aggregated reading

-- Add session_id column
ALTER TABLE point_readings_agg_5m ADD COLUMN session_id INTEGER;

-- Create index for session_id lookups
CREATE INDEX IF NOT EXISTS pr5m_session_idx ON point_readings_agg_5m(session_id);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0025_add_session_id_to_point_readings_agg_5m');
