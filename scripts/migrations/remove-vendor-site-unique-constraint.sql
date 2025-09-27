-- Migration: Remove unique constraint on systems.vendor_type and systems.vendor_site_id
-- Date: 2025-01-27
-- Reason: Allow multiple systems with the same vendor_site_id (e.g., for removed/inactive systems)

-- Note: In SQLite, you cannot drop an index directly if it's part of the table definition.
-- We need to recreate the table without the constraint.

-- Step 1: Create a temporary table without the unique constraint
CREATE TABLE systems_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    owner_clerk_user_id TEXT,
    vendor_type TEXT NOT NULL,
    vendor_site_id TEXT NOT NULL,
    display_name TEXT,
    model TEXT,
    serial TEXT,
    ratings TEXT,
    solar_size TEXT,
    battery_size TEXT,
    timezone_offset_min INTEGER DEFAULT 600 NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL,
    location TEXT
);

-- Step 2: Copy data from the old table to the new table
INSERT INTO systems_new
SELECT
    id,
    owner_clerk_user_id,
    vendor_type,
    vendor_site_id,
    display_name,
    model,
    serial,
    ratings,
    solar_size,
    battery_size,
    timezone_offset_min,
    created_at,
    updated_at,
    status,
    location
FROM systems;

-- Step 3: Drop the old table
DROP TABLE systems;

-- Step 4: Rename the new table to the original name
ALTER TABLE systems_new RENAME TO systems;

-- Step 5: Recreate the non-unique indexes
CREATE INDEX owner_clerk_user_idx ON systems(owner_clerk_user_id);
CREATE INDEX systems_status_idx ON systems(status);

-- Note: We intentionally do NOT recreate the vendor_site_unique index

-- Verification query (run manually after migration)
-- SELECT vendor_type, vendor_site_id, COUNT(*) as count
-- FROM systems
-- GROUP BY vendor_type, vendor_site_id
-- HAVING COUNT(*) > 1;