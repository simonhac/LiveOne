-- Script to clean up duplicate timestamps in the readings table
-- This will keep only one record per unique (system_id, inverter_time) combination
-- We'll keep the record with the lowest ID (assumed to be the first inserted)

-- First, let's see how many duplicates we have
SELECT 
  system_id,
  COUNT(*) as total_records,
  COUNT(DISTINCT inverter_time) as unique_timestamps,
  COUNT(*) - COUNT(DISTINCT inverter_time) as duplicate_records,
  ROUND((COUNT(*) - COUNT(DISTINCT inverter_time)) * 100.0 / COUNT(*), 1) as duplicate_percentage
FROM readings
GROUP BY system_id;

-- Show some examples of the duplicates
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

-- Create a backup table before we delete anything
CREATE TABLE IF NOT EXISTS readings_backup_before_dedup AS 
SELECT * FROM readings;

-- Delete duplicate records, keeping only the one with the lowest ID for each (system_id, inverter_time)
DELETE FROM readings
WHERE id NOT IN (
  SELECT MIN(id)
  FROM readings
  GROUP BY system_id, inverter_time
);

-- Verify the cleanup
SELECT 
  system_id,
  COUNT(*) as total_records_after,
  COUNT(DISTINCT inverter_time) as unique_timestamps_after,
  COUNT(*) - COUNT(DISTINCT inverter_time) as remaining_duplicates
FROM readings
GROUP BY system_id;

-- Show the reduction in record count
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