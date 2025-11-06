# Point Migration TODO

**Date**: 2025-11-06
**Status**: ✅ MIGRATION COMPLETE
**Database**: Production (liveone-tokyo)

## Pre-Migration Checklist

### 1. Backup & Safety

- [x] **Backup production database**

  ```bash
  ./scripts/utils/backup-prod-db.sh
  ```

  - [x] Verify backup file exists in `db-backups/`
  - [x] Verify backup size is ≥ 6MB
  - [x] Note backup filename: `liveone-tokyo-20251106-165259.db.gz`
  - [x] Backup timestamp: `2025-11-06 16:52:59`

- [x] **Create Turso checkpoint snapshot**

  ```bash
  turso db create liveone-tokyo-pre-migration --from-db liveone-tokyo --timestamp "2025-11-06T05:59:57+00:00"
  ```

  - [x] Snapshot created successfully
  - [x] Snapshot database: `liveone-tokyo-pre-migration`
  - [x] Checkpoint time: `2025-11-06 16:59:57 AEDT` (UTC: 2025-11-06T05:59:57Z)

### 2. Test on Production Backup

- [x] **Extract production backup for testing**

  ```bash
  gunzip -c db-backups/liveone-tokyo-20251106-165259.db.gz > /tmp/prod-test.db
  ```

  - [x] Extracted file size: 331MB

- [x] **Test raw readings migration**

  ```bash
  npm run migrate:points -- --database /tmp/prod-test.db 2>&1 | tee log/test-readings-migration.log
  ```

  - [x] Migration completed without errors
  - [x] Check log file: `log/test-readings-migration.log`
  - [x] Time taken: `25.6 seconds` (12.8s per system)
  - [x] Records inserted: `2,951,120 point_readings`

- [x] **Test aggregation migration**

  ```bash
  npm run migrate:agg5m -- --database /tmp/prod-test.db 2>&1 | tee log/test-agg-migration.log
  ```

  - [x] Migration completed without errors
  - [x] Check log file: `log/test-agg-migration.log`
  - [x] Time taken: `3.6 seconds` (1.8s sys1 + 1.3s sys2 + 0.5s sys3)
  - [x] Records inserted: `490,863 point_readings_agg_5m` (sys1: 245,509 | sys2: 207,944 | sys3: 37,410)

- [x] **Validate test migrations**

  ```bash
  npm run migrate:points -- --database /tmp/prod-test.db --validate-only 2>&1 | tee log/test-readings-validation.log
  npm run migrate:agg5m -- --database /tmp/prod-test.db --validate-only 2>&1 | tee log/test-agg-validation.log
  ```

  - [x] Readings validation passed (100% of readings data present in point_readings; extra records are from testing)
  - [x] Aggregation validation passed (all systems match perfectly)
  - [x] No data integrity issues found (verified: 0 readings missing from point_readings)

### 3. Pre-Production Verification

- [x] **Review migration plan**
  - [x] Read `POINT_MIGRATION.md` in full
  - [x] Understand rollback procedure
  - [x] Confirm expected data volumes match actual

- [x] **Check production database status**

  ```bash
  turso db shell liveone-tokyo "SELECT system_id, COUNT(*) FROM readings GROUP BY system_id"
  turso db shell liveone-tokyo "SELECT system_id, COUNT(*) FROM readings_agg_5m GROUP BY system_id"
  ```

  - [x] System 1 readings: `93,199` | agg_5m: `22,824`
  - [x] System 2 readings: `96,215` | agg_5m: `19,409`
  - [x] System 3 readings: `0` (Enphase) | agg_5m: `18,903`
  - [x] System 5 readings: `64,174` (Fronius) | agg_5m: `12,839`
  - [x] System 6: `0` data (Mondo - newly configured, 18 points)

- [x] **Verify point_info completeness**

  ```bash
  turso db shell liveone-tokyo "SELECT system_id, COUNT(*) FROM point_info GROUP BY system_id"
  ```

  - [x] System 1: 16 points (Selectronic)
  - [x] System 2: 16 points (Selectronic)
  - [x] System 3: 2 points (Enphase)
  - [x] System 5: 13 points (Fronius)
  - [x] System 6: 18 points (Mondo - no data yet)

## Production Migration

### 4. Execute Migration

**Maintenance window**: `None required` (zero downtime - online migration)

- [-] **Notify team** (not applicable - solo operator)
  - [-] Migration start time communicated
  - [-] Estimated duration: ~2-3 minutes

- [x] **Run raw readings migration**

  ```bash
  npm run migrate:points -- --production 2>&1 | tee log/prod-readings-migration.log
  ```

  - [x] Started at: `2025-11-06 ~17:30 AEDT`
  - [x] Typed 'YES' to confirm
  - [x] Migration running...
  - [x] System 1 completed: `1,494,528 point_readings inserted` (16 points × 93,408 readings)
  - [x] System 2 completed: `1,542,800 point_readings inserted` (16 points × 96,425 readings)
  - [x] System 5 completed: `836,992 point_readings inserted` (13 points × 64,384 readings)
  - [x] System 3: `0 readings` (Enphase - uses aggregates only)
  - [x] System 6: `Already complete` (Mondo - new system)
  - [x] Total records: `~3.9M point_readings`
  - [x] Completed at: `2025-11-06 ~20:20 AEDT`
  - [x] Duration: `~3 minutes` (with retries for System 5)
  - [x] No errors in log file (only expected warnings for missing fields with NULL values)

- [x] **Run aggregation migration**

  ```bash
  npm run migrate:agg5m -- --production 2>&1 | tee log/prod-agg-migration.log
  ```

  - [x] Started at: `2025-11-06 ~20:28 AEDT`
  - [x] Typed 'YES' to confirm
  - [x] Migration running...
  - [x] System 1 completed: `245,509 point aggregates inserted` (213.9s)
  - [x] System 2 completed: `207,944 point aggregates inserted` (177.3s)
  - [x] System 3 completed: `37,410 point aggregates inserted` (46.5s - Enphase, 2 points only)
  - [x] System 5 completed: `63,110 point aggregates inserted` (63.8s - Fronius)
  - [x] System 6: `Already complete` (9,778 new intervals)
  - [x] Total records: `553,973 point aggregates`
  - [x] Completed at: `2025-11-06 ~20:36 AEDT`
  - [x] Duration: `~8.4 minutes`
  - [x] No errors in log file

### 5. Validation

- [x] **Validate raw readings migration**

  ```bash
  npm run migrate:points -- --production --validate-only 2>&1 | tee log/prod-readings-validation.log
  ```

  - [x] System 1: Row counts match ✓ (93,408 readings → 93,409 point timestamps, 1 extra from testing)
  - [x] System 2: Row counts match ✓ (96,425 readings → 96,425 point timestamps)
  - [x] System 5: Row counts match ✓ (64,384 readings → 64,384 point timestamps)
  - [x] **Zero readings missing** from point_readings ✓
  - [x] All spot checks passed ✓

- [x] **Validate aggregation migration**

  ```bash
  npm run migrate:agg5m -- --production --validate-only 2>&1 | tee log/prod-agg-validation.log
  ```

  - [x] System 1: Interval counts match ✓ (22,877 intervals)
  - [x] System 2: Interval counts match ✓ (19,462 intervals)
  - [x] System 3: Interval counts match ✓ (18,950 intervals - Enphase)
  - [x] System 5: Interval counts match ✓ (12,892 intervals - Fronius)
  - [x] System 6: New data only ✓ (9,778 intervals)
  - [x] **All validations passed** ✓

- [x] **Manual spot checks**

  ```bash
  # Verified 0 missing readings
  # Checked last 24h data for gaps
  ```

  - [x] Values match between readings and point_readings (verified 0 missing)
  - [x] Timestamps align correctly (×1000 conversion working)
  - [x] Energy values converted correctly (×1000 for kWh→Wh)
  - [x] **No gaps found in last 24h** for any system ✓

### 6. Post-Migration Checks

- [x] **Check migration progress table**

  ```bash
  turso db shell liveone-tokyo "
    SELECT migration_name, system_id, rows_migrated,
           datetime(last_migrated_timestamp, 'unixepoch') as last_migrated
    FROM migration_progress
    ORDER BY migration_name, system_id"
  ```

  - [x] All systems have progress records ✓
  - [x] Row counts look reasonable ✓
  - [x] readings_to_points: Systems 1 (90,716), 2 (93,197), 5 (61,877)
  - [x] agg5m_to_points: All systems migrated successfully

- [x] **Verify data coverage**

  ```bash
  turso db shell liveone-tokyo "
    SELECT system_id,
           datetime(MIN(measurement_time)/1000, 'unixepoch') as earliest,
           datetime(MAX(measurement_time)/1000, 'unixepoch') as latest,
           COUNT(*) as total
    FROM point_readings
    GROUP BY system_id"
  ```

  - [x] System 1: Full historical coverage ✓
  - [x] System 2: Full historical coverage ✓
  - [x] System 5: Full historical coverage ✓
  - [x] **No gaps in last 24 hours** for any system ✓

- [x] **Check application functionality**
  - [x] Dashboard loads correctly ✓
  - [x] Historical data displays ✓
  - [x] Charts render properly ✓
  - [x] API endpoints responding ✓
  - [x] No errors in application logs ✓

## Rollback (if needed)

### If Migration Fails or Issues Found

- [ ] **Option 1: Restore from Turso branch** (recommended - instant)

  ```bash
  turso db restore liveone-tokyo --branch pre-point-migration
  ```

  - [ ] Restoration completed
  - [ ] Verify data is back to pre-migration state
  - [ ] Document reason for rollback: `_______________________`

- [ ] **Option 2: Restore from backup file** (slower)

  ```bash
  gunzip -c db-backups/liveone-tokyo-YYYYMMDD-HHMMSS.db.gz | \
    turso db shell liveone-tokyo
  ```

  - [ ] Restoration completed
  - [ ] Verify data restored
  - [ ] Document reason for rollback: `_______________________`

- [ ] **Option 3: Selective cleanup** (if partial migration)

  ```bash
  turso db shell liveone-tokyo
  > DELETE FROM point_readings WHERE created_at > [migration_start_timestamp];
  > DELETE FROM point_readings_agg_5m WHERE created_at > [migration_start_timestamp];
  > DELETE FROM migration_progress WHERE migration_name IN ('readings_to_points', 'agg5m_to_points');
  ```

  - [ ] Cleanup completed
  - [ ] Document reason: `_______________________`

## Post-Migration Tasks

- [ ] **Update documentation**
  - [ ] Mark migration as complete in `POINT_MIGRATION.md`
  - [ ] Update `SCHEMA.md` to reflect point system as primary
  - [ ] Document any issues encountered: `_______________________`

- [ ] **Monitor system**
  - [ ] Check for 24 hours after migration
  - [ ] Monitor database size growth
  - [ ] Watch for any query performance changes
  - [ ] Check error logs for issues

- [ ] **Archive migration logs**
  - [ ] All log files saved in `log/` directory
  - [ ] Backup log directory: `cp -r log/ log-backup-YYYYMMDD/`
  - [ ] Log archive location: `_______________________`

- [ ] **Plan deprecation of legacy tables**
  - [ ] Set cutoff date for dual writes
  - [ ] Plan eventual archival of `readings` table
  - [ ] Update vendor adapters to use point system only
  - [ ] Target deprecation date: `_______________________`

## Notes

### Migration Start

- Date: `2025-11-06`
- Time: `17:30 AEDT`
- Operator: `Simon`

### Migration Complete

- Date: `2025-11-06`
- Time: `20:36 AEDT`
- Total duration: `~11.6 minutes` (raw: ~3 min, agg: ~8.4 min)
- Total records migrated: `~3.9M point_readings + 554K point_aggregates = ~4.45M records`

### Issues Encountered

```
1. System 5 Vendor Type Detection:
   - Initial hardcoded logic incorrectly identified System 5 as "selectronic" instead of "fronius"
   - Fixed by querying vendor_type from systems table instead of hardcoded mapping
   - Required killing migration mid-run to prevent bad data

2. Hardcoded System IDs:
   - Both migration scripts had hardcoded system ID lists [1, 2, 7] or [1, 2, 3, 7]
   - System 5 (Fronius) was missing from the list
   - System 7 doesn't exist, causing "not found" errors
   - Fixed by querying systems table dynamically, excluding only 'craighack' vendor type

3. Warning Spam:
   - Missing point_info fields (faultCode, faultTimestamp, generatorStatus) caused 64K+ duplicate warnings
   - All these fields were NULL in data, so warnings were correct but spammy
   - Fixed by implementing "warn once per field" deduplication logic

4. HTTP 502 Error:
   - System 2 encountered HTTP 502 error on batch 23 during initial run
   - Checkpoint system worked perfectly - resumed from last successful batch
   - No data loss - migration completed successfully on retry
```

### Lessons Learned

```
✅ What Went Well:
1. Checkpoint/resume system was essential - saved hours when HTTP 502 occurred
2. Test migrations on production backup caught vendor type bug before production
3. Dynamic system queries make migrations resilient to schema changes
4. Warn-once deduplication keeps logs clean and actionable
5. Zero downtime - online migration completed while system remained operational
6. Comprehensive validation caught all issues early

🔧 What Could Be Improved:
1. Should query database for all dynamic values (systems, vendor types) from the start
2. Consider adding progress bars or ETA for long-running migrations
3. Could batch warnings into summary at end instead of inline
4. Migration scripts should validate system existence before starting
5. Consider adding dry-run mode that shows what would be migrated

📊 Performance Notes:
- Network latency (Melbourne ↔ Tokyo) significantly impacts migration speed
- ~200ms round trip per batch = ~20s per 1000-record batch
- Aggregation migration faster (fewer inserts per interval)
- Batching at 1000 records was optimal for balance of speed vs. checkpoint granularity
```

---

**Status Legend**:

- [ ] Not started
- [x] Completed
- [!] Issue/blocked
- [-] Skipped/not applicable
