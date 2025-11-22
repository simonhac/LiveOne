-- Migration: Create db_growth_snapshots table for tracking daily database growth
--
-- This table stores daily snapshots of table sizes and record counts.
-- Used to track historical database growth patterns and calculate accurate per-day metrics.
--
-- Snapshots can be:
-- - Estimated (is_estimated = 1): Backfilled from historical data using avg record size
-- - Actual (is_estimated = 0): Measured by db-stats cron job
--
-- Storage overhead: ~10 tables × 365 days = 3,650 rows/year (~minimal)

CREATE TABLE IF NOT EXISTS db_growth_snapshots (
  snapshot_date TEXT NOT NULL,     -- YYYY-MM-DD format
  table_name TEXT NOT NULL,
  record_count INTEGER NOT NULL,   -- Total records in table on this date
  data_mb REAL NOT NULL,           -- Data size in MB (estimated or actual)
  index_mb REAL NOT NULL,          -- Index size in MB (estimated or actual)
  is_estimated INTEGER NOT NULL DEFAULT 1,  -- 1 = estimated, 0 = actual measurement
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),  -- Unix milliseconds
  PRIMARY KEY (snapshot_date, table_name)
);

-- Index for efficient queries by table
CREATE INDEX IF NOT EXISTS dgs_table_date_idx ON db_growth_snapshots(table_name, snapshot_date);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0053_create_growth_snapshots');
