-- Migration: Backfill point_readings_agg_5m from historical point_readings data
-- Date: 2025-01-12
-- Changes:
--   1. Calculate 5-minute aggregates for all historical point_readings
--   2. Insert into point_readings_agg_5m table
--
-- This is a ONE-TIME migration to populate aggregates from historical data.
-- After this, aggregates are created automatically during polling.

-- ============================================================================
-- Backfill aggregates from historical data
-- ============================================================================

INSERT INTO point_readings_agg_5m (
  system_id,
  point_id,
  interval_end,
  avg,
  min,
  max,
  last,
  sample_count,
  error_count,
  created_at,
  updated_at
)
WITH intervals AS (
  -- Calculate interval_end and row number for each reading
  -- Use window function to identify the last reading in each interval
  SELECT
    system_id,
    point_id,
    measurement_time,
    value,
    -- Calculate 5-minute interval end using ceiling division
    -- This matches the TypeScript: Math.ceil(measurementTime / intervalMs) * intervalMs
    CAST((measurement_time + (5 * 60 * 1000) - 1) / (5 * 60 * 1000) AS INTEGER) * (5 * 60 * 1000) as interval_end,
    -- Mark the last reading in each interval (row_num = 1 means most recent)
    ROW_NUMBER() OVER (
      PARTITION BY
        system_id,
        point_id,
        CAST((measurement_time + (5 * 60 * 1000) - 1) / (5 * 60 * 1000) AS INTEGER) * (5 * 60 * 1000)
      ORDER BY measurement_time DESC
    ) as row_num
  FROM point_readings
)
SELECT
  system_id,
  point_id,
  interval_end,
  -- Aggregates (only from non-null values)
  AVG(CASE WHEN value IS NOT NULL THEN value END) as avg,
  MIN(CASE WHEN value IS NOT NULL THEN value END) as min,
  MAX(CASE WHEN value IS NOT NULL THEN value END) as max,
  -- Last value chronologically (row_num = 1 is the most recent reading)
  MAX(CASE WHEN row_num = 1 THEN value END) as last,
  -- Sample count (non-null values)
  SUM(CASE WHEN value IS NOT NULL THEN 1 ELSE 0 END) as sample_count,
  -- Error count (null values)
  SUM(CASE WHEN value IS NULL THEN 1 ELSE 0 END) as error_count,
  -- Timestamps
  (unixepoch() * 1000) as created_at,
  (unixepoch() * 1000) as updated_at
FROM intervals
GROUP BY system_id, point_id, interval_end
-- Use INSERT OR IGNORE to skip any intervals that were already aggregated
-- (in case this migration is run after some polling has occurred)
ON CONFLICT(point_id, interval_end) DO NOTHING;

-- ============================================================================
-- Verification queries (run manually after migration)
-- ============================================================================

-- Check how many aggregates were created:
-- SELECT COUNT(*) as total_aggregates FROM point_readings_agg_5m;

-- Check aggregate counts by system:
-- SELECT
--   system_id,
--   COUNT(*) as aggregate_count,
--   MIN(datetime(interval_end/1000, 'unixepoch')) as first_interval,
--   MAX(datetime(interval_end/1000, 'unixepoch')) as last_interval
-- FROM point_readings_agg_5m
-- GROUP BY system_id;

-- Verify aggregates match raw data for a sample interval:
-- SELECT
--   'Aggregates' as source,
--   point_id,
--   datetime(interval_end/1000, 'unixepoch') as time,
--   avg, min, max, last, sample_count, error_count
-- FROM point_readings_agg_5m
-- WHERE system_id = 6
-- ORDER BY interval_end DESC
-- LIMIT 5;

-- Sample the raw data that was aggregated:
-- WITH sample_interval AS (
--   SELECT interval_end FROM point_readings_agg_5m LIMIT 1
-- )
-- SELECT
--   'Raw data' as source,
--   point_id,
--   datetime(measurement_time/1000, 'unixepoch') as time,
--   value
-- FROM point_readings pr, sample_interval si
-- WHERE pr.system_id = 6
--   AND pr.measurement_time > (si.interval_end - (5 * 60 * 1000))
--   AND pr.measurement_time <= si.interval_end
-- ORDER BY pr.point_id, pr.measurement_time;
