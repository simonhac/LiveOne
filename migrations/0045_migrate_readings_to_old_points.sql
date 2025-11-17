-- Migration: Migrate readings from duplicate points back to original points
--
-- After migration 0044 restored correct metadata to old points (1-6),
-- this migration moves all historical readings from the duplicate points
-- (17-22, 14-19, 19-24, etc.) back to the original points where they belong.
--
-- The duplicate points were created between Nov 16 06:06 and Nov 17 09:56
-- when monitoring-points-manager couldn't find points with correct metadata.
-- Those readings should be associated with the original points.
--
-- Data ranges (no timestamp overlap, so safe to migrate):
-- - Old points: Data up to Nov 16 ~06:06 (before corruption)
-- - New points: Data from Nov 16 ~06:06 onwards (after corruption)
--
-- BASELINE COUNTS (before migration, captured at 2025-11-17 20:12):
--
-- point_readings:
--   System 1: Old ~107,463/point, Dup ~1,987/point → Expected after: ~109,450/point
--   System 2: Old ~110,503/point, Dup ~1,994/point → Expected after: ~112,497/point
--   System 5: Old ~59,548/point, Dup ~2,016/point → Expected after: ~61,564/point
--   System 6: Old ~27,648/point, Dup ~1,006/point → Expected after: ~28,654/point
--
-- point_readings_agg_5m:
--   System 1: Old varies, Dup ~404/point → Expected gain: ~404/point
--   System 2: Old varies, Dup ~405/point → Expected gain: ~405/point
--   System 3: Old ~21,787/point, Dup ~576/point → Expected after: ~22,363/point
--   System 5: Old varies, Dup ~405/point → Expected gain: ~405/point
--   System 6: Old ~12,605/point, Dup ~404/point → Expected after: ~13,009/point
--   System 9: Old varies, Dup 96/48/... → Expected gain: 96/48/...

BEGIN TRANSACTION;

-- ============================================================================
-- Migrate point_readings table
-- ============================================================================

-- System 1: Points 17-22 → 1-6
UPDATE point_readings SET point_id = 1 WHERE system_id = 1 AND point_id = 17;
UPDATE point_readings SET point_id = 2 WHERE system_id = 1 AND point_id = 18;
UPDATE point_readings SET point_id = 3 WHERE system_id = 1 AND point_id = 19;
UPDATE point_readings SET point_id = 4 WHERE system_id = 1 AND point_id = 20;
UPDATE point_readings SET point_id = 5 WHERE system_id = 1 AND point_id = 21;
UPDATE point_readings SET point_id = 6 WHERE system_id = 1 AND point_id = 22;

-- System 2: Points 17-22 → 1-6
UPDATE point_readings SET point_id = 1 WHERE system_id = 2 AND point_id = 17;
UPDATE point_readings SET point_id = 2 WHERE system_id = 2 AND point_id = 18;
UPDATE point_readings SET point_id = 3 WHERE system_id = 2 AND point_id = 19;
UPDATE point_readings SET point_id = 4 WHERE system_id = 2 AND point_id = 20;
UPDATE point_readings SET point_id = 5 WHERE system_id = 2 AND point_id = 21;
UPDATE point_readings SET point_id = 6 WHERE system_id = 2 AND point_id = 22;

-- System 3: No point_readings, only agg_5m

-- System 5: Points 14-19 → 1-6
UPDATE point_readings SET point_id = 1 WHERE system_id = 5 AND point_id = 14;
UPDATE point_readings SET point_id = 2 WHERE system_id = 5 AND point_id = 15;
UPDATE point_readings SET point_id = 3 WHERE system_id = 5 AND point_id = 16;
UPDATE point_readings SET point_id = 4 WHERE system_id = 5 AND point_id = 17;
UPDATE point_readings SET point_id = 5 WHERE system_id = 5 AND point_id = 18;
UPDATE point_readings SET point_id = 6 WHERE system_id = 5 AND point_id = 19;

-- System 6: Points 19-24 → 1-6
UPDATE point_readings SET point_id = 1 WHERE system_id = 6 AND point_id = 19;
UPDATE point_readings SET point_id = 2 WHERE system_id = 6 AND point_id = 20;
UPDATE point_readings SET point_id = 3 WHERE system_id = 6 AND point_id = 21;
UPDATE point_readings SET point_id = 4 WHERE system_id = 6 AND point_id = 22;
UPDATE point_readings SET point_id = 5 WHERE system_id = 6 AND point_id = 23;
UPDATE point_readings SET point_id = 6 WHERE system_id = 6 AND point_id = 24;

-- System 9: No point_readings, only agg_5m

-- ============================================================================
-- STEP 1: Backup overlapping 5m aggregates from old points
-- After re-enabling cron jobs, new aggregates were created for old points that
-- overlap with duplicate points' interval_end timestamps. We backup these
-- overlapping aggregates before migrating to avoid UNIQUE constraint violations.
-- ============================================================================

-- Create backup table for overlapping aggregates (matches point_readings_agg_5m schema)
CREATE TABLE IF NOT EXISTS point_readings_agg_5m_backup_overlap (
  system_id INTEGER NOT NULL,
  point_id INTEGER NOT NULL,
  interval_end INTEGER NOT NULL,
  avg REAL,
  min REAL,
  max REAL,
  last REAL,
  sample_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  session_id INTEGER,
  delta REAL DEFAULT NULL,
  value_str TEXT,
  data_quality TEXT,
  PRIMARY KEY (system_id, point_id, interval_end)
);

-- Backup System 1: aggregates in range Nov 16 06:10 to Nov 17 16:05
INSERT INTO point_readings_agg_5m_backup_overlap
SELECT * FROM point_readings_agg_5m
WHERE system_id = 1
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395500000;

DELETE FROM point_readings_agg_5m
WHERE system_id = 1
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395500000;

-- Backup System 2: aggregates in range Nov 16 06:10 to Nov 17 16:10
INSERT INTO point_readings_agg_5m_backup_overlap
SELECT * FROM point_readings_agg_5m
WHERE system_id = 2
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395800000;

DELETE FROM point_readings_agg_5m
WHERE system_id = 2
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395800000;

-- Backup System 3: aggregates in range Nov 15 13:05 to Nov 17 13:00
INSERT INTO point_readings_agg_5m_backup_overlap
SELECT * FROM point_readings_agg_5m
WHERE system_id = 3
  AND point_id <= 2
  AND interval_end BETWEEN 1763211900000 AND 1763384400000;

DELETE FROM point_readings_agg_5m
WHERE system_id = 3
  AND point_id <= 2
  AND interval_end BETWEEN 1763211900000 AND 1763384400000;

-- Backup System 5: aggregates in range Nov 16 06:10 to Nov 17 16:10
INSERT INTO point_readings_agg_5m_backup_overlap
SELECT * FROM point_readings_agg_5m
WHERE system_id = 5
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395800000;

DELETE FROM point_readings_agg_5m
WHERE system_id = 5
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395800000;

-- Backup System 6: aggregates in range Nov 16 06:10 to Nov 17 16:05
INSERT INTO point_readings_agg_5m_backup_overlap
SELECT * FROM point_readings_agg_5m
WHERE system_id = 6
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395500000;

DELETE FROM point_readings_agg_5m
WHERE system_id = 6
  AND point_id <= 6
  AND interval_end BETWEEN 1763273400000 AND 1763395500000;

-- Backup System 9: aggregates in range Nov 15 14:30 to Nov 17 14:00
INSERT INTO point_readings_agg_5m_backup_overlap
SELECT * FROM point_readings_agg_5m
WHERE system_id = 9
  AND point_id <= 6
  AND interval_end BETWEEN 1763217000000 AND 1763388000000;

DELETE FROM point_readings_agg_5m
WHERE system_id = 9
  AND point_id <= 6
  AND interval_end BETWEEN 1763217000000 AND 1763388000000;

-- ============================================================================
-- STEP 2: Migrate point_readings_agg_5m table
-- ============================================================================

-- System 1: Points 17-22 → 1-6
UPDATE point_readings_agg_5m SET point_id = 1 WHERE system_id = 1 AND point_id = 17;
UPDATE point_readings_agg_5m SET point_id = 2 WHERE system_id = 1 AND point_id = 18;
UPDATE point_readings_agg_5m SET point_id = 3 WHERE system_id = 1 AND point_id = 19;
UPDATE point_readings_agg_5m SET point_id = 4 WHERE system_id = 1 AND point_id = 20;
UPDATE point_readings_agg_5m SET point_id = 5 WHERE system_id = 1 AND point_id = 21;
UPDATE point_readings_agg_5m SET point_id = 6 WHERE system_id = 1 AND point_id = 22;

-- System 2: Points 17-22 → 1-6
UPDATE point_readings_agg_5m SET point_id = 1 WHERE system_id = 2 AND point_id = 17;
UPDATE point_readings_agg_5m SET point_id = 2 WHERE system_id = 2 AND point_id = 18;
UPDATE point_readings_agg_5m SET point_id = 3 WHERE system_id = 2 AND point_id = 19;
UPDATE point_readings_agg_5m SET point_id = 4 WHERE system_id = 2 AND point_id = 20;
UPDATE point_readings_agg_5m SET point_id = 5 WHERE system_id = 2 AND point_id = 21;
UPDATE point_readings_agg_5m SET point_id = 6 WHERE system_id = 2 AND point_id = 22;

-- System 3: Points 3-4 → 1-2
UPDATE point_readings_agg_5m SET point_id = 1 WHERE system_id = 3 AND point_id = 3;
UPDATE point_readings_agg_5m SET point_id = 2 WHERE system_id = 3 AND point_id = 4;

-- System 5: Points 14-19 → 1-6
UPDATE point_readings_agg_5m SET point_id = 1 WHERE system_id = 5 AND point_id = 14;
UPDATE point_readings_agg_5m SET point_id = 2 WHERE system_id = 5 AND point_id = 15;
UPDATE point_readings_agg_5m SET point_id = 3 WHERE system_id = 5 AND point_id = 16;
UPDATE point_readings_agg_5m SET point_id = 4 WHERE system_id = 5 AND point_id = 17;
UPDATE point_readings_agg_5m SET point_id = 5 WHERE system_id = 5 AND point_id = 18;
UPDATE point_readings_agg_5m SET point_id = 6 WHERE system_id = 5 AND point_id = 19;

-- System 6: Points 19-24 → 1-6
UPDATE point_readings_agg_5m SET point_id = 1 WHERE system_id = 6 AND point_id = 19;
UPDATE point_readings_agg_5m SET point_id = 2 WHERE system_id = 6 AND point_id = 20;
UPDATE point_readings_agg_5m SET point_id = 3 WHERE system_id = 6 AND point_id = 21;
UPDATE point_readings_agg_5m SET point_id = 4 WHERE system_id = 6 AND point_id = 22;
UPDATE point_readings_agg_5m SET point_id = 5 WHERE system_id = 6 AND point_id = 23;
UPDATE point_readings_agg_5m SET point_id = 6 WHERE system_id = 6 AND point_id = 24;

-- System 9: Points 10-15 → 1-6
UPDATE point_readings_agg_5m SET point_id = 1 WHERE system_id = 9 AND point_id = 10;
UPDATE point_readings_agg_5m SET point_id = 2 WHERE system_id = 9 AND point_id = 11;
UPDATE point_readings_agg_5m SET point_id = 3 WHERE system_id = 9 AND point_id = 12;
UPDATE point_readings_agg_5m SET point_id = 4 WHERE system_id = 9 AND point_id = 13;
UPDATE point_readings_agg_5m SET point_id = 5 WHERE system_id = 9 AND point_id = 14;
UPDATE point_readings_agg_5m SET point_id = 6 WHERE system_id = 9 AND point_id = 15;

COMMIT;

-- ============================================================================
-- Verification: Check row counts after migration
-- ============================================================================

SELECT '=== Verification: point_readings after migration ===' as step;

-- Count readings in old points (should now include migrated data)
SELECT
  'AFTER: Old points' as status,
  system_id,
  point_id,
  COUNT(*) as reading_count
FROM point_readings
WHERE (system_id IN (1,2,5,6) AND point_id <= 6)
   OR (system_id = 3 AND point_id <= 2)
   OR (system_id = 9 AND point_id <= 6)
GROUP BY system_id, point_id
ORDER BY system_id, point_id;

-- Verify duplicate points are now empty
SELECT
  'AFTER: Duplicate points (should be 0)' as status,
  system_id,
  point_id,
  COUNT(*) as reading_count
FROM point_readings
WHERE (system_id = 1 AND point_id BETWEEN 17 AND 22)
   OR (system_id = 2 AND point_id BETWEEN 17 AND 22)
   OR (system_id = 3 AND point_id BETWEEN 3 AND 4)
   OR (system_id = 5 AND point_id BETWEEN 14 AND 19)
   OR (system_id = 6 AND point_id BETWEEN 19 AND 24)
   OR (system_id = 9 AND point_id BETWEEN 10 AND 15)
GROUP BY system_id, point_id
ORDER BY system_id, point_id;

SELECT '=== Verification: point_readings_agg_5m after migration ===' as step;

-- Count 5m aggregates in old points (should now include migrated data)
SELECT
  'AFTER: Old points (5m agg)' as status,
  system_id,
  point_id,
  COUNT(*) as reading_count
FROM point_readings_agg_5m
WHERE (system_id IN (1,2,5,6) AND point_id <= 6)
   OR (system_id = 3 AND point_id <= 2)
   OR (system_id = 9 AND point_id <= 6)
GROUP BY system_id, point_id
ORDER BY system_id, point_id;

-- Verify duplicate points are now empty
SELECT
  'AFTER: Duplicate points (5m agg, should be 0)' as status,
  system_id,
  point_id,
  COUNT(*) as reading_count
FROM point_readings_agg_5m
WHERE (system_id = 1 AND point_id BETWEEN 17 AND 22)
   OR (system_id = 2 AND point_id BETWEEN 17 AND 22)
   OR (system_id = 3 AND point_id BETWEEN 3 AND 4)
   OR (system_id = 5 AND point_id BETWEEN 14 AND 19)
   OR (system_id = 6 AND point_id BETWEEN 19 AND 24)
   OR (system_id = 9 AND point_id BETWEEN 10 AND 15)
GROUP BY system_id, point_id
ORDER BY system_id, point_id;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0045_migrate_readings_to_old_points');
