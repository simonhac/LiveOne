-- Migration: Add system_id to point_readings and update point_readings_agg_5m schema
-- Date: 2025-01-12
-- Changes:
--   1. Add system_id column to point_readings (denormalized for query performance)
--   2. Backfill system_id from point_info table
--   3. Recreate indexes to include system_id
--   4. Drop and recreate point_readings_agg_5m with new schema (generic aggregates, error handling)

-- ============================================================================
-- PART 1: Backup point_readings table
-- ============================================================================

-- Create backup table with all existing data
DROP TABLE IF EXISTS point_readings_backup;
CREATE TABLE point_readings_backup AS SELECT * FROM point_readings;

-- Verify backup was created
-- SELECT COUNT(*) FROM point_readings_backup;

-- ============================================================================
-- PART 2: Add system_id to point_readings
-- ============================================================================

-- Step 1: Create new table with system_id column
CREATE TABLE point_readings_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    system_id INTEGER NOT NULL,
    point_id INTEGER NOT NULL,
    session_id INTEGER,
    measurement_time INTEGER NOT NULL,
    received_time INTEGER NOT NULL,
    value REAL,
    error TEXT,
    data_quality TEXT DEFAULT 'good' NOT NULL,
    FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE,
    FOREIGN KEY (point_id) REFERENCES point_info(id) ON DELETE CASCADE
);

-- Step 2: Copy data from old table to new table, joining with point_info to get system_id
INSERT INTO point_readings_new (
    id,
    system_id,
    point_id,
    session_id,
    measurement_time,
    received_time,
    value,
    error,
    data_quality
)
SELECT
    pr.id,
    pi.system_id,
    pr.point_id,
    pr.session_id,
    pr.measurement_time,
    pr.received_time,
    pr.value,
    pr.error,
    pr.data_quality
FROM point_readings pr
INNER JOIN point_info pi ON pr.point_id = pi.id;

-- Verify row count matches
-- SELECT
--   (SELECT COUNT(*) FROM point_readings) as old_count,
--   (SELECT COUNT(*) FROM point_readings_new) as new_count;

-- Step 3: Drop old table
DROP TABLE point_readings;

-- Step 4: Rename new table
ALTER TABLE point_readings_new RENAME TO point_readings;

-- Step 5: Recreate indexes with system_id
CREATE UNIQUE INDEX pr_point_time_unique ON point_readings(point_id, measurement_time);
CREATE INDEX pr_system_time_idx ON point_readings(system_id, measurement_time);
CREATE INDEX pr_point_idx ON point_readings(point_id);
CREATE INDEX pr_session_idx ON point_readings(session_id);

-- ============================================================================
-- PART 3: Drop and recreate point_readings_agg_5m with new schema
-- ============================================================================

-- Drop old aggregation table if exists
DROP TABLE IF EXISTS point_readings_agg_5m;

-- Create new table with generic aggregates and error handling
CREATE TABLE point_readings_agg_5m (
    system_id INTEGER NOT NULL,
    point_id INTEGER NOT NULL,
    interval_end INTEGER NOT NULL,
    avg REAL,
    min REAL,
    max REAL,
    last REAL,
    sample_count INTEGER NOT NULL,
    error_count INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    PRIMARY KEY(point_id, interval_end),
    FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE,
    FOREIGN KEY (point_id) REFERENCES point_info(id) ON DELETE CASCADE
);

-- Create index for system + time queries
CREATE INDEX pr5m_system_time_idx ON point_readings_agg_5m(system_id, interval_end);

-- ============================================================================
-- Verification queries (run manually after migration)
-- ============================================================================

-- Check that all point_readings have system_id populated:
-- SELECT COUNT(*) as total_readings,
--        COUNT(system_id) as readings_with_system_id
-- FROM point_readings;

-- Check that backup was created:
-- SELECT COUNT(*) FROM point_readings_backup;

-- Check that indexes were created:
-- SELECT name FROM sqlite_master
-- WHERE type='index' AND tbl_name='point_readings';

-- Verify point_readings_agg_5m schema:
-- PRAGMA table_info(point_readings_agg_5m);

-- Compare old vs new table counts (should match):
-- SELECT
--   (SELECT COUNT(*) FROM point_readings_backup) as backup_count,
--   (SELECT COUNT(*) FROM point_readings) as current_count;
