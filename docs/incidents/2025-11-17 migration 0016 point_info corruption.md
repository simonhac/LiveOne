# Incident Report: Point Info Metadata Corruption (2025-11-17)

## Executive Summary

Migration 0036, intended to update Amber Electric point metadata, contained a WHERE clause bug that corrupted point_info metadata for 6 systems (1, 2, 3, 5, 6, 9) affecting 32 monitoring points. The bug caused point IDs to match across ALL systems instead of just Amber systems, resulting in ~1.5 days of data (Nov 16 06:06 - Nov 17 ~16:00) being written to duplicate points. All data was successfully recovered through metadata restoration and data migration.

**Impact**: Metadata corruption across 32 points on 6 systems; ~42,000 readings temporarily orphaned
**Root Cause**: SQL WHERE clause using non-unique column in subquery
**Resolution Time**: ~4 hours (investigation + recovery)
**Data Loss**: None (all data recovered)

---

## Timeline

### Corruption Phase

**2025-11-16 06:38 PM** (estimated)

- Migration 0036 executes with buggy WHERE clause
- Point metadata corrupted for systems 1, 2, 3, 5, 6, 9
- Old points (1-6) now have incorrect Amber-style labels

**2025-11-16 06:06 PM - 2025-11-17 09:56 AM**

- monitoring-points-manager cannot find points with correct metadata
- Automatically creates duplicate points with correct metadata:
  - System 1: Points 17-22 created at **2025-11-16 06:06:50**
  - System 2: Points 17-22 created at **2025-11-16 06:06:52**
  - System 3: Points 3-4 created at **2025-11-16 06:56:59**
  - System 5: Points 14-19 created at **2025-11-16 06:07:00**
  - System 6: Points 19-24 created at **2025-11-16 06:06:57**
  - System 9: Points 10-15 created at **2025-11-17 09:56:56**
- ~42,000 readings written to new duplicate points instead of old points

### Discovery Phase

**2025-11-17 ~15:30**

- User discovers point metadata doesn't match data paths
- System 1 point labels show "Grid import/export" but paths show "battery", "load", etc.

**2025-11-17 15:30 - 17:00**

- Investigation of Turso snapshot liveone-snapshot-20251116-100416 (pre-corruption)
- Comparison reveals metadata corruption timeline
- Root cause identified: Migration 0036 WHERE clause bug
- Scope expanded: 6 systems affected, not just 1

### Recovery Phase

**2025-11-17 17:00 - 19:45**

- Created Turso snapshot: liveone-snapshot-recovery-20251117-194532
- Disabled Vercel cron jobs to prevent more duplicate points
- Created migration 0044 to restore point_info metadata
- Applied migration 0044 successfully
- Re-enabled cron jobs, verified new data flows to old points

**2025-11-17 19:45 - 20:30**

- Created second snapshot: liveone-snapshot-20251117-201245
- Counted baseline readings (before migration)
- Created migration 0045 to migrate readings from duplicates to old points
- Handled UNIQUE constraint conflicts with backup table strategy
- Applied migration 0045 successfully, migrated ~42,000 readings

**2025-11-17 20:30+**

- Triggered production redeploy to clear cached point_info
- Pending: Delete orphaned duplicate points after server restart

---

## Root Cause Analysis

### The Bug

Migration 0036 used this WHERE clause pattern:

```sql
UPDATE point_info
SET origin_sub_id = 'import_kwh',
    point_name = 'Grid import',
    display_name = 'Grid import'
WHERE id IN (
  SELECT pi.id                    -- BUG: Returns just 'id'
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    -- ... other conditions
);
```

**Problem**: The subquery returns `pi.id` which is NOT unique across systems because `point_info` has a composite primary key `(system_id, id)`. When the subquery returned IDs 1-6 for Amber system points, the outer UPDATE matched points with ID 1-6 on **ALL** systems, not just Amber.

**Correct Pattern**:

```sql
WHERE (system_id, id) IN (
  SELECT pi.system_id, pi.id     -- Returns composite key
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    -- ... conditions
);
```

### Why It Happened

1. **Composite Primary Key Confusion**: `id` auto-increments per system, so IDs 1-6 exist on multiple systems
2. **No Test on Multi-System Database**: Migration tested on single-system dev database
3. **No Pre-Migration Verification**: Didn't verify row count matched expected Amber points only
4. **Insufficient WHERE Clause Testing**: Didn't test subquery in isolation to verify row count

### Affected Systems

| System ID | Name                     | Vendor Type | Corrupted Points | Duplicate Points Created |
| --------- | ------------------------ | ----------- | ---------------- | ------------------------ |
| 1         | Selectronic (daylesford) | selectronic | 1-6              | 17-22                    |
| 2         | Selectronic              | selectronic | 1-6              | 17-22                    |
| 3         | Enphase                  | enphase     | 1-2              | 3-4                      |
| 5         | Fronius (kink_fron)      | fronius     | 1-6              | 14-19                    |
| 6         | Mondo (kink_mondo)       | mondo       | 1-6              | 19-24                    |
| 9         | Amber Electric           | amber       | 1-6              | 10-15                    |

### Point Creation Timestamps

Original points were created **2025-11-07 08:58:16** (Nov 7)
System 9 original points created **2025-11-15 20:44** (Nov 15)

Duplicate points created immediately after corruption:

- Systems 1, 2, 5, 6: **2025-11-16 06:06-07** (within 1 minute of corruption)
- System 3: **2025-11-16 06:56:59** (50 minutes after corruption)
- System 9: **2025-11-17 09:56:56** (next day, suggesting Amber polls less frequently)

This timestamp analysis shows monitoring-points-manager's automatic point creation triggered **immediately** when it couldn't find points with correct metadata after corruption.

---

## Impact Assessment

### Data Integrity

- ✅ **No data loss**: All ~42,000 readings successfully migrated back to original points
- ✅ **Metadata restored**: All 32 points have correct display names and origin metadata
- ⚠️ **Temporary gap**: ~1.5 days of data initially appeared missing (was in duplicate points)

### System Availability

- ✅ **No downtime**: Systems continued collecting data throughout incident
- ✅ **Monitoring uninterrupted**: Data flowed to duplicate points (correct values, wrong metadata)

### Data Breakdown

**point_readings table** (migrated):

- System 1: ~11,922 readings migrated (6 points × ~1,987 each)
- System 2: ~11,964 readings migrated (6 points × ~1,994 each)
- System 5: ~12,096 readings migrated (6 points × ~2,016 each)
- System 6: ~6,036 readings migrated (6 points × ~1,006 each)
- **Total: ~42,018 readings**

**point_readings_agg_5m table** (migrated):

- System 1: ~2,424 aggregates migrated (6 points × ~404 each)
- System 2: ~2,430 aggregates migrated (6 points × ~405 each)
- System 3: ~1,152 aggregates migrated (2 points × ~576 each)
- System 5: ~2,430 aggregates migrated (6 points × ~405 each)
- System 6: ~2,424 aggregates migrated (6 points × ~404 each)
- System 9: ~384 aggregates migrated (variable per point)
- **Total: ~11,244 aggregates**

---

## Recovery Actions

### Migration 0044: Restore Point Info Metadata

**Objective**: Restore correct metadata to old points (1-6) from pre-corruption backup

**Steps**:

1. Temporarily renamed duplicate points' `origin_sub_id` with `TEMP_` prefix to avoid UNIQUE constraint
2. Restored original metadata to old points from snapshot liveone-snapshot-20251116-100416
3. Disabled/re-enabled Vercel cron jobs to prevent new duplicates during metadata fix
4. Verified new data flows to old points after restoration

**Result**: ✅ All 32 points have correct metadata; new data flowing to old points

### Migration 0045: Migrate Readings to Old Points

**Objective**: Move ~42,000 readings from duplicate points back to original points

**Steps**:

1. Counted baseline readings in both old and duplicate points
2. Created backup table `point_readings_agg_5m_backup_overlap` for overlapping aggregates
3. Deleted overlapping aggregates from old points (post-cron-restart data) after backing up
4. Migrated all point_readings: `UPDATE point_readings SET point_id = X WHERE ...`
5. Migrated all point_readings_agg_5m: `UPDATE point_readings_agg_5m SET point_id = X WHERE ...`
6. Verified row counts match expected totals

**Result**: ✅ All readings consolidated into original points; duplicate points empty

**Verification** (AFTER migration):

```
point_readings:
- System 1: ~109,458/point (gain of ~1,995 from baseline ~107,463) ✅
- System 2: ~112,505/point (gain of ~2,002 from baseline ~110,503) ✅
- System 5: ~61,571/point (gain of ~2,023 from baseline ~59,548) ✅
- System 6: ~28,658/point (gain of ~1,010 from baseline ~27,648) ✅

point_readings_agg_5m:
- All systems show expected increases matching duplicate point counts ✅
```

### Pending: Delete Orphaned Points

**Objective**: Remove duplicate points (17-22, etc.) from point_info after server restart

**Prerequisites**:

1. ✅ Production server redeployed to clear cached point_info
2. ⏳ Server restart complete
3. ⏳ Execute DELETE statements to remove orphaned points

**Commands** (to be executed after server restart):

```sql
BEGIN TRANSACTION;

DELETE FROM point_info WHERE system_id = 1 AND id BETWEEN 17 AND 22;
DELETE FROM point_info WHERE system_id = 2 AND id BETWEEN 17 AND 22;
DELETE FROM point_info WHERE system_id = 3 AND id BETWEEN 3 AND 4;
DELETE FROM point_info WHERE system_id = 5 AND id BETWEEN 14 AND 19;
DELETE FROM point_info WHERE system_id = 6 AND id BETWEEN 19 AND 24;
DELETE FROM point_info WHERE system_id = 9 AND id BETWEEN 10 AND 15;

COMMIT;
```

---

## Prevention Guidelines

### For CLAUDE.md

Add the following section to project CLAUDE.md:

````markdown
## Database Migration Safety Guidelines

### Critical Lessons from Nov 2025 Point Metadata Corruption

**ALWAYS follow these rules when writing database migrations:**

#### 1. Composite Primary Keys in WHERE Clauses

When filtering on tables with composite primary keys, **NEVER use a single column in WHERE IN subqueries**.

❌ **WRONG** (matches across all systems):

```sql
WHERE id IN (
  SELECT pi.id FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
)
```
````

✅ **CORRECT** (matches composite key):

```sql
WHERE (system_id, id) IN (
  SELECT pi.system_id, pi.id FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
)
```

#### 2. Migration Pre-Flight Checks

Before running ANY migration that modifies data:

1. **Test subquery in isolation** - Verify row count matches expected scope:

   ```sql
   -- Should return ONLY Amber points (expected: ~6-12 rows)
   SELECT COUNT(*) FROM point_info pi
   JOIN systems s ON pi.system_id = s.id
   WHERE s.vendor_type = 'amber' AND pi.subsystem = 'grid';
   ```

2. **Dry-run with SELECT** - Test your WHERE clause with SELECT first:

   ```sql
   SELECT system_id, id, display_name, origin_id
   FROM point_info
   WHERE (system_id, id) IN (... subquery ...);
   -- Verify this returns ONLY intended rows before UPDATE
   ```

3. **Test on production-like data** - Use Turso snapshot or `npm run db:sync-prod` to test on real data volumes

4. **Verify system scoping** - When filtering by system vendor_type/type:
   ```sql
   -- Add system_id checks to verify scoping works
   SELECT DISTINCT s.id, s.display_name, s.vendor_type
   FROM point_info pi
   JOIN systems s ON pi.system_id = s.id
   WHERE (system_id, id) IN (... your subquery ...)
   ```

#### 3. Migration Checklist

- [ ] Subquery tested in isolation, row count verified
- [ ] WHERE clause tested with SELECT before UPDATE/DELETE
- [ ] Tested on production data copy (snapshot or db:sync-prod)
- [ ] Composite keys handled correctly (system_id, id) not just (id)
- [ ] Migration wrapped in explicit BEGIN TRANSACTION
- [ ] Row count validation before destructive operations
- [ ] Backup created: `turso db create liveone-snapshot-$(date +%Y%m%d-%H%M%S) --from-db liveone-tokyo`
- [ ] Verified migration is idempotent (safe to run multiple times)

```

### Code Review Focus Areas

When reviewing migrations, specifically check:

1. **WHERE clauses with subqueries** - Ensure composite keys are fully matched
2. **JOIN conditions** - Verify system_id is always part of the join
3. **Scope verification** - Confirm changes apply only to intended systems/points
4. **Test evidence** - Require dry-run SELECT output showing affected rows

### Monitoring Improvements

Consider adding alerts for:

1. **Unexpected point creation** - Alert when new points created on existing systems
2. **Metadata changes** - Track point_info updates to detect unintended modifications
3. **Point count changes** - Monitor point_info row count per system

---

## Lessons Learned

### What Went Well

1. ✅ **Automatic failsafe**: monitoring-points-manager's auto-creation of points prevented data loss
2. ✅ **Turso snapshots**: Instant point-in-time backups enabled quick pre-corruption analysis
3. ✅ **Quick detection**: User noticed incorrect labels within ~24 hours of corruption
4. ✅ **Complete recovery**: All data successfully migrated back without loss

### What Could Be Improved

1. ❌ **Pre-migration testing**: Migration 0036 not tested on multi-system database
2. ❌ **Subquery validation**: Didn't verify subquery row count before running UPDATE
3. ❌ **Composite key awareness**: Composite PK pattern not well documented in project
4. ❌ **Migration dry-runs**: No standard practice for SELECT dry-run before UPDATE

### Action Items

- [x] Document composite key WHERE clause patterns in CLAUDE.md
- [x] Add migration safety checklist to CLAUDE.md
- [ ] Create migration template with safety checks built-in
- [ ] Consider automated tests for migrations (verify row counts match expected scope)
- [ ] Add monitoring alert for unexpected point creation on existing systems

---

## References

### Turso Snapshots Created

- `liveone-snapshot-20251116-100416` - Pre-corruption backup (Nov 16 10:04 AM)
- `liveone-snapshot-20251116-183809` - Post-corruption state (Nov 16 6:38 PM)
- `liveone-snapshot-recovery-20251117-194532` - Pre-recovery checkpoint
- `liveone-snapshot-20251117-201245` - Post-metadata-fix, pre-data-migration

### Migrations Created

- `migrations/0044_restore_point_info_metadata.sql` - Restores correct metadata to old points
- `migrations/0045_migrate_readings_to_old_points.sql` - Migrates readings from duplicates to old points

### Related Issues

- Migration 0036 (buggy): `migrations/0036_update_amber_point_metadata.sql`
- Migration 0038: `migrations/0038_fix_amber_origin_sub_id.sql` (also Amber-related)

---

**Report prepared**: 2025-11-17
**Incident duration**: ~26 hours (corruption to full recovery)
**Data loss**: None
**Status**: Recovery complete, pending orphaned point deletion
```
