# Migration 0035 Incident Report

## Summary

Migration 0035 (applied 2025-11-11 ~4:45am AEST) corrupted 213,942 power point records in `point_readings_agg_5m` by incorrectly using a single-column WHERE clause on a composite primary key table.

## What Went Wrong

### The Bug

Migration 0035 used:

```sql
WHERE point_id IN (
  SELECT id FROM point_info
  WHERE metric_type = 'energy' AND (transform IS NULL OR transform != 'd')
)
```

This is incorrect because `point_readings_agg_5m` has a composite primary key `(system_id, point_id)`. The subquery returns `id` values without `system_id`, so it matched ALL records with those IDs across ALL systems.

**Example**: If system 3 (Enphase) has an energy point with `id=5`, and system 6 (Mondo) has a power point with `id=5`, the migration incorrectly updated both.

### The Damage

213,942 power point records were affected:

- `avg`, `min`, `max` fields set to NULL (original values lost)
- `delta` field incorrectly calculated as `avg * sample_count`
- Only `last` field retained correct value

This broke:

- Mondo power charts (Battery Charge, Grid Export, etc.)
- Any historical queries for power data that use avg/min/max fields
- OpenNEM API responses that read from avg field for power series

### Systems Affected

All systems with power points, particularly:

- System 6 (Kinkora Mondo): All power monitoring points

## How to Fix

### Option 1: Automated Script (Recommended)

Run the restoration script:

```bash
./scripts/temp/fix-migration-0035-damage.sh
```

This will:

1. Export affected power point data from snapshot `liveone-snapshot-20251111-044334`
2. Delete corrupted records from production
3. Import correct data from snapshot
4. Verify restoration

### Option 2: Manual Steps

1. **Export data from snapshot**:

```bash
~/.turso/turso db shell liveone-snapshot-20251111-044334 <<'SQL' > /tmp/power_restore.sql
.mode insert point_readings_agg_5m
SELECT * FROM point_readings_agg_5m
WHERE (system_id, point_id) IN (
  SELECT system_id, id FROM point_info WHERE metric_type = 'power'
);
SQL
```

2. **Delete corrupted records**:

```bash
~/.turso/turso db shell liveone-tokyo <<'SQL'
DELETE FROM point_readings_agg_5m
WHERE (system_id, point_id) IN (
  SELECT system_id, id FROM point_info WHERE metric_type = 'power'
)
AND avg IS NULL
AND delta IS NOT NULL;
SQL
```

3. **Import restored data**:

```bash
~/.turso/turso db shell liveone-tokyo < /tmp/power_restore.sql
```

4. **Verify**:

```bash
~/.turso/turso db shell liveone-tokyo \
  "SELECT COUNT(*) FROM point_readings_agg_5m WHERE (system_id, point_id) IN (SELECT system_id, id FROM point_info WHERE metric_type = 'power') AND avg IS NULL AND delta IS NOT NULL"
# Should return: 0
```

## What About Energy Points?

The migration WAS supposed to update energy points, and that part worked correctly. Energy points:

- Had delta calculated correctly as `avg * sample_count`
- Had avg/min/max set to NULL (correct for interval energy)
- Are functioning properly in charts

**Energy points should NOT be restored** - they have the correct data.

## Corrected Migration

The corrected version is in `migrations/0035_backfill_energy_delta_5m_CORRECTED.sql`:

```sql
WHERE (system_id, point_id) IN (
  SELECT system_id, id FROM point_info
  WHERE metric_type = 'energy' AND (transform IS NULL OR transform != 'd')
)
```

This uses the composite key correctly.

## Lessons Learned

1. **Always use composite keys**: When a table has `(system_id, id)` as primary key, WHERE clauses must match both columns

2. **Test migrations on production copy**:

   ```bash
   # Extract snapshot to test
   ~/.turso/turso db shell liveone-snapshot-XXXXXX ".dump" > /tmp/test.db
   sqlite3 /tmp/test.db < migrations/NNNN.sql
   # Verify counts before/after
   ```

3. **Snapshots are essential**: Turso's instant snapshots (copy-on-write) saved us from 8+ hour restoration

4. **Verify migration scope**: Check which records WOULD be affected before applying:

   ```sql
   -- Check count of records that would be updated
   SELECT COUNT(*) FROM target_table WHERE conditions...;

   -- Sample the records to verify correctness
   SELECT * FROM target_table WHERE conditions LIMIT 10;
   ```

## Timeline

- **4:43am AEST**: Snapshot created (`liveone-snapshot-20251111-044334`)
- **4:45am AEST**: Migration 0035 applied
- **4:47am AEST**: 54,838 rows reported as updated (incorrect - included power points)
- **8:25pm AEST**: User discovered Mondo charts broken
- **8:30pm AEST**: Investigation revealed power points corrupted
- **8:45pm AEST**: Restoration plan created

## Status

- [x] Issue identified
- [x] Root cause determined
- [x] Restoration script created
- [ ] Restoration executed
- [ ] Verification completed
- [ ] Corrected migration documented
- [ ] Daily aggregates regenerated (if needed)
