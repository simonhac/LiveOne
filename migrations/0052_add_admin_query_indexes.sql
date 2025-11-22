-- Migration: Add back indexes for admin storage endpoint global MIN/MAX queries
--
-- These indexes are ONLY used by /api/admin/storage for global MIN/MAX aggregations:
-- - point_readings: MIN/MAX(measurement_time) across all rows
-- - point_readings_agg_5m: MIN/MAX(interval_end) across all rows
--
-- Cost: ~9 MB total (~4.5 MB each)
-- Benefit: Admin storage endpoint speeds up from 28s to < 1s
--
-- Note: These are not used by normal application queries (which filter by system_id first)
-- but are essential for the admin page to load quickly.

-- Add index for global MIN/MAX queries on point_readings.measurement_time
CREATE INDEX IF NOT EXISTS pr_measurement_time_idx ON point_readings(measurement_time);

-- Add index for global MIN/MAX queries on point_readings_agg_5m.interval_end
CREATE INDEX IF NOT EXISTS pr5m_interval_end_idx ON point_readings_agg_5m(interval_end);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0052_add_admin_query_indexes');
