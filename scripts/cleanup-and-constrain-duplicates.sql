-- Script to clean up duplicate timestamps and add unique constraint
-- This ensures data integrity going forward

-- Step 1: Analyze the duplicate situation
SELECT 
  system_id,
  COUNT(*) as total_records,
  COUNT(DISTINCT inverter_time) as unique_timestamps,
  COUNT(*) - COUNT(DISTINCT inverter_time) as duplicate_records,
  ROUND((COUNT(*) - COUNT(DISTINCT inverter_time)) * 100.0 / COUNT(*), 1) as duplicate_percentage
FROM readings
GROUP BY system_id;

-- Step 2: Show some examples of the duplicates to verify they're truly identical
SELECT 
  system_id,
  inverter_time,
  datetime(inverter_time, 'unixepoch') as timestamp_readable,
  COUNT(*) as duplicate_count,
  GROUP_CONCAT(id) as record_ids,
  MIN(solar_w) as min_solar_w,
  MAX(solar_w) as max_solar_w,
  MIN(battery_soc) as min_soc,
  MAX(battery_soc) as max_soc
FROM readings
WHERE system_id = 1
GROUP BY system_id, inverter_time
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, inverter_time DESC
LIMIT 10;

-- Step 3: Create a backup table before making changes
CREATE TABLE IF NOT EXISTS readings_backup_before_dedup AS 
SELECT * FROM readings;

-- Step 4: Delete duplicate records, keeping only the one with the lowest ID
DELETE FROM readings
WHERE id NOT IN (
  SELECT MIN(id)
  FROM readings
  GROUP BY system_id, inverter_time
);

-- Step 5: Verify the cleanup was successful
SELECT 
  system_id,
  COUNT(*) as total_records_after,
  COUNT(DISTINCT inverter_time) as unique_timestamps_after,
  COUNT(*) - COUNT(DISTINCT inverter_time) as remaining_duplicates
FROM readings
GROUP BY system_id;

-- Step 6: Create unique index to prevent future duplicates
-- This will fail if there are still duplicates, acting as a safety check
CREATE UNIQUE INDEX IF NOT EXISTS readings_system_inverter_time_unique 
  ON readings (system_id, inverter_time);

-- Step 7: Show the reduction in record count
SELECT 
  'Before' as stage,
  COUNT(*) as record_count
FROM readings_backup_before_dedup
WHERE system_id = 1
UNION ALL
SELECT 
  'After' as stage,
  COUNT(*) as record_count
FROM readings
WHERE system_id = 1;

-- Step 8: Verify the unique constraint is in place
SELECT 
  name,
  sql
FROM sqlite_master
WHERE type = 'index' 
  AND tbl_name = 'readings'
  AND name LIKE '%unique%';