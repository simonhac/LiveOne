-- Migration: PR-7a — switch sessions.id from INTEGER PK AUTOINCREMENT to TEXT
-- (app-minted UUIDv7). SQLite cannot retype a rowid-alias PK in place, and the
-- live `sessions` table is ~748K rows / ~1.5 GB (response blobs). Instead of
-- copying that, we move it ASIDE: `ALTER TABLE ... RENAME` is metadata-only
-- (instant — it rewrites the schema entry, not the rows), then create a fresh
-- empty text-id `sessions` table. New (UUIDv7) sessions write here; the frozen
-- history stays in `sessions_archive`; full history is served from Postgres.
--
-- Safety (0016-grade): take a Turso snapshot first; this runs in one transaction;
-- no rows are copied so there is nothing to count-validate, and nothing else in
-- the schema references `sessions` (verified: no inbound FKs, triggers or views).
-- Reversible: rename the new table away and `sessions_archive` -> `sessions`.

BEGIN TRANSACTION;

-- 1. Move the existing table (and its 748K rows) aside — instant, no copy.
ALTER TABLE sessions RENAME TO sessions_archive;

-- 2. Free the canonical index names (they followed the table to the archive;
--    the archive is a cold, app-unread backup so it needs no indexes).
DROP INDEX sessions_cause_idx;
DROP INDEX sessions_started_idx;
DROP INDEX sessions_system_idx;

-- 3. Create the fresh live sessions table with a TEXT primary key (UUIDv7).
--    Columns match lib/db/turso/schema.ts exactly.
--    TRANSIENT DEFAULT on id: during the deploy window the still-running OLD code
--    inserts a session WITHOUT an id (it expected autoincrement). The random-hex
--    default lets those inserts succeed → zero data gap. The NEW code always
--    supplies an explicit uuidv7(), so the default is only ever used during the
--    cutover window. (Harmless to keep; can be dropped in a later migration.)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_label TEXT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  cause TEXT NOT NULL,
  started INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  successful INTEGER,
  error_code TEXT,
  error TEXT,
  response TEXT,
  num_rows INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 4. Recreate the indexes (same names as before) on the new live table.
CREATE INDEX sessions_system_idx ON sessions(system_id);
CREATE INDEX sessions_started_idx ON sessions(started);
CREATE INDEX sessions_cause_idx ON sessions(cause);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('0063_sessions_text_id_split');
