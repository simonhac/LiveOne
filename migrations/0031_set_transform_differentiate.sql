-- Migration: Set transform='d' for Selectronic and Mondo energy points
-- These points have monotonically increasing energy totals that need to be differentiated
-- to calculate interval energy (delta)

BEGIN TRANSACTION;

-- Update Selectronic: lifetime totals ending in '_wh_total'
UPDATE point_info
SET transform = 'd'
WHERE origin_id = 'selectronic'
  AND origin_sub_id LIKE '%_wh_total'
  AND metric_type = 'energy';

-- Update Mondo: all energy points are monotonic (use UUID pattern for originId)
UPDATE point_info
SET transform = 'd'
WHERE origin_id LIKE '%-%-%-%-%'  -- UUID pattern
  AND origin_sub_id = 'totalEnergyWh'
  AND metric_type = 'energy';

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0031_set_transform_differentiate');
