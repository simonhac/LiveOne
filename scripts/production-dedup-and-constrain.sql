-- Production script to clean up duplicates and add unique constraint
-- Run this in Vercel's database console or via Turso CLI

-- Step 1: Check current duplicate situation
SELECT 
  'Current Status' as report_type,
  system_id,
  COUNT(*) as total_records,
  COUNT(DISTINCT inverter_time) as unique_timestamps,
  COUNT(*) - COUNT(DISTINCT inverter_time) as duplicate_records
FROM readings
GROUP BY system_id;

-- Step 2: Backup duplicates before deletion (for audit trail)
CREATE TABLE IF NOT EXISTS readings_duplicates_backup AS
SELECT r.*
FROM readings r
INNER JOIN (
  SELECT system_id, inverter_time, MIN(id) as keep_id
  FROM readings
  GROUP BY system_id, inverter_time
  HAVING COUNT(*) > 1
) dups ON r.system_id = dups.system_id 
  AND r.inverter_time = dups.inverter_time
  AND r.id != dups.keep_id;

-- Step 3: Count records to be deleted
SELECT 
  'Records to Delete' as report_type,
  COUNT(*) as count
FROM readings
WHERE id NOT IN (
  SELECT MIN(id)
  FROM readings
  GROUP BY system_id, inverter_time
);

-- Step 4: Delete duplicates (keeping the oldest/first record)
DELETE FROM readings
WHERE id NOT IN (
  SELECT MIN(id)
  FROM readings
  GROUP BY system_id, inverter_time
);

-- Step 5: Add unique constraint to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS readings_system_inverter_time_unique 
  ON readings (system_id, inverter_time);

-- Step 6: Verify cleanup success
SELECT 
  'After Cleanup' as report_type,
  system_id,
  COUNT(*) as total_records,
  COUNT(DISTINCT inverter_time) as unique_timestamps,
  CASE 
    WHEN COUNT(*) = COUNT(DISTINCT inverter_time) THEN 'SUCCESS - No duplicates'
    ELSE 'FAILED - Still has duplicates'
  END as status
FROM readings
GROUP BY system_id;

-- Step 7: Show indexes on readings table
SELECT 
  'Indexes' as report_type,
  name as index_name,
  sql as definition
FROM sqlite_master
WHERE type = 'index' 
  AND tbl_name = 'readings';