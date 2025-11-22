-- Migration: Drop unused indexes from point_readings and point_readings_agg_5m tables
--
-- Analysis shows these indexes are never used by any queries:
-- - point_readings: pr_point_idx, pr_session_idx, pr_measurement_time_idx
-- - point_readings_agg_5m: pr5m_interval_end_idx, pr5m_session_idx
--
-- All queries filter by system_id first, making standalone indexes on other columns useless.
-- Estimated space savings: ~67 MB total (~58 MB + ~9 MB)
--
-- Keeping only indexes that are actually used:
-- - point_readings: pr_point_time_unique (UPSERT), pr_system_time_idx (time range queries)
-- - point_readings_agg_5m: PRIMARY KEY (UPSERT), pr5m_system_time_idx (time range queries)
--
-- Safety: Uses DROP INDEX IF EXISTS - will not fail if indexes don't exist
-- This is a safe, non-destructive operation (only removes index structures, no data loss)

-- Drop unused indexes from point_readings
DROP INDEX IF EXISTS pr_point_idx;
DROP INDEX IF EXISTS pr_session_idx;
DROP INDEX IF EXISTS pr_measurement_time_idx;

-- Drop unused indexes from point_readings_agg_5m
DROP INDEX IF EXISTS pr5m_interval_end_idx;
DROP INDEX IF EXISTS pr5m_session_idx;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0051_drop_unused_point_indexes');
