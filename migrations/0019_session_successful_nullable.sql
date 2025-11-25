-- Migration: Make successful column nullable for tri-state (NULL=pending, 1=success, 0=failed)
-- SQLite cannot alter constraints, so we recreate the table

BEGIN TRANSACTION;

-- Create new table with nullable successful
CREATE TABLE sessions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_label TEXT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  cause TEXT NOT NULL,
  started INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  successful INTEGER,  -- NOW NULLABLE: NULL=pending, 1=success, 0=failed
  error_code TEXT,
  error TEXT,
  response TEXT,
  num_rows INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Copy all data (existing values unchanged)
INSERT INTO sessions_new SELECT * FROM sessions;

-- Drop old table (validation is done by comparing counts before/after migration externally)
DROP TABLE sessions;

-- Rename new table
ALTER TABLE sessions_new RENAME TO sessions;

-- Recreate indexes
CREATE INDEX sessions_system_idx ON sessions(system_id);
CREATE INDEX sessions_started_idx ON sessions(started);
CREATE INDEX sessions_cause_idx ON sessions(cause);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('0019_session_successful_nullable');
