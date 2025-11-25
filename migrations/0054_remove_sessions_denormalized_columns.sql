-- Migration: Remove denormalized columns from sessions table
-- Drops: system_name, vendor_type (both available via join to systems)
-- Both values can be retrieved via JOIN with systems table on system_id
--
-- This is a safe migration:
-- - No data transformation (just dropping columns)
-- - INSERT...SELECT from same table is atomic
-- - Foreign key to systems(id) unchanged
--
-- Run manually: sqlite3 dev.db < migrations/0054_remove_sessions_denormalized_columns.sql
-- Turso: ~/.turso/turso db shell liveone-tokyo < migrations/0054_remove_sessions_denormalized_columns.sql

-- Create new table WITHOUT the denormalized columns
CREATE TABLE IF NOT EXISTS sessions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_label TEXT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  cause TEXT NOT NULL,
  started INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  successful INTEGER NOT NULL,
  error_code TEXT,
  error TEXT,
  response TEXT,
  num_rows INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Copy data (excluding dropped columns)
INSERT OR IGNORE INTO sessions_new (
  id, session_label, system_id, cause, started, duration,
  successful, error_code, error, response, num_rows, created_at
)
SELECT
  id, session_label, system_id, cause, started, duration,
  successful, error_code, error, response, num_rows, created_at
FROM sessions;

-- Show counts for verification
SELECT 'sessions: ' || COUNT(*) FROM sessions;
SELECT 'sessions_new: ' || COUNT(*) FROM sessions_new;

-- Swap tables
DROP TABLE IF EXISTS sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS sessions_system_idx ON sessions(system_id);
CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions(started);
CREATE INDEX IF NOT EXISTS sessions_cause_idx ON sessions(cause);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT OR IGNORE INTO migrations (id) VALUES ('0054_remove_sessions_denormalized_columns');
