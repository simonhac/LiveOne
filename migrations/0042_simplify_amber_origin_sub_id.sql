-- Migration: Simplify Amber Electric origin_sub_id values
-- Removes channel-specific prefixes (export_, import_) from origin_sub_id
-- This reverses migration 0036's naming convention
--
-- Before:
--   export_cost, export_kwh, export_perKwh
--   import_cost, import_kwh, import_perKwh
-- After:
--   cost, kwh, perKwh (differentiated by origin_id: E1 vs B1)

-- Step 1: Check current state (display rows that will be affected)
SELECT '=== Step 1: Current state - rows to be updated ===' as step;
SELECT
  pi.system_id,
  s.display_name as system_name,
  pi.id as point_id,
  pi.origin_id,
  pi.origin_sub_id as current_sub_id,
  pi.point_name,
  pi.metric_type
FROM point_info pi
JOIN systems s ON pi.system_id = s.id
WHERE s.vendor_type = 'amber'
  AND pi.origin_sub_id IN (
    'export_cost', 'export_kwh', 'export_perKwh',
    'import_cost', 'import_kwh', 'import_perKwh'
  )
ORDER BY pi.system_id, pi.origin_id, pi.origin_sub_id;

-- Step 2: Check for potential conflicts
-- The unique index is on (system_id, origin_id, origin_sub_id)
-- After removing prefixes, we need to ensure no duplicates within same origin_id
SELECT '=== Step 2: Checking for conflicts (should be empty) ===' as step;
SELECT
  pi.system_id,
  pi.origin_id,
  REPLACE(REPLACE(pi.origin_sub_id, 'export_', ''), 'import_', '') as new_sub_id,
  COUNT(*) as conflict_count
FROM point_info pi
JOIN systems s ON pi.system_id = s.id
WHERE s.vendor_type = 'amber'
  AND pi.origin_sub_id IN (
    'export_cost', 'export_kwh', 'export_perKwh',
    'import_cost', 'import_kwh', 'import_perKwh'
  )
GROUP BY pi.system_id, pi.origin_id, new_sub_id
HAVING COUNT(*) > 1;

-- Step 3: Apply the changes in a transaction
BEGIN TRANSACTION;

-- Update import channel points (origin_id = 'E1')
-- Remove 'import_' prefix from origin_sub_id

UPDATE point_info
SET origin_sub_id = 'kwh'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_id = 'E1'
  AND origin_sub_id = 'import_kwh';

UPDATE point_info
SET origin_sub_id = 'cost'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_id = 'E1'
  AND origin_sub_id = 'import_cost';

UPDATE point_info
SET origin_sub_id = 'perKwh'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_id = 'E1'
  AND origin_sub_id = 'import_perKwh';

-- Update export/feedIn channel points (origin_id = 'B1')
-- Remove 'export_' prefix from origin_sub_id

UPDATE point_info
SET origin_sub_id = 'kwh'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_id = 'B1'
  AND origin_sub_id = 'export_kwh';

UPDATE point_info
SET origin_sub_id = 'cost'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_id = 'B1'
  AND origin_sub_id = 'export_cost';

UPDATE point_info
SET origin_sub_id = 'perKwh'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_id = 'B1'
  AND origin_sub_id = 'export_perKwh';

-- Update controlled load channel points if they exist (origin_id might vary)
-- Remove 'controlled_' prefix from origin_sub_id

UPDATE point_info
SET origin_sub_id = 'kwh'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_sub_id = 'controlled_kwh';

UPDATE point_info
SET origin_sub_id = 'cost'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_sub_id = 'controlled_cost';

UPDATE point_info
SET origin_sub_id = 'perKwh'
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'amber')
  AND origin_sub_id = 'controlled_perKwh';

COMMIT;

-- Step 4: Verify changes (should show simplified origin_sub_id values)
SELECT '=== Step 4: After migration - verify changes ===' as step;
SELECT
  pi.system_id,
  s.display_name as system_name,
  pi.id as point_id,
  pi.origin_id,
  pi.origin_sub_id as new_sub_id,
  pi.point_name,
  pi.metric_type
FROM point_info pi
JOIN systems s ON pi.system_id = s.id
WHERE s.vendor_type = 'amber'
  AND pi.origin_id IN ('E1', 'B1')
ORDER BY pi.system_id, pi.origin_id, pi.origin_sub_id;

-- Step 5: Verify no old prefixed values remain
SELECT '=== Step 5: Check for any remaining prefixed values (should be empty) ===' as step;
SELECT
  pi.system_id,
  pi.origin_id,
  pi.origin_sub_id
FROM point_info pi
JOIN systems s ON pi.system_id = s.id
WHERE s.vendor_type = 'amber'
  AND (pi.origin_sub_id LIKE 'export_%' OR pi.origin_sub_id LIKE 'import_%' OR pi.origin_sub_id LIKE 'controlled_%');

-- Step 6: Summary statistics
SELECT '=== Step 6: Summary by origin_id ===' as step;
SELECT
  s.display_name as system_name,
  pi.origin_id,
  GROUP_CONCAT(pi.origin_sub_id, ', ') as sub_ids,
  COUNT(*) as point_count
FROM point_info pi
JOIN systems s ON pi.system_id = s.id
WHERE s.vendor_type = 'amber'
GROUP BY s.id, s.display_name, pi.origin_id
ORDER BY s.id, pi.origin_id;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0042_simplify_amber_origin_sub_id');
