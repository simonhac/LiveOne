-- Migration: Clean up point_readings_agg_5m for differentiated points
--
-- For points with transform='d' (differentiated/cumulative counters):
-- 1. Set avg, min, max to NULL (not meaningful for cumulative values)
-- 2. Calculate delta where missing (using previous interval's last value)

BEGIN TRANSACTION;

-- Step 1: Set avg/min/max to NULL for all differentiated point aggregates
-- These values are meaningless for cumulative counters
UPDATE point_readings_agg_5m
SET
  avg = NULL,
  min = NULL,
  max = NULL,
  updated_at = unixepoch() * 1000
WHERE (system_id, point_id) IN (
  SELECT system_id, id
  FROM point_info
  WHERE transform = 'd'
);

-- Step 2: Calculate missing deltas by looking back 5 minutes (300,000ms)
-- Only update rows where delta is currently NULL and a previous interval exists
UPDATE point_readings_agg_5m
SET
  delta = (
    SELECT point_readings_agg_5m.last - prev.last
    FROM point_readings_agg_5m prev
    WHERE prev.system_id = point_readings_agg_5m.system_id
      AND prev.point_id = point_readings_agg_5m.point_id
      AND prev.interval_end = point_readings_agg_5m.interval_end - 300000
  ),
  updated_at = unixepoch() * 1000
WHERE delta IS NULL
  AND (system_id, point_id) IN (
    SELECT system_id, id
    FROM point_info
    WHERE transform = 'd'
  )
  AND EXISTS (
    SELECT 1
    FROM point_readings_agg_5m prev
    WHERE prev.system_id = point_readings_agg_5m.system_id
      AND prev.point_id = point_readings_agg_5m.point_id
      AND prev.interval_end = point_readings_agg_5m.interval_end - 300000
  );

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0032_cleanup_differentiated_point_aggregates');
