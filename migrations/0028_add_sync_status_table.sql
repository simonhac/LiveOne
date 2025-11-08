-- Migration: Add sync_status table to track last synced timestamps for automatic sync

-- Create sync_status table to track last synced entry per readings table
CREATE TABLE IF NOT EXISTS sync_status (
  table_name TEXT PRIMARY KEY,           -- e.g., 'readings', 'readings_agg_5m', 'point_readings'
  last_entry_ms INTEGER,                 -- Unix timestamp in milliseconds (for time-based tables)
  last_entry_date TEXT,                  -- Calendar date YYYY-MM-DD (for date-based tables like daily agg)
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)  -- Last update time (ms)
);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0028_add_sync_status_table');
