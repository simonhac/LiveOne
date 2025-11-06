# Point System Migration Plan

## Executive Summary

Migrate historical data from the legacy `readings` and `readings_agg_5m` tables to the new point-based system (`point_readings` and `point_readings_agg_5m`). This migration will enable full transition to the flexible point-based architecture while preserving all historical data.

## Current State Analysis

### Data Volumes (dev.db as of 2025-11-06)

| Table                   | Rows    | Date Range               | Status              |
| ----------------------- | ------- | ------------------------ | ------------------- |
| `readings`              | 200,809 | 2025-01-22 to 2025-11-06 | **Needs migration** |
| `readings_agg_5m`       | 56,371  | 2025-01-22 to 2025-11-06 | **Needs migration** |
| `point_readings`        | 205,750 | 2025-10-23 to 2025-11-06 | Recent data only    |
| `point_readings_agg_5m` | 74,810  | 2025-10-23 to 2025-11-06 | Recent data only    |

### System-by-System Breakdown

#### System 3 (Enphase)

- **readings**: 0 rows ← **Enphase writes directly to aggregated tables!**
- **readings_agg_5m**: 15,055 intervals (Sept 1 - Nov 5)
  - Already in point_readings_agg_5m: 129 intervals (Nov 5 only)
  - **Need to migrate**: ~14,926 intervals × 2 points = ~29,852 records
- **Special handling**: No raw readings migration needed, only aggregation migration

#### System 1 (Selectronic - Daylesford)

- **readings**: 71,982 rows (Aug 30 - Nov 5)
  - Already in point_readings: 1,348 rows (Nov 4-5)
  - **Need to migrate**: 70,634 rows (Aug 30 - Nov 4)
- **readings_agg_5m**: 15,150 intervals (Aug 30 - Nov 5)
  - Already in point_readings_agg_5m: 4,216 intervals (Nov 4-5)
  - **Need to migrate**: ~10,934 intervals

#### System 2 (Selectronic - Craig Home)

- **readings**: 72,480 rows (Aug 30 - Nov 5)
  - Already in point_readings: 1,350 rows (Nov 4-5)
  - **Need to migrate**: 71,130 rows (Aug 30 - Nov 4)
- **readings_agg_5m**: 15,235 intervals (Aug 30 - Nov 5)
  - Already in point_readings_agg_5m: 4,200 intervals (Nov 4-5)
  - **Need to migrate**: ~11,035 intervals

#### System 7 (Fronius)

- **readings**: 56,347 rows (Jan 22 - Nov 6) ← **LONGEST HISTORY**
  - Already in point_readings: 1 row (Nov 6)
  - **Need to migrate**: 56,346 rows (Jan 22 - Nov 5)
- **readings_agg_5m**: 10,931 intervals (Jan 22 - Nov 6)
  - Already in point_readings_agg_5m: 59 intervals (Nov 5-6)
  - **Need to migrate**: ~10,872 intervals

### Total Migration Volume

- **Raw readings**: ~198,110 rows × 10-16 points = **~3.17M point_readings rows**
  - Systems 1, 2: 16 points each (Selectronic)
  - System 7: 10 points (Fronius - skips energy totals)
- **5-min aggregates**: ~55,713 intervals × 2-11 points = **~526K point_readings_agg_5m rows**
  - Systems 1, 2: 11 points each (power metrics + SOC + energy totals)
  - System 3: 2 points (Enphase - solar power + interval energy only)
  - System 7: 5 points (Fronius - power metrics + SOC only)

## Data Mapping

### Readings Table → Point Readings

Each row in `readings` maps to 16 rows in `point_readings` (one per point).

#### Selectronic Systems (1, 2)

| readings column         | origin_sub_id          | Data Transformation       |
| ----------------------- | ---------------------- | ------------------------- |
| `solar_w`               | `solar_w`              | Direct copy               |
| `solar_inverter_w`      | `solarinverter_w`      | Direct copy               |
| `shunt_w`               | `shunt_w`              | Direct copy               |
| `load_w`                | `load_w`               | Direct copy               |
| `battery_w`             | `battery_w`            | Direct copy               |
| `grid_w`                | `grid_w`               | Direct copy               |
| `battery_soc`           | `battery_soc`          | Direct copy               |
| `fault_code`            | `fault_code`           | → `valueStr` (text field) |
| `fault_timestamp`       | `fault_ts`             | Direct copy (already ms)  |
| `generator_status`      | `gen_status`           | Direct copy               |
| `solar_kwh_total`       | `solar_wh_total`       | **× 1000** (kWh → Wh)     |
| `load_kwh_total`        | `load_wh_total`        | **× 1000**                |
| `battery_in_kwh_total`  | `battery_in_wh_total`  | **× 1000**                |
| `battery_out_kwh_total` | `battery_out_wh_total` | **× 1000**                |
| `grid_in_kwh_total`     | `grid_in_wh_total`     | **× 1000**                |
| `grid_out_kwh_total`    | `grid_out_wh_total`    | **× 1000**                |

**Timestamp conversion**: `readings.inverter_time` (seconds) → `point_readings.measurement_time` (milliseconds) **× 1000**

#### Fronius System (7)

| readings column    | origin_sub_id     | Notes        |
| ------------------ | ----------------- | ------------ |
| `solar_w`          | `solarW`          | CamelCase!   |
| `solar_inverter_w` | `solarRemoteW`    | CamelCase!   |
| `shunt_w`          | `solarLocalW`     | CamelCase!   |
| `load_w`           | `loadW`           | CamelCase!   |
| `battery_w`        | `batteryW`        | CamelCase!   |
| `grid_w`           | `gridW`           | CamelCase!   |
| `battery_soc`      | `batterySOC`      | CamelCase!   |
| `fault_code`       | `faultCode`       | → `valueStr` |
| `fault_timestamp`  | `faultTimestamp`  | CamelCase!   |
| `generator_status` | `generatorStatus` | CamelCase!   |

**Fronius energy fields**: The readings table has lifetime kWh totals, but Fronius point system expects interval energy. We'll skip energy migration for Fronius or convert to interval deltas.

### Readings_agg_5m → Point_readings_agg_5m

Each 5-minute interval aggregates 16 separate points.

| readings_agg_5m column | Point mapping        | Aggregation       |
| ---------------------- | -------------------- | ----------------- |
| `solar_w_avg`          | solar_w point        | → `avg`           |
| `solar_w_min`          | solar_w point        | → `min`           |
| `solar_w_max`          | solar_w point        | → `max`           |
| `battery_soc_last`     | battery_soc point    | → `last`          |
| `solar_kwh_total_last` | solar_wh_total point | → `last` (× 1000) |

## Migration Strategy

### Phase 1: Preparation & Validation

1. **Backup production database**

   ```bash
   ./scripts/utils/backup-prod-db.sh
   # Verify: ls -lh db-backups/*.gz | tail -1
   # Must be ≥ 6MB
   ```

2. **Create Turso branch checkpoint**

   ```bash
   turso db branch create liveone-tokyo pre-point-migration
   # Branch captures current state for instant rollback
   ```

3. **Extract backup for local testing**

   ```bash
   gunzip -c db-backups/liveone-tokyo-YYYYMMDD-HHMMSS.db.gz > /tmp/test-migration.db
   ```

4. **Verify point_info completeness**
   - Ensure all 16 points exist for systems 1, 2, 7
   - Check origin_sub_id matches expected values
   - Validate composite primary keys (system_id, id)

5. **Add missing indexes** (if any)
   - `readings`: (system_id, inverter_time) ← already exists
   - `point_readings`: (system_id, point_id, measurement_time) ← already exists
   - `readings_agg_5m`: (system_id, interval_end) ← already exists
   - `point_readings_agg_5m`: (system_id, point_id, interval_end) ← already exists (PK)

### Phase 2: Migration Script Design

#### Key Requirements

1. **Idempotent**: Safe to run multiple times (skip existing data)
2. **Resumable**: Can stop and restart without data loss
3. **Batched**: Process in chunks to avoid memory issues
4. **Validated**: Row count verification after each batch
5. **Checkpointed**: Progress tracking in migration_progress table

#### Batch Size Analysis

**Test on local backup**:

- Start with 1,000 readings per batch (= 16,000 point_readings inserts)
- Measure time per batch
- Target: < 5 seconds per batch
- If slower, reduce to 500 or 100 readings per batch

#### Pseudo-code Structure

```sql
-- Track migration progress
CREATE TABLE IF NOT EXISTS migration_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_name TEXT NOT NULL,
  system_id INTEGER NOT NULL,
  last_migrated_timestamp INTEGER NOT NULL,
  rows_migrated INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(migration_name, system_id)
);

-- Migration logic (TypeScript/SQL hybrid)
FOR each system_id IN (1, 2, 7):

  -- Get last checkpoint
  last_timestamp = SELECT last_migrated_timestamp
                   FROM migration_progress
                   WHERE migration_name = 'readings_to_points'
                   AND system_id = system_id

  -- Get batch of unmigrated readings
  WHILE true:
    readings = SELECT * FROM readings
               WHERE system_id = system_id
               AND inverter_time > last_timestamp
               AND NOT EXISTS (
                 SELECT 1 FROM point_readings pr
                 WHERE pr.system_id = readings.system_id
                 AND pr.measurement_time = readings.inverter_time * 1000
                 AND pr.point_id = 1  -- Check any point
               )
               ORDER BY inverter_time ASC
               LIMIT 1000

    IF readings is empty:
      BREAK

    BEGIN TRANSACTION

    -- Insert point_readings for all 16 points
    FOR each reading IN readings:
      FOR each point IN point_info WHERE system_id = reading.system_id:
        INSERT INTO point_readings (
          system_id, point_id,
          measurement_time, received_time,
          value, value_str, data_quality
        ) VALUES (
          reading.system_id,
          point.id,
          reading.inverter_time * 1000,  -- Convert to ms
          reading.received_time * 1000,
          get_value_for_point(reading, point),  -- Lookup function
          get_value_str_for_point(reading, point),
          'good'
        )
        ON CONFLICT (system_id, point_id, measurement_time) DO NOTHING

    -- Validate batch
    expected_rows = COUNT(readings) * 16
    actual_rows = COUNT newly inserted rows

    IF actual_rows != expected_rows AND not all conflicts:
      ROLLBACK
      RAISE ERROR "Batch validation failed"

    -- Update checkpoint
    UPSERT INTO migration_progress (
      migration_name, system_id,
      last_migrated_timestamp, rows_migrated
    ) VALUES (
      'readings_to_points',
      system_id,
      MAX(reading.inverter_time),
      rows_migrated + COUNT(readings)
    )

    COMMIT

    -- Progress log
    PRINT "System {system_id}: Migrated {COUNT(readings)} readings ({actual_rows} point_readings)"
```

#### Value Extraction Logic

```typescript
function getValueForPoint(reading: Reading, point: PointInfo): number | null {
  const { originSubId } = point;

  // Power metrics (W) - direct copy
  if (originSubId === "solar_w" || originSubId === "solarW")
    return reading.solar_w;
  if (originSubId === "load_w" || originSubId === "loadW")
    return reading.load_w;
  // ... etc for all power fields

  // Energy metrics (kWh → Wh conversion)
  if (originSubId === "solar_wh_total")
    return reading.solar_kwh_total ? reading.solar_kwh_total * 1000 : null;
  // ... etc for all energy fields

  // SOC (direct copy)
  if (originSubId === "battery_soc" || originSubId === "batterySOC")
    return reading.battery_soc;

  // Timestamps (already in ms for fault_timestamp)
  if (originSubId === "fault_ts" || originSubId === "faultTimestamp")
    return reading.fault_timestamp;

  // Boolean/numeric status
  if (originSubId === "gen_status" || originSubId === "generatorStatus")
    return reading.generator_status;

  // Text fields (fault_code) → use valueStr instead
  if (originSubId === "fault_code" || originSubId === "faultCode") return null; // Use valueStr

  return null;
}

function getValueStrForPoint(
  reading: Reading,
  point: PointInfo,
): string | null {
  const { originSubId } = point;

  // Only fault codes use valueStr
  if (originSubId === "fault_code" || originSubId === "faultCode")
    return reading.fault_code?.toString() || null;

  return null;
}
```

### Phase 3: Aggregation Migration

**Important**: Enphase systems (system 3) have **no** raw readings - only aggregated data!

Migration script: `/scripts/migrations/migrate-agg5m-to-points.ts`

Similar approach for `readings_agg_5m` → `point_readings_agg_5m`:

```sql
-- For each 5-minute interval
FOR each interval IN readings_agg_5m:
  FOR each point IN point_info WHERE system_id = interval.system_id:
    INSERT INTO point_readings_agg_5m (
      system_id, point_id, interval_end,
      avg, min, max, last,
      sample_count, error_count
    ) VALUES (
      interval.system_id,
      point.id,
      interval.interval_end * 1000,  -- Convert to ms
      get_avg_for_point(interval, point),
      get_min_for_point(interval, point),
      get_max_for_point(interval, point),
      get_last_for_point(interval, point),
      interval.sample_count,
      0  -- No error tracking in old system
    )
    ON CONFLICT (system_id, point_id, interval_end) DO NOTHING
```

**Aggregation value extraction**:

- Power metrics: Use avg/min/max columns
- SOC: Use last column
- Energy totals: Use last column (with kWh → Wh conversion)
- Diagnostic fields: Skip (no aggregation meaningful)

### Phase 4: Validation & Verification

#### Post-Migration Checks

1. **Row count validation**

   ```sql
   -- Expected: readings × 16 points (minus already migrated)
   SELECT
     r_count * 16 as expected,
     (SELECT COUNT(*) FROM point_readings WHERE system_id = X) as actual
   FROM (
     SELECT COUNT(*) as r_count FROM readings WHERE system_id = X
   );
   ```

2. **Timestamp coverage**

   ```sql
   -- Check for gaps in migrated data
   SELECT
     datetime(MIN(measurement_time)/1000, 'unixepoch') as earliest_point,
     datetime(MIN(inverter_time), 'unixepoch') as earliest_reading,
     datetime(MAX(measurement_time)/1000, 'unixepoch') as latest_point,
     datetime(MAX(inverter_time), 'unixepoch') as latest_reading
   FROM point_readings pr, readings r
   WHERE pr.system_id = r.system_id AND r.system_id = X;
   ```

3. **Data integrity spot checks**

   ```sql
   -- Verify a few random readings match their point_readings
   SELECT
     r.inverter_time,
     r.solar_w as reading_solar,
     pr.value as point_solar
   FROM readings r
   JOIN point_readings pr ON
     pr.system_id = r.system_id AND
     pr.measurement_time = r.inverter_time * 1000 AND
     pr.point_id = (SELECT id FROM point_info
                    WHERE system_id = r.system_id
                    AND origin_sub_id = 'solar_w' LIMIT 1)
   WHERE r.system_id = 1
   ORDER BY RANDOM()
   LIMIT 10;
   ```

4. **Aggregation verification**
   ```sql
   -- Compare aggregated values
   SELECT
     agg.interval_end,
     agg.solar_w_avg as reading_avg,
     pr_agg.avg as point_avg
   FROM readings_agg_5m agg
   JOIN point_readings_agg_5m pr_agg ON
     pr_agg.system_id = agg.system_id AND
     pr_agg.interval_end = agg.interval_end * 1000 AND
     pr_agg.point_id = (SELECT id FROM point_info
                        WHERE system_id = agg.system_id
                        AND origin_sub_id = 'solar_w' LIMIT 1)
   WHERE agg.system_id = 1
   ORDER BY RANDOM()
   LIMIT 10;
   ```

### Phase 5: Production Execution

#### Pre-flight Checklist

- [ ] Production backup created (≥ 6MB)
- [ ] Turso branch checkpoint created
- [ ] Migration script tested on backup copy
- [ ] Performance benchmarked (time per batch documented)
- [ ] Validation queries prepared
- [ ] Rollback procedure documented

#### Execution Steps

1. **Announce maintenance window** (if needed)
   - Estimated time: 5-30 minutes depending on batch performance
   - No downtime required (migration runs alongside live data)

2. **Run migration on production**

   ```bash
   # Option A: Via Turso shell
   turso db shell liveone-tokyo < scripts/migrations/migrate-to-points.sql

   # Option B: Via migration script
   npx tsx scripts/migrations/migrate-readings-to-points.ts --production
   ```

3. **Monitor progress**
   - Watch for checkpoint updates in migration_progress table
   - Check error logs
   - Monitor database performance (IOPS, latency)

4. **Run validation queries**
   - Check row counts
   - Verify timestamp ranges
   - Spot-check data integrity

5. **Update migration documentation**
   - Record actual migration time
   - Note any issues encountered
   - Update this document with lessons learned

#### Rollback Procedure

If migration fails or data integrity issues found:

```bash
# Option 1: Restore from Turso branch (fastest)
turso db restore liveone-tokyo --branch pre-point-migration

# Option 2: Restore from backup (slower)
turso db shell liveone-tokyo < backup-file.sql

# Option 3: Selective cleanup (if partial migration)
DELETE FROM point_readings WHERE created_at > [migration_start_time];
DELETE FROM point_readings_agg_5m WHERE created_at > [migration_start_time];
DELETE FROM migration_progress WHERE migration_name = 'readings_to_points';
```

## Performance Optimization

### Index Strategy

**Existing indexes** (sufficient for migration):

- `readings`: (system_id, inverter_time) UNIQUE
- `point_readings`: (system_id, point_id, measurement_time) UNIQUE
- `readings_agg_5m`: (system_id, interval_end) UNIQUE
- `point_readings_agg_5m`: (system_id, point_id, interval_end) PK

**No additional indexes needed** - conflict detection uses primary/unique indexes.

### Write Optimization

1. **Batch inserts**: Use multi-row INSERT statements

   ```sql
   INSERT INTO point_readings (system_id, point_id, ...) VALUES
     (1, 1, ...), (1, 2, ...), (1, 3, ...), ...;
   ```

2. **Transaction batching**: Commit every 1,000 readings (16,000 inserts)
   - Balances performance with atomicity
   - Allows resume from checkpoint

3. **Disable foreign key checks during migration** (optional, if slow)

   ```sql
   PRAGMA foreign_keys = OFF;
   -- Run migration
   PRAGMA foreign_keys = ON;
   -- Validate integrity
   PRAGMA foreign_key_check;
   ```

4. **Turso-specific optimizations**
   - Use batch API if available
   - Consider running during low-traffic hours
   - Monitor replica lag

### Estimated Timeline

**ACTUAL TEST RESULTS (tested on dev.db copy):**

- **System 1**: 70,634 readings → 1,129,956 point_readings in **9.8s** (~7,200 readings/sec, ~115,000 inserts/sec)
- **System 2**: 71,130 readings → 1,138,016 point_readings in **10.1s** (~7,043 readings/sec, ~112,673 inserts/sec)
- **System 7**: 56,346 readings → 563,450 point_readings in **5.4s** (~10,434 readings/sec, ~104,342 inserts/sec)
- **Total**: 198,110 readings → 2,831,422 point_readings in **26.3 seconds**

**Local SQLite performance**: Excellent (~115,000 inserts/sec for Selectronic, ~104,000 for Fronius)

**Aggregation migration test results:**

- **System 1**: 14,887 intervals → 166,221 point aggregates in **1.1s** (~13,534 intervals/sec)
- **System 2**: 14,973 intervals → 167,156 point aggregates in **1.0s** (~14,973 intervals/sec)
- **System 3 (Enphase)**: 14,926 intervals → 29,852 point aggregates in **0.4s** (~37,315 intervals/sec)
- **System 7 (Fronius)**: 10,927 intervals → 54,645 point aggregates in **0.4s** (~27,318 intervals/sec)
- **Total**: 55,713 intervals → 417,874 point aggregates in **3.5 seconds**

**Production estimate (Turso with network latency)**:

- Expect 2-5x slower due to network round trips
- Estimated production time: **1-2 minutes** for raw readings
- Aggregation migration: Additional **10-20 seconds** (very fast!)
- **Total production estimate: 2-3 minutes** for complete migration

## Risk Mitigation

### Potential Issues

1. **Duplicate data conflicts**
   - Mitigation: Use `ON CONFLICT DO NOTHING` clause
   - Detection: Compare expected vs actual insert counts

2. **Insufficient disk space**
   - Mitigation: Monitor Turso storage limits
   - Point system uses ~3x more rows (but smaller per-row)

3. **Migration interruption**
   - Mitigation: Checkpoint every batch
   - Recovery: Resume from last checkpoint

4. **Data type mismatches**
   - Mitigation: Pre-validate all mappings in test run
   - kWh → Wh conversion must be exact (× 1000)

5. **Performance degradation during migration**
   - Mitigation: Run during low-traffic hours
   - Monitor IOPS and adjust batch size

### Data Integrity Safeguards

1. **Pre-migration validation**
   - Verify all point_info entries exist
   - Check for orphaned readings (no matching system)

2. **Per-batch validation**
   - Row count: `inserted_rows == batch_size * 16` (minus conflicts)
   - No NULL values where not expected
   - Timestamp monotonicity

3. **Post-migration validation**
   - Total row counts match expectations
   - No missing timestamps in ranges
   - Spot-check value accuracy

4. **Checkpoint/branch safety**
   - Turso branch = instant rollback capability
   - Backup file = complete restoration option

## Post-Migration Tasks

1. **Update application code**
   - Ensure all queries can read from point_readings
   - Update dashboards to use new schema
   - Verify aggregation queries work correctly

2. **Deprecation planning**
   - Set cutoff date for readings table writes
   - Plan eventual archival/deletion of legacy tables
   - Update documentation

3. **Monitoring**
   - Verify cron jobs continue writing to both tables (during transition)
   - Monitor point_readings growth rate
   - Check for any regressions in query performance

4. **Documentation updates**
   - Update SCHEMA.md with migration completion date
   - Note any legacy code still using readings table
   - Document point system as primary data source

## Success Criteria

- [ ] All historical readings migrated to point_readings
- [ ] All 5-minute aggregates migrated to point_readings_agg_5m
- [ ] Row counts match expectations (within margin for conflicts)
- [ ] Data integrity spot checks pass 100%
- [ ] No data loss (backup verified)
- [ ] Migration completed in < 30 minutes
- [ ] No service interruption
- [ ] Application queries work with new schema
- [ ] Documentation updated

## Appendix: SQL Helpers

### Get point mapping for a system

```sql
SELECT
  id as point_id,
  origin_sub_id,
  display_name,
  metric_type,
  metric_unit
FROM point_info
WHERE system_id = 1
ORDER BY id;
```

### Check migration progress

```sql
SELECT
  system_id,
  datetime(last_migrated_timestamp, 'unixepoch') as last_migrated,
  rows_migrated,
  datetime(updated_at, 'unixepoch') as updated
FROM migration_progress
WHERE migration_name = 'readings_to_points'
ORDER BY system_id;
```

### Find unmigrated readings

```sql
SELECT
  COUNT(*) as unmigrated_count,
  MIN(inverter_time) as earliest,
  MAX(inverter_time) as latest
FROM readings
WHERE system_id = 1
AND NOT EXISTS (
  SELECT 1 FROM point_readings pr
  WHERE pr.system_id = readings.system_id
  AND pr.measurement_time = readings.inverter_time * 1000
  AND pr.point_id = 1
);
```

### Performance test query

```sql
-- Test batch insert speed
.timer on
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  r.system_id,
  pi.id as point_id,
  r.inverter_time * 1000,
  r.received_time * 1000,
  CASE pi.origin_sub_id
    WHEN 'solar_w' THEN r.solar_w
    WHEN 'load_w' THEN r.load_w
    -- ... etc
  END as value,
  'good'
FROM readings r
CROSS JOIN point_info pi ON pi.system_id = r.system_id
WHERE r.system_id = 1
AND r.inverter_time BETWEEN 1725000000 AND 1725001000  -- 1000 second window
LIMIT 16000;  -- 1000 readings × 16 points
.timer off
```

---

**Document Version**: 1.1
**Created**: 2025-11-06
**Last Updated**: 2025-11-06
**Author**: Claude Code
**Status**: Tested on dev.db - Ready for production backup testing

## Test Results Summary

✅ **Successfully tested on dev.db copy (2025-11-06)**

### Raw Readings Migration

- Migration script: `/scripts/migrations/migrate-readings-to-points.ts`
- Command: `npm run migrate:points`
- Test database: 81MB SQLite file
- Total migrated: 198,110 readings → 2,831,422 point_readings
- Migration time: 26.3 seconds
- Performance: ~7,500 readings/sec average
- Validation: All 30 spot checks passed (10 per system)
- Checkpoint system: Working correctly (resumable)
- Duplicate handling: Correctly skipped 15 duplicate timestamps across 3 systems

### Aggregation Migration

- Migration script: `/scripts/migrations/migrate-agg5m-to-points.ts`
- Command: `npm run migrate:agg5m`
- Total migrated: 55,713 intervals → 417,874 point_readings_agg_5m
- Migration time: **3.5 seconds** ⚡
- Performance: ~15,900 intervals/sec average (~119,393 inserts/sec)
- Enphase system (3): ✅ All 14,926 aggregated intervals migrated (no raw readings)
- Validation: All readings_agg_5m intervals present in point aggregates

**All systems validated successfully** ✅

### Systems Summary

| System | Type        | Raw Readings | Aggregated Intervals | Notes                |
| ------ | ----------- | ------------ | -------------------- | -------------------- |
| 1      | Selectronic | 71,982       | 15,150               | Both migrations      |
| 2      | Selectronic | 72,480       | 15,235               | Both migrations      |
| 3      | Enphase     | 0            | 15,055               | **Aggregation only** |
| 7      | Fronius     | 56,347       | 10,931               | Both migrations      |

---

## ✅ PRODUCTION MIGRATION COMPLETE

**Date**: 2025-11-06
**Status**: Successfully completed
**Database**: liveone-tokyo (production)

### Production Results

#### Raw Readings Migration

- **Total migrated**: ~3.9M point_readings
  - System 1: 93,408 readings → 1,494,528 point_readings (16 points)
  - System 2: 96,425 readings → 1,542,800 point_readings (16 points)
  - System 5: 64,384 readings → 836,992 point_readings (13 points)
  - System 3: 0 (Enphase - aggregates only)
  - System 6: Already complete (Mondo - new system)
- **Migration time**: ~3 minutes
- **Validation**: ✅ Zero readings missing

#### Aggregation Migration

- **Total migrated**: 553,973 point_aggregates
  - System 1: 22,877 intervals → 245,509 aggregates (213.9s)
  - System 2: 19,462 intervals → 207,944 aggregates (177.3s)
  - System 3: 18,950 intervals → 37,410 aggregates (46.5s - Enphase)
  - System 5: 12,892 intervals → 63,110 aggregates (63.8s - Fronius)
  - System 6: 9,778 intervals (new data)
- **Migration time**: ~8.4 minutes
- **Validation**: ✅ All systems validated successfully
- **Data quality**: ✅ No gaps in last 24 hours

### Key Improvements Made

1. **Dynamic system queries** - No longer hardcoded system IDs
2. **Database-driven vendor types** - Queries `systems` table instead of hardcoded logic
3. **Warn-once deduplication** - Prevents log spam from missing fields
4. **Checkpoint/resume system** - Survived HTTP 502 error with zero data loss

### Next Steps

- Monitor system for 24 hours
- Plan deprecation of legacy `readings` and `readings_agg_5m` tables
- Update vendor adapters to use point system exclusively
- Archive migration logs

**Full migration details**: See `/log/TODO.md`
