-- Migration: Backfill SOC avg/min/max values in point_readings_agg_5m
--
-- The original migration (0018) only copied the 'last' value for SOC data.
-- This migration computes avg/min/max from raw point_readings for all intervals.
--
-- Strategy:
-- 1. For each 5-minute interval with SOC data (where last IS NOT NULL)
-- 2. Compute AVG/MIN/MAX from raw point_readings within that interval
-- 3. Update the aggregated record with the computed values
-- 4. Update sample_count with the number of raw readings used

BEGIN TRANSACTION;

-- Create a temporary table with the computed aggregates
CREATE TEMP TABLE soc_backfill AS
SELECT
  pa.system_id,
  pa.point_id,
  pa.interval_end,
  AVG(pr.value) as computed_avg,
  MIN(pr.value) as computed_min,
  MAX(pr.value) as computed_max,
  COUNT(pr.value) as computed_sample_count,
  SUM(CASE WHEN pr.error IS NOT NULL THEN 1 ELSE 0 END) as computed_error_count
FROM point_readings_agg_5m pa
JOIN point_info pi
  ON pi.system_id = pa.system_id
  AND pi.id = pa.point_id
LEFT JOIN point_readings pr
  ON pr.system_id = pa.system_id
  AND pr.point_id = pa.point_id
  AND pr.measurement_time > (pa.interval_end - 300000)  -- 5 minutes before interval_end
  AND pr.measurement_time <= pa.interval_end
WHERE pi.metric_type = 'soc'
  AND pa.last IS NOT NULL
GROUP BY pa.system_id, pa.point_id, pa.interval_end;

-- Add index to temp table for faster lookups
CREATE INDEX idx_soc_backfill ON soc_backfill(system_id, point_id, interval_end);

-- Update point_readings_agg_5m with computed values
-- For intervals with raw readings, use computed avg/min/max
UPDATE point_readings_agg_5m
SET
  avg = (SELECT sb.computed_avg FROM soc_backfill sb
         WHERE sb.system_id = point_readings_agg_5m.system_id
         AND sb.point_id = point_readings_agg_5m.point_id
         AND sb.interval_end = point_readings_agg_5m.interval_end),
  min = (SELECT sb.computed_min FROM soc_backfill sb
         WHERE sb.system_id = point_readings_agg_5m.system_id
         AND sb.point_id = point_readings_agg_5m.point_id
         AND sb.interval_end = point_readings_agg_5m.interval_end),
  max = (SELECT sb.computed_max FROM soc_backfill sb
         WHERE sb.system_id = point_readings_agg_5m.system_id
         AND sb.point_id = point_readings_agg_5m.point_id
         AND sb.interval_end = point_readings_agg_5m.interval_end),
  sample_count = (SELECT sb.computed_sample_count FROM soc_backfill sb
                  WHERE sb.system_id = point_readings_agg_5m.system_id
                  AND sb.point_id = point_readings_agg_5m.point_id
                  AND sb.interval_end = point_readings_agg_5m.interval_end),
  error_count = (SELECT sb.computed_error_count FROM soc_backfill sb
                 WHERE sb.system_id = point_readings_agg_5m.system_id
                 AND sb.point_id = point_readings_agg_5m.point_id
                 AND sb.interval_end = point_readings_agg_5m.interval_end)
WHERE EXISTS (
  SELECT 1 FROM soc_backfill sb
  WHERE sb.system_id = point_readings_agg_5m.system_id
    AND sb.point_id = point_readings_agg_5m.point_id
    AND sb.interval_end = point_readings_agg_5m.interval_end
    AND sb.computed_sample_count > 0
);

-- For intervals without raw readings, use last value for avg/min/max with sample_count = 0
UPDATE point_readings_agg_5m
SET
  avg = last,
  min = last,
  max = last,
  sample_count = 0,
  error_count = 0
WHERE EXISTS (
  SELECT 1
  FROM point_info pi
  WHERE pi.system_id = point_readings_agg_5m.system_id
    AND pi.id = point_readings_agg_5m.point_id
    AND pi.metric_type = 'soc'
)
AND last IS NOT NULL
AND avg IS NULL;

-- Clean up temp table
DROP TABLE soc_backfill;

COMMIT;

-- Validation: Check that all SOC intervals with 'last' now have 'avg'
SELECT
  'Validation' as check_type,
  COUNT(*) as intervals_still_missing_avg
FROM point_readings_agg_5m pa
JOIN point_info pi
  ON pi.system_id = pa.system_id
  AND pi.id = pa.point_id
WHERE pi.metric_type = 'soc'
  AND pa.last IS NOT NULL
  AND pa.avg IS NULL;

-- Expected result: intervals_still_missing_avg should be 0

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0034_backfill_soc_aggregates');
