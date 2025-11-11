-- Migration: Backfill delta values for energy interval points in point_readings_agg_5m
-- THIS IS THE CORRECTED VERSION (not applied to production)
--
-- Context: Energy points have two patterns:
-- 1. Cumulative counters (transform='d'): Total kWh since install, stored in 'last' field
-- 2. Interval energy (transform != 'd' or NULL): kWh in this interval, stored in 'delta' field
--
-- Before the fix in monitoring-points-manager.ts and point-aggregation-helper.ts,
-- interval energy values were stored in avg/min/max/last instead of delta.
--
-- For aggregated data:
-- - avg = average of interval energies
-- - sample_count = number of readings
-- - delta should be = sum of interval energies = avg * sample_count
--
-- This migration calculates delta from avg and sample_count, then sets avg/min/max/last to NULL.
-- Daily aggregates will be regenerated using /api/cron/daily with action=regenerate.
--
-- FIX: Use (system_id, point_id) composite key instead of just point_id

-- Update point_readings_agg_5m: calculate delta from avg * sample_count
UPDATE point_readings_agg_5m
SET
  delta = avg * sample_count,
  avg = NULL,
  min = NULL,
  max = NULL
WHERE (system_id, point_id) IN (
  SELECT system_id, id FROM point_info
  WHERE metric_type = 'energy' AND (transform IS NULL OR transform != 'd')
)
AND delta IS NULL
AND avg IS NOT NULL;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0035_backfill_energy_delta_5m_corrected');
