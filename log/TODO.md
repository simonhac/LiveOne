# Point Migration TODO

**Date**: 2025-11-06
**Status**: Pre-migration
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

- [ ] **Review migration plan**
  - [ ] Read `POINT_MIGRATION.md` in full
  - [ ] Understand rollback procedure
  - [ ] Confirm expected data volumes match actual

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

**Maintenance window**: `_________` to `_________` (optional - no downtime required)

- [ ] **Notify team** (if applicable)
  - [ ] Migration start time communicated
  - [ ] Estimated duration: ~2-3 minutes

- [ ] **Run raw readings migration**

  ```bash
  npm run migrate:points -- --production 2>&1 | tee log/prod-readings-migration.log
  ```

  - [ ] Started at: `_________`
  - [ ] Typed 'YES' to confirm
  - [ ] Migration running...
  - [ ] System 1 completed: `_________ point_readings inserted`
  - [ ] System 2 completed: `_________ point_readings inserted`
  - [ ] System 7 completed: `_________ point_readings inserted`
  - [ ] Total records: `_________`
  - [ ] Completed at: `_________`
  - [ ] Duration: `_________ minutes`
  - [ ] No errors in log file

- [ ] **Run aggregation migration**
  ```bash
  npm run migrate:agg5m -- --production 2>&1 | tee log/prod-agg-migration.log
  ```

  - [ ] Started at: `_________`
  - [ ] Typed 'YES' to confirm
  - [ ] Migration running...
  - [ ] System 1 completed: `_________ point aggregates inserted`
  - [ ] System 2 completed: `_________ point aggregates inserted`
  - [ ] System 3 completed: `_________ point aggregates inserted` (Enphase)
  - [ ] System 7 completed: `_________ point aggregates inserted`
  - [ ] Total records: `_________`
  - [ ] Completed at: `_________`
  - [ ] Duration: `_________ seconds`
  - [ ] No errors in log file

### 5. Validation

- [ ] **Validate raw readings migration**

  ```bash
  npm run migrate:points -- --production --validate-only 2>&1 | tee log/prod-readings-validation.log
  ```

  - [ ] System 1: Row counts match ✓
  - [ ] System 2: Row counts match ✓
  - [ ] System 7: Row counts match ✓
  - [ ] All spot checks passed ✓

- [ ] **Validate aggregation migration**

  ```bash
  npm run migrate:agg5m -- --production --validate-only 2>&1 | tee log/prod-agg-validation.log
  ```

  - [ ] System 1: Interval counts match ✓
  - [ ] System 2: Interval counts match ✓
  - [ ] System 3: Interval counts match ✓ (Enphase)
  - [ ] System 7: Interval counts match ✓

- [ ] **Manual spot checks**
  ```bash
  # Check a few random records
  turso db shell liveone-tokyo "
    SELECT r.inverter_time, r.solar_w, pr.value
    FROM readings r
    JOIN point_readings pr ON pr.measurement_time = r.inverter_time * 1000
    WHERE r.system_id = 1 AND pr.point_id = 1
    ORDER BY RANDOM() LIMIT 5"
  ```

  - [ ] Values match between readings and point_readings
  - [ ] Timestamps align correctly (×1000 conversion)
  - [ ] Energy values converted correctly (×1000 for kWh→Wh)

### 6. Post-Migration Checks

- [ ] **Check migration progress table**

  ```bash
  turso db shell liveone-tokyo "
    SELECT migration_name, system_id, rows_migrated,
           datetime(last_migrated_timestamp, 'unixepoch') as last_migrated
    FROM migration_progress
    ORDER BY migration_name, system_id"
  ```

  - [ ] All systems have progress records
  - [ ] Row counts look reasonable

- [ ] **Verify data coverage**

  ```bash
  turso db shell liveone-tokyo "
    SELECT system_id,
           datetime(MIN(measurement_time)/1000, 'unixepoch') as earliest,
           datetime(MAX(measurement_time)/1000, 'unixepoch') as latest,
           COUNT(*) as total
    FROM point_readings
    GROUP BY system_id"
  ```

  - [ ] System 1 date range: `_________` to `_________`
  - [ ] System 2 date range: `_________` to `_________`
  - [ ] System 7 date range: `_________` to `_________`

- [ ] **Check application functionality**
  - [ ] Dashboard loads correctly
  - [ ] Historical data displays
  - [ ] Charts render properly
  - [ ] API endpoints responding
  - [ ] No errors in application logs

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

- Date: `_________`
- Time: `_________`
- Operator: `_________`

### Migration Complete

- Date: `_________`
- Time: `_________`
- Total duration: `_________`
- Total records migrated: `_________`

### Issues Encountered

```
[Document any issues, errors, or unexpected behaviors here]



```

### Lessons Learned

```
[Document what went well and what could be improved]



```

---

**Status Legend**:

- [ ] Not started
- [x] Completed
- [!] Issue/blocked
- [-] Skipped/not applicable
