-- Migration: Add indexes for efficient session filtering and sorting
-- Optimizes queries for the admin sessions page with server-side pagination

-- Drop old system_id index (will be replaced by composite)
DROP INDEX IF EXISTS sessions_system_idx;

-- Create composite index for system filtering + time sorting (most common pattern)
-- This eliminates temp B-tree for queries like: WHERE system_id = X ORDER BY started DESC
CREATE INDEX sessions_system_started_idx ON sessions(system_id, started DESC);

-- Create index for vendor type filtering
CREATE INDEX sessions_vendor_type_idx ON sessions(vendor_type);

-- Create index for success/failure filtering
CREATE INDEX sessions_successful_idx ON sessions(successful);

-- Create index for duration sorting
CREATE INDEX sessions_duration_idx ON sessions(duration);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0047_sessions_query_indexes');
