-- Migration: Add snapshot_hour to allow multiple snapshots per day
--
-- Changes:
-- - Adds snapshot_hour column (0-23 UTC) to primary key
-- - Allows up to 24 snapshots per day instead of just 1
-- - Changes growth_days from INTEGER to REAL for fractional days

-- Create new table with updated primary key
CREATE TABLE db_growth_snapshots_new (
  snapshot_date TEXT NOT NULL,
  snapshot_hour INTEGER NOT NULL DEFAULT 0,  -- 0-23 UTC
  table_name TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  data_mb REAL NOT NULL,
  index_mb REAL NOT NULL,
  is_estimated INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  created_at_min INTEGER,
  created_at_max INTEGER,
  updated_at_min INTEGER,
  updated_at_max INTEGER,
  records_per_day REAL,
  data_mb_per_day REAL,
  index_mb_per_day REAL,
  total_mb_per_day REAL,
  growth_days REAL,  -- Changed from INTEGER to REAL for fractional days
  PRIMARY KEY (snapshot_date, snapshot_hour, table_name)
);

-- Copy existing data (derive hour from created_at timestamp, default to 14 if null)
INSERT INTO db_growth_snapshots_new SELECT
  snapshot_date,
  COALESCE(CAST((created_at / 1000 / 3600) % 24 AS INTEGER), 14),
  table_name, record_count, data_mb, index_mb,
  is_estimated, created_at, created_at_min, created_at_max,
  updated_at_min, updated_at_max, records_per_day, data_mb_per_day,
  index_mb_per_day, total_mb_per_day, growth_days
FROM db_growth_snapshots;

-- Replace table (row count validation done via application after migration)
DROP TABLE db_growth_snapshots;
ALTER TABLE db_growth_snapshots_new RENAME TO db_growth_snapshots;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('0056_add_snapshot_hour');
