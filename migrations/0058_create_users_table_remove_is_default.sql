-- Migration: Create users table for user preferences and remove is_default from systems

BEGIN TRANSACTION;

-- ============================================
-- Part 1: Create users table
-- ============================================

CREATE TABLE users (
  clerk_user_id TEXT PRIMARY KEY,
  default_system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX users_default_system_idx ON users(default_system_id);

-- ============================================
-- Part 2: Remove is_default from systems table
-- ============================================

-- SQLite doesn't support DROP COLUMN directly, so we need to rebuild the table

-- Step 1: Create new systems table without is_default
CREATE TABLE systems_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_clerk_user_id TEXT,
  vendor_type TEXT NOT NULL,
  vendor_site_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  display_name TEXT NOT NULL,
  alias TEXT,
  model TEXT,
  serial TEXT,
  ratings TEXT,
  solar_size TEXT,
  battery_size TEXT,
  location TEXT,
  metadata TEXT,
  timezone_offset_min INTEGER NOT NULL,
  display_timezone TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 2: Copy data (excluding is_default)
INSERT INTO systems_new (
  id, owner_clerk_user_id, vendor_type, vendor_site_id, status,
  display_name, alias, model, serial, ratings, solar_size, battery_size,
  location, metadata, timezone_offset_min, display_timezone, created_at, updated_at
)
SELECT
  id, owner_clerk_user_id, vendor_type, vendor_site_id, status,
  display_name, alias, model, serial, ratings, solar_size, battery_size,
  location, metadata, timezone_offset_min, display_timezone, created_at, updated_at
FROM systems;

-- Step 3: Drop old table (data integrity ensured by transaction)
DROP TABLE systems;

-- Step 5: Rename new table
ALTER TABLE systems_new RENAME TO systems;

-- Step 6: Recreate indexes (excluding is_default_unique)
CREATE INDEX owner_clerk_user_idx ON systems(owner_clerk_user_id);
CREATE INDEX systems_status_idx ON systems(status);
CREATE UNIQUE INDEX alias_unique ON systems(owner_clerk_user_id, alias);

-- Step 7: Add FK constraint for users table to reference new systems table
-- (Already handled by CREATE TABLE above, FK references work after rename)

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0058_create_users_table_remove_is_default');
