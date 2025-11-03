-- Migration: Remove capabilities from systems table and add active flag to point_info
-- Part 1: Add active field to point_info table
-- The default value of true will be applied to all existing rows
ALTER TABLE point_info ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- Part 2: Remove capabilities column from systems table
-- SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
-- First, create a backup table without the capabilities column
CREATE TABLE systems_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_clerk_user_id TEXT,
  vendor_type TEXT NOT NULL,
  vendor_site_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  display_name TEXT NOT NULL,
  short_name TEXT,
  model TEXT,
  serial TEXT,
  ratings TEXT,
  solar_size TEXT,
  battery_size TEXT,
  location TEXT,
  metadata TEXT,
  timezone_offset_min INTEGER NOT NULL DEFAULT 600,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Copy data from old table to new table (excluding capabilities)
INSERT INTO systems_new (
  id, owner_clerk_user_id, vendor_type, vendor_site_id, status,
  display_name, short_name, model, serial, ratings, solar_size, battery_size,
  location, metadata, timezone_offset_min, created_at, updated_at
)
SELECT
  id, owner_clerk_user_id, vendor_type, vendor_site_id, status,
  display_name, short_name, model, serial, ratings, solar_size, battery_size,
  location, metadata, timezone_offset_min, created_at, updated_at
FROM systems;

-- Drop the old table
DROP TABLE systems;

-- Rename the new table to systems
ALTER TABLE systems_new RENAME TO systems;

-- Recreate indexes
CREATE INDEX owner_clerk_user_idx ON systems(owner_clerk_user_id);
CREATE INDEX systems_status_idx ON systems(status);
CREATE UNIQUE INDEX short_name_unique ON systems(owner_clerk_user_id, short_name);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0021_remove_capabilities_add_point_active');
