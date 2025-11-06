# Point Migration Quick Reference

## ✅ What's Been Done

1. **Analyzed data**: 198K readings + 56K aggregated intervals need migration
2. **Created migration scripts**:
   - `/scripts/migrations/migrate-readings-to-points.ts` - Raw readings migration
   - `/scripts/migrations/migrate-agg5m-to-points.ts` - Aggregation migration
3. **Tested successfully** on dev.db copy:
   - Raw readings: 26.3 seconds (2.83M point_readings inserted)
   - Aggregations: 3.5 seconds (418K point_readings_agg_5m inserted)
   - All validations passed ✅

## 🚀 Ready to Run on Production

### Quick Commands (with logging)

All commands below automatically save full logs to the `log/` directory.

```bash
# 1. Backup production
./scripts/utils/backup-prod-db.sh
# Verify file is ≥ 6MB

# 2. Create Turso checkpoint (instant rollback)
turso db branch create liveone-tokyo pre-point-migration

# 3. Test on production backup (RECOMMENDED)
gunzip -c db-backups/liveone-tokyo-*.gz > /tmp/prod-test.db

# Test with logging
npm run migrate:points -- --database /tmp/prod-test.db \
  --log-file log/test-readings-migration.log

npm run migrate:agg5m -- --database /tmp/prod-test.db \
  --log-file log/test-agg-migration.log

# Validate with logging
npm run migrate:points -- --database /tmp/prod-test.db --validate-only \
  --log-file log/test-readings-validation.log

npm run migrate:agg5m -- --database /tmp/prod-test.db --validate-only \
  --log-file log/test-agg-validation.log

# 4. Run on production (with logging)
npm run migrate:points -- --production \
  --log-file log/prod-readings-migration.log  # Type 'YES' to confirm

npm run migrate:agg5m -- --production \
  --log-file log/prod-agg-migration.log  # Type 'YES' to confirm

# 5. Validate (with logging)
npm run migrate:points -- --production --validate-only \
  --log-file log/prod-readings-validation.log

npm run migrate:agg5m -- --production --validate-only \
  --log-file log/prod-agg-validation.log
```

**Log files** are saved in `log/` directory with timestamps on each line. See `log/README.md` for details.

### Rollback (if needed)

```bash
# Instant rollback via Turso branch
turso db restore liveone-tokyo --branch pre-point-migration
```

## 📊 Migration Stats

### Raw Readings Migration

| System    | Type        | Readings    | Points | Records Created |
| --------- | ----------- | ----------- | ------ | --------------- |
| 1         | Selectronic | 70,634      | 16     | 1,129,956       |
| 2         | Selectronic | 71,130      | 16     | 1,138,016       |
| 7         | Fronius     | 56,346      | 10     | 563,450         |
| **Total** |             | **198,110** |        | **2,831,422**   |

**Estimated time on production**: 1-2 minutes

### Aggregation Migration

| System    | Type        | Intervals  | Points | Records Created |
| --------- | ----------- | ---------- | ------ | --------------- |
| 1         | Selectronic | 14,887     | 11     | 166,221         |
| 2         | Selectronic | 14,973     | 11     | 167,156         |
| 3         | **Enphase** | 14,926     | 2      | 29,852          |
| 7         | Fronius     | 10,927     | 5      | 54,645          |
| **Total** |             | **55,713** |        | **417,874**     |

**Estimated time on production**: 10-20 seconds

## ⚠️ Important Notes

1. **Enphase system (3)** has NO raw readings - only aggregated data!
   - Skip readings migration for system 3
   - Only run aggregation migration

2. **Duplicate timestamps** in source data are handled correctly:
   - 15 duplicate timestamps found across 3 systems
   - Migration uses `ON CONFLICT DO NOTHING` to skip duplicates
   - Validation confirms all unique timestamps migrated

3. **Energy unit conversion** is correct:
   - readings table: kWh (e.g., 2163.517)
   - point_readings: Wh (e.g., 2163517.0)
   - Conversion: ×1000 ✓

4. **No downtime required**:
   - Migration runs alongside live data
   - Conflict detection prevents duplicates
   - Checkpoint system allows resume if interrupted

## 📝 Validation Checks

After migration, verify:

```bash
# Check row counts
sqlite3 prod.db "SELECT system_id, COUNT(*) FROM point_readings GROUP BY system_id"

# Check timestamp coverage
sqlite3 prod.db "
  SELECT
    system_id,
    datetime(MIN(measurement_time)/1000, 'unixepoch') as earliest,
    datetime(MAX(measurement_time)/1000, 'unixepoch') as latest
  FROM point_readings
  GROUP BY system_id"

# Check for missing data
npm run migrate:points -- --production --validate-only
npm run migrate:agg5m -- --production --validate-only
```

## 🎯 Success Criteria

- [ ] Production backup created and verified (≥ 6MB)
- [ ] Turso branch checkpoint created
- [ ] Tested on production backup copy
- [ ] Raw readings migration complete
- [ ] Aggregation migration complete
- [ ] Both validations pass
- [ ] No errors in migration logs
- [ ] Spot checks confirm data accuracy

---

**Full details**: See `POINT_MIGRATION.md`

**Migration scripts**:

- `scripts/migrations/migrate-readings-to-points.ts`
- `scripts/migrations/migrate-agg5m-to-points.ts`
