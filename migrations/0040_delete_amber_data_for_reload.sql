-- Migration: Delete all Amber Electric data for clean reload
-- The adapter had bugs with Math.abs() on export rates/values
-- Delete all 5m aggregated data for all Amber systems to allow clean re-polling

-- Step 1: Identify all Amber systems
SELECT '=== Step 1: Identifying Amber systems ===' as step;
SELECT id, display_name, vendor_type
FROM systems
WHERE vendor_type = 'amber';

-- Step 2: Count rows before deletion
SELECT '=== Step 2: Row counts before deletion ===' as step;
SELECT
  s.id as system_id,
  s.display_name,
  COUNT(pr.system_id) as row_count
FROM systems s
LEFT JOIN point_readings_agg_5m pr ON s.id = pr.system_id
WHERE s.vendor_type = 'amber'
GROUP BY s.id, s.display_name;

-- Step 3: Delete all data for Amber systems
BEGIN TRANSACTION;

DELETE FROM point_readings_agg_5m
WHERE system_id IN (
  SELECT id FROM systems WHERE vendor_type = 'amber'
);

COMMIT;

-- Step 4: Verify deletion (should show 0 rows for each system)
SELECT '=== Step 4: Row counts after deletion (should be 0) ===' as step;
SELECT
  s.id as system_id,
  s.display_name,
  COUNT(pr.system_id) as row_count
FROM systems s
LEFT JOIN point_readings_agg_5m pr ON s.id = pr.system_id
WHERE s.vendor_type = 'amber'
GROUP BY s.id, s.display_name;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0040_delete_amber_data_for_reload');
