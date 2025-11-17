-- Migration: Refactor systems table
-- 1. Add is_default column with partial unique constraint
-- 2. Remove redundant created column (keep created_at)
-- 3. Rename column short_name → alias
-- 4. Make display_timezone NOT NULL
-- 5. Remove default value from timezone_offset_min
-- 6. Rename indexes appropriately

BEGIN TRANSACTION;

-- Step 1: Display current state
SELECT '=== Step 1: Current systems table ===' as step;
SELECT COUNT(*) as total_systems FROM systems;

-- Step 2: Check for NULL display_timezone values (should be none)
SELECT '=== Step 2: Check for NULL display_timezone (should be 0) ===' as step;
SELECT COUNT(*) as null_timezone_count
FROM systems
WHERE display_timezone IS NULL;

-- If there are any NULL values, fail the migration
SELECT CASE
  WHEN (SELECT COUNT(*) FROM systems WHERE display_timezone IS NULL) > 0
  THEN RAISE(ABORT, 'Migration failed: Found NULL display_timezone values. Please fix before migrating.')
END;

-- Step 3: Create new systems table with updated schema
SELECT '=== Step 3: Creating systems_new table ===' as step;

CREATE TABLE systems_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_clerk_user_id TEXT,
  vendor_type TEXT NOT NULL,
  vendor_site_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  display_name TEXT NOT NULL,
  alias TEXT,  -- renamed from short_name
  model TEXT,
  serial TEXT,
  ratings TEXT,
  solar_size TEXT,
  battery_size TEXT,
  location TEXT,
  metadata TEXT,
  timezone_offset_min INTEGER NOT NULL,  -- no default value
  display_timezone TEXT NOT NULL,  -- now required
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),  -- new column
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  -- Note: 'created' field removed (was redundant with created_at)
);

-- Step 4: Copy all data from old table to new table
SELECT '=== Step 4: Copying data to systems_new ===' as step;

INSERT INTO systems_new (
  id,
  owner_clerk_user_id,
  vendor_type,
  vendor_site_id,
  status,
  display_name,
  alias,  -- from short_name
  model,
  serial,
  ratings,
  solar_size,
  battery_size,
  location,
  metadata,
  timezone_offset_min,
  display_timezone,
  is_default,  -- new column, defaults to 0
  created_at,
  updated_at
)
SELECT
  id,
  owner_clerk_user_id,
  vendor_type,
  vendor_site_id,
  status,
  display_name,
  short_name,  -- renamed to alias
  model,
  serial,
  ratings,
  solar_size,
  battery_size,
  location,
  metadata,
  timezone_offset_min,
  display_timezone,
  0 as is_default,  -- new column
  created_at,
  updated_at
FROM systems;
-- Note: 'created' column not copied (being removed)

-- Step 5: Validate row counts match
SELECT '=== Step 5: Validate row counts ===' as step;
SELECT
  (SELECT COUNT(*) FROM systems) as original_count,
  (SELECT COUNT(*) FROM systems_new) as new_count,
  CASE
    WHEN (SELECT COUNT(*) FROM systems) = (SELECT COUNT(*) FROM systems_new)
    THEN 'PASS'
    ELSE 'FAIL'
  END as validation;

-- Validate counts match, abort if not
SELECT CASE
  WHEN (SELECT COUNT(*) FROM systems) != (SELECT COUNT(*) FROM systems_new)
  THEN RAISE(ABORT, 'Migration failed: Row count mismatch between tables')
END;

-- Step 6: Rename old table to backup
SELECT '=== Step 6: Renaming old table to backup ===' as step;
ALTER TABLE systems RENAME TO systems_backup_20251117;

-- Step 7: Drop old indexes from backup table
-- (When renaming a table, indexes automatically get renamed to reference the new table name)
SELECT '=== Step 7: Dropping old indexes from backup table ===' as step;
DROP INDEX IF EXISTS owner_clerk_user_idx;
DROP INDEX IF EXISTS short_name_unique;
DROP INDEX IF EXISTS systems_status_idx;

-- Step 8: Rename new table to systems
SELECT '=== Step 8: Renaming new table to systems ===' as step;
ALTER TABLE systems_new RENAME TO systems;

-- Step 9: Create indexes on new systems table
SELECT '=== Step 9: Creating indexes ===' as step;

-- Index on owner_clerk_user_id (unchanged name)
CREATE INDEX owner_clerk_user_idx ON systems(owner_clerk_user_id);

-- Index on status (unchanged name)
CREATE INDEX systems_status_idx ON systems(status);

-- Unique index on (owner_clerk_user_id, alias) - renamed from short_name_unique
-- This is a partial unique index: only enforces uniqueness when alias is NOT NULL
CREATE UNIQUE INDEX alias_unique ON systems(owner_clerk_user_id, alias)
WHERE alias IS NOT NULL;

-- New partial unique index: only one default per owner
CREATE UNIQUE INDEX is_default_unique ON systems(owner_clerk_user_id)
WHERE is_default = 1;

-- Step 10: Verify indexes were created
SELECT '=== Step 10: Verify indexes on systems table ===' as step;
SELECT name, sql
FROM sqlite_master
WHERE type='index' AND tbl_name='systems'
ORDER BY name;

-- Step 11: Verify no indexes remain on backup table
SELECT '=== Step 11: Verify no indexes on backup table ===' as step;
SELECT COALESCE(
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='systems_backup_20251117'),
  0
) as backup_index_count;

-- Step 12: Summary
SELECT '=== Step 12: Migration summary ===' as step;
SELECT
  (SELECT COUNT(*) FROM systems) as systems_count,
  (SELECT COUNT(*) FROM systems_backup_20251117) as backup_count,
  (SELECT COUNT(*) FROM systems WHERE is_default = 1) as systems_with_default,
  (SELECT COUNT(DISTINCT owner_clerk_user_id) FROM systems) as unique_owners;

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0043_refactor_systems_table');
