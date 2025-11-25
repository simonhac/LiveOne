-- Migration: Extend db_growth_snapshots for pre-computed page stats
--
-- Adds columns for:
-- - Timestamp ranges (created_at_min/max, updated_at_min/max)
-- - Pre-computed growth rates (records_per_day, data_mb_per_day, etc.)
-- - Growth period tracking (growth_days)
--
-- After this migration, the db-stats cron job will pre-compute all stats
-- and the admin/readings page will read from latest snapshot instead of
-- running expensive queries on page load.

-- Timestamp ranges (Unix milliseconds)
ALTER TABLE db_growth_snapshots ADD COLUMN created_at_min INTEGER;
ALTER TABLE db_growth_snapshots ADD COLUMN created_at_max INTEGER;
ALTER TABLE db_growth_snapshots ADD COLUMN updated_at_min INTEGER;
ALTER TABLE db_growth_snapshots ADD COLUMN updated_at_max INTEGER;

-- Pre-computed growth rates
ALTER TABLE db_growth_snapshots ADD COLUMN records_per_day REAL;
ALTER TABLE db_growth_snapshots ADD COLUMN data_mb_per_day REAL;
ALTER TABLE db_growth_snapshots ADD COLUMN index_mb_per_day REAL;
ALTER TABLE db_growth_snapshots ADD COLUMN total_mb_per_day REAL;
ALTER TABLE db_growth_snapshots ADD COLUMN growth_days INTEGER;

-- Track migration
INSERT INTO migrations (id) VALUES ('0055_extend_growth_snapshots');
