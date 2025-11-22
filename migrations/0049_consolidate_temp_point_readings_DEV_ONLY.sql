-- Migration: Consolidate TEMP point readings back to original points
--
-- Context: Migration 0036 scrambled point metadata, causing the monitoring system
-- to create new "TEMP_" prefixed points (17-22, etc.) starting Nov 15, 2025.
-- Migration 0044 restored the metadata but left TEMP points with all new data.
--
-- This migration:
-- 1. Moves point_readings from TEMP points back to original points
-- 2. Deletes the TEMP point_info records
--
-- Data distribution (as of Nov 22, 2025):
-- - Points 1-6: Aug 30 - Nov 15 (105K readings each) - OLD DATA
-- - Points 17-22: Nov 15 - Nov 22 (8.5K readings each) - NEW DATA (needs migration)
--
-- The time ranges don't overlap, so no conflicts expected.

BEGIN TRANSACTION;

-- ============================================================================
-- STEP 1: Migrate point_readings from TEMP points to original points
-- ============================================================================

-- System 1: Points 17→1, 18→2, 19→3, 20→4, 21→5, 22→6
UPDATE point_readings SET point_id = 1 WHERE system_id = 1 AND point_id = 17;
UPDATE point_readings SET point_id = 2 WHERE system_id = 1 AND point_id = 18;
UPDATE point_readings SET point_id = 3 WHERE system_id = 1 AND point_id = 19;
UPDATE point_readings SET point_id = 4 WHERE system_id = 1 AND point_id = 20;
UPDATE point_readings SET point_id = 5 WHERE system_id = 1 AND point_id = 21;
UPDATE point_readings SET point_id = 6 WHERE system_id = 1 AND point_id = 22;

-- System 2: Points 17→1, 18→2, 19→3, 20→4, 21→5, 22→6
UPDATE point_readings SET point_id = 1 WHERE system_id = 2 AND point_id = 17;
UPDATE point_readings SET point_id = 2 WHERE system_id = 2 AND point_id = 18;
UPDATE point_readings SET point_id = 3 WHERE system_id = 2 AND point_id = 19;
UPDATE point_readings SET point_id = 4 WHERE system_id = 2 AND point_id = 20;
UPDATE point_readings SET point_id = 5 WHERE system_id = 2 AND point_id = 21;
UPDATE point_readings SET point_id = 6 WHERE system_id = 2 AND point_id = 22;

-- System 3: No point_readings data to migrate

-- System 5: No TEMP points (migration 0044 didn't create them)

-- System 6: Points 19→1, 20→2, 21→3, 22→4, 23→5, 24→6
UPDATE point_readings SET point_id = 1 WHERE system_id = 6 AND point_id = 19;
UPDATE point_readings SET point_id = 2 WHERE system_id = 6 AND point_id = 20;
UPDATE point_readings SET point_id = 3 WHERE system_id = 6 AND point_id = 21;
UPDATE point_readings SET point_id = 4 WHERE system_id = 6 AND point_id = 22;
UPDATE point_readings SET point_id = 5 WHERE system_id = 6 AND point_id = 23;
UPDATE point_readings SET point_id = 6 WHERE system_id = 6 AND point_id = 24;

-- System 9: No TEMP points (migration 0044 didn't create them)

-- ============================================================================
-- STEP 2: Delete TEMP points from point_info
-- ============================================================================

-- System 1: Delete points 17-22
DELETE FROM point_info WHERE system_id = 1 AND id BETWEEN 17 AND 22;

-- System 2: Delete points 17-22
DELETE FROM point_info WHERE system_id = 2 AND id BETWEEN 17 AND 22;

-- System 3: Delete points 3-4 (these were the TEMP ones)
DELETE FROM point_info WHERE system_id = 3 AND id BETWEEN 3 AND 4;

-- System 5: No TEMP points to delete

-- System 6: Delete points 19-24
DELETE FROM point_info WHERE system_id = 6 AND id BETWEEN 19 AND 24;

-- System 9: No TEMP points to delete

COMMIT;

-- Verify migration
SELECT '=== Verification: Point counts after consolidation ===' as step;
SELECT
    system_id,
    point_id,
    COUNT(*) as reading_count,
    datetime(MIN(measurement_time/1000), 'unixepoch') as first_reading,
    datetime(MAX(measurement_time/1000), 'unixepoch') as last_reading
FROM point_readings
WHERE system_id IN (1, 2, 3, 5, 6, 9)
GROUP BY system_id, point_id
ORDER BY system_id, point_id;

SELECT '=== Verification: Remaining point_info records ===' as step;
SELECT system_id, COUNT(*) as point_count
FROM point_info
WHERE system_id IN (1, 2, 3, 5, 6, 9)
GROUP BY system_id
ORDER BY system_id;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0049_consolidate_temp_point_readings');
