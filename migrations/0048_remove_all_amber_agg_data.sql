-- Migration: Remove all Amber (system_id = 9) data from point_readings_agg_5m/daily
-- and delete ALL point_info entries for that system
--
-- Background: Amber data should not use aggregated readings - only raw point_readings
-- This migration removes all aggregated data and all point definitions
--
-- Created: 2025-11-21
--
-- IMPORTANT: Review the output of the pre-checks before running the deletion!
--
-- Pre-checks:
SELECT '=== SAFETY CHECK: Verify system_id 9 is Amber ===' as step;
SELECT id, display_name, vendor_type
FROM systems
WHERE id = 9;

SELECT '=== All point_info entries to be deleted (system 9) ===' as step;
SELECT id, origin_id, origin_sub_id, point_name, type, subtype, extension
FROM point_info
WHERE system_id = 9
ORDER BY id;

SELECT '=== Total points to delete ===' as step;
SELECT COUNT(*) as total_points_to_delete
FROM point_info
WHERE system_id = 9;

SELECT '=== Data volumes in point_readings_agg_5m ===' as step;
SELECT
  COUNT(*) as total_records_to_delete,
  MIN(datetime(interval_end/1000, 'unixepoch')) as earliest,
  MAX(datetime(interval_end/1000, 'unixepoch')) as latest
FROM point_readings_agg_5m
WHERE system_id = 9;

-- Note: point_readings_agg_daily table doesn't exist yet, skipping check

SELECT '=== Point readings (raw) - will NOT be deleted ===' as step;
SELECT
  COUNT(*) as raw_readings_preserved,
  'These will be preserved' as note
FROM point_readings
WHERE system_id = 9;

-- If all the above looks correct, proceed with deletion
-- BEGIN TRANSACTION for atomic deletion
BEGIN TRANSACTION;

-- Step 1: Delete ALL aggregated 5m data for system 9 (Amber)
DELETE FROM point_readings_agg_5m
WHERE system_id = 9;

-- Step 2: Delete ALL point_info entries for system 9
DELETE FROM point_info
WHERE system_id = 9;

COMMIT;

-- Post-deletion verification
SELECT '=== Migration completed ===' as result;

SELECT 'point_info entries remaining for system 9:' as verification,
  COUNT(*) as count,
  CASE WHEN COUNT(*) = 0 THEN '✓ PASS' ELSE '✗ FAIL' END as status
FROM point_info
WHERE system_id = 9;

SELECT 'point_readings_agg_5m records remaining:' as verification,
  COUNT(*) as count,
  CASE WHEN COUNT(*) = 0 THEN '✓ PASS' ELSE '✗ FAIL' END as status
FROM point_readings_agg_5m
WHERE system_id = 9;

SELECT 'Raw point_readings preserved:' as verification,
  COUNT(*) as count,
  CASE WHEN COUNT(*) > 0 THEN '✓ PASS' ELSE '✗ FAIL' END as status
FROM point_readings
WHERE system_id = 9;

SELECT 'System record preserved:' as verification,
  COUNT(*) as count,
  CASE WHEN COUNT(*) = 1 THEN '✓ PASS' ELSE '✗ FAIL' END as status
FROM systems
WHERE id = 9;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0048_remove_all_amber_agg_data');
