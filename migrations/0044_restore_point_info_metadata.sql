-- Migration: Restore point_info metadata corrupted by migration 0036
--
-- Root Cause: Migration 0036 had a bug in WHERE clause that used:
--   WHERE id IN (SELECT pi.id FROM point_info pi ...)
-- This matched point IDs across ALL systems instead of just Amber systems
-- because 'id' is not unique across systems (it's part of composite PK).
--
-- Impact: Points 1-6 on systems 1, 2, 5, 6 (and points 1-2 on system 3,
-- points 1-6 on system 9) had their metadata corrupted with Amber-style values.
--
-- This migration restores the original metadata from backup snapshot
-- liveone-snapshot-20251116-100416 (taken before corruption).
--
-- IMPORTANT PREREQUISITE: Disable Vercel cron jobs BEFORE running this migration!
-- The monitoring-points-manager caches point_info, and we need to prevent it from
-- creating yet another set of duplicate points while we're fixing the metadata.
--
-- Steps to run this migration safely:
-- 1. Disable cron jobs in Vercel dashboard
-- 2. Run this migration
-- 3. Re-enable cron jobs
-- 4. Wait 2-3 minutes and verify new data flows to old points

BEGIN TRANSACTION;

-- ============================================================================
-- STEP 1: Temporarily rename new points' metadata to avoid UNIQUE constraint
-- The new points (17-22, 14-19, 19-24, etc.) have the correct metadata that
-- we're trying to restore to the old points. We need to temporarily change
-- their origin_sub_id to avoid conflicts with the unique index on
-- (system_id, origin_id, origin_sub_id).
-- ============================================================================

-- System 1: Rename points 17-22
UPDATE point_info SET origin_sub_id = 'TEMP_' || origin_sub_id WHERE system_id = 1 AND id BETWEEN 17 AND 22;

-- System 2: Rename points 17-22
UPDATE point_info SET origin_sub_id = 'TEMP_' || origin_sub_id WHERE system_id = 2 AND id BETWEEN 17 AND 22;

-- System 3: Rename points 3-4
UPDATE point_info SET origin_sub_id = 'TEMP_' || origin_sub_id WHERE system_id = 3 AND id BETWEEN 3 AND 4;

-- System 5: Rename points 14-19
UPDATE point_info SET origin_sub_id = 'TEMP_' || origin_sub_id WHERE system_id = 5 AND id BETWEEN 14 AND 19;

-- System 6: Rename points 19-24
UPDATE point_info SET origin_sub_id = 'TEMP_' || origin_sub_id WHERE system_id = 6 AND id BETWEEN 19 AND 24;

-- System 9: Rename points 10-15
UPDATE point_info SET origin_sub_id = 'TEMP_' || origin_sub_id WHERE system_id = 9 AND id BETWEEN 10 AND 15;

-- ============================================================================
-- STEP 2: Restore original metadata to old points (1-6)
-- ============================================================================

-- ============================================================================
-- SYSTEM 1: Selectronic (daylesford)
-- ============================================================================

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'solar_w',
    point_name = 'Solar',
    display_name = 'Solar'
WHERE system_id = 1 AND id = 1;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'solarinverter_w',
    point_name = 'Solar Remote',
    display_name = 'Solar Remote'
WHERE system_id = 1 AND id = 2;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'shunt_w',
    point_name = 'Solar Local',
    display_name = 'Solar Local'
WHERE system_id = 1 AND id = 3;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'load_w',
    point_name = 'Load',
    display_name = 'Load'
WHERE system_id = 1 AND id = 4;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'battery_w',
    point_name = 'Battery',
    display_name = 'Battery'
WHERE system_id = 1 AND id = 5;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'grid_w',
    point_name = 'Grid',
    display_name = 'Grid'
WHERE system_id = 1 AND id = 6;

-- ============================================================================
-- SYSTEM 2: Selectronic (no alias)
-- ============================================================================

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'solar_w',
    point_name = 'Solar',
    display_name = 'Solar'
WHERE system_id = 2 AND id = 1;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'solarinverter_w',
    point_name = 'Solar Remote',
    display_name = 'Solar Remote'
WHERE system_id = 2 AND id = 2;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'shunt_w',
    point_name = 'Solar Local',
    display_name = 'Solar Local'
WHERE system_id = 2 AND id = 3;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'load_w',
    point_name = 'Load',
    display_name = 'Load'
WHERE system_id = 2 AND id = 4;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'battery_w',
    point_name = 'Battery',
    display_name = 'Battery'
WHERE system_id = 2 AND id = 5;

UPDATE point_info
SET origin_id = 'selectronic',
    origin_sub_id = 'grid_w',
    point_name = 'Grid',
    display_name = 'Grid'
WHERE system_id = 2 AND id = 6;

-- ============================================================================
-- SYSTEM 3: Enphase (no alias)
-- ============================================================================

UPDATE point_info
SET origin_id = 'enphase',
    origin_sub_id = 'solar_w',
    point_name = 'Solar',
    display_name = 'Solar'
WHERE system_id = 3 AND id = 1;

UPDATE point_info
SET origin_id = 'enphase',
    origin_sub_id = 'solar_interval_wh',
    point_name = 'Solar Interval',
    display_name = 'Solar Interval'
WHERE system_id = 3 AND id = 2;

-- ============================================================================
-- SYSTEM 5: Fronius (kink_fron)
-- ============================================================================

UPDATE point_info
SET origin_id = 'fronius',
    origin_sub_id = 'solarW',
    point_name = 'Solar',
    display_name = 'Solar'
WHERE system_id = 5 AND id = 1;

UPDATE point_info
SET origin_id = 'fronius',
    origin_sub_id = 'solarRemoteW',
    point_name = 'Solar Remote',
    display_name = 'Solar Remote'
WHERE system_id = 5 AND id = 2;

UPDATE point_info
SET origin_id = 'fronius',
    origin_sub_id = 'solarLocalW',
    point_name = 'Solar Local',
    display_name = 'Solar Local'
WHERE system_id = 5 AND id = 3;

UPDATE point_info
SET origin_id = 'fronius',
    origin_sub_id = 'loadW',
    point_name = 'Load',
    display_name = 'Load'
WHERE system_id = 5 AND id = 4;

UPDATE point_info
SET origin_id = 'fronius',
    origin_sub_id = 'batteryW',
    point_name = 'Battery',
    display_name = 'Battery'
WHERE system_id = 5 AND id = 5;

UPDATE point_info
SET origin_id = 'fronius',
    origin_sub_id = 'gridW',
    point_name = 'Grid',
    display_name = 'Grid'
WHERE system_id = 5 AND id = 6;

-- ============================================================================
-- SYSTEM 6: Mondo (kink_mondo)
-- ============================================================================

UPDATE point_info
SET origin_id = '8fb1e79b-82a2-4447-a217-ad12e0acca16',
    origin_sub_id = 'energyNowW',
    point_name = 'Tesla EV charger',
    display_name = 'EV'
WHERE system_id = 6 AND id = 1;

UPDATE point_info
SET origin_id = '8fb1e79b-82a2-4447-a217-ad12e0acca16',
    origin_sub_id = 'totalEnergyWh',
    point_name = 'Tesla EV charger',
    display_name = 'EV'
WHERE system_id = 6 AND id = 2;

UPDATE point_info
SET origin_id = '79cb48d6-bcd8-4055-b89a-93a53ab80226',
    origin_sub_id = 'energyNowW',
    point_name = 'Heat Pump',
    display_name = 'Heat Pump'
WHERE system_id = 6 AND id = 3;

UPDATE point_info
SET origin_id = '79cb48d6-bcd8-4055-b89a-93a53ab80226',
    origin_sub_id = 'totalEnergyWh',
    point_name = 'Heat Pump',
    display_name = 'HWS'
WHERE system_id = 6 AND id = 4;

UPDATE point_info
SET origin_id = '6ddf41bc-7a1e-4252-a6ae-78205b057662',
    origin_sub_id = 'energyNowW',
    point_name = 'Pool',
    display_name = 'Pool'
WHERE system_id = 6 AND id = 5;

UPDATE point_info
SET origin_id = '6ddf41bc-7a1e-4252-a6ae-78205b057662',
    origin_sub_id = 'totalEnergyWh',
    point_name = 'Pool',
    display_name = 'Pool'
WHERE system_id = 6 AND id = 6;

-- ============================================================================
-- SYSTEM 9: Amber (no alias)
-- Note: This system was SUPPOSED to get updated by migration 0036, but the
-- bug corrupted it too. We restore original, then migration 0036 fix will
-- apply the intended changes.
-- ============================================================================

UPDATE point_info
SET origin_id = 'E1',
    origin_sub_id = 'price',
    point_name = 'Grid import price',
    display_name = 'Grid import price'
WHERE system_id = 9 AND id = 1;

UPDATE point_info
SET origin_id = 'B1',
    origin_sub_id = 'price',
    point_name = 'Grid export price',
    display_name = 'Grid export price'
WHERE system_id = 9 AND id = 2;

UPDATE point_info
SET origin_id = 'E1',
    origin_sub_id = 'energy',
    point_name = 'Grid import energy',
    display_name = 'Grid import energy'
WHERE system_id = 9 AND id = 3;

UPDATE point_info
SET origin_id = 'E1',
    origin_sub_id = 'cost',
    point_name = 'Grid import cost',
    display_name = 'Grid import cost'
WHERE system_id = 9 AND id = 4;

UPDATE point_info
SET origin_id = 'B1',
    origin_sub_id = 'energy',
    point_name = 'Grid export energy',
    display_name = 'Grid export energy'
WHERE system_id = 9 AND id = 5;

UPDATE point_info
SET origin_id = 'B1',
    origin_sub_id = 'revenue',
    point_name = 'Grid export revenue',
    display_name = 'Grid export revenue'
WHERE system_id = 9 AND id = 6;

COMMIT;

-- Verify restoration
SELECT '=== Verification: Restored metadata ===' as step;
SELECT system_id, id, display_name, origin_id, origin_sub_id
FROM point_info
WHERE (system_id IN (1,2,5,6) AND id <= 6)
   OR (system_id = 3 AND id <= 2)
   OR (system_id = 9 AND id <= 6)
ORDER BY system_id, id;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0044_restore_point_info_metadata');
