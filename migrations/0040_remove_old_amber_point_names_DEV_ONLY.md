# Migration 0040: Remove Old Amber Point Names (DEV ONLY)

## WARNING: DEV DATABASE ONLY

This migration should **NEVER** be applied to production. It cleans up duplicate Amber points that were synced from production before migration 0036 was applied there.

## Problem

The dev database contains duplicate Amber points with both old and new naming conventions:

### Old (incorrect) point names synced from prod:

- `energy` (should be `kwh`)
- `price` (should be `perKwh`)
- `revenue` (should be `cost`)

### Current (correct) point names:

- `kwh` for energy metric
- `cost` for value metric
- `perKwh` for rate metric

## Points to be deleted from dev.db

Based on query results from dev database:

| id  | system_id | origin_id | origin_sub_id | point_name          | extension | metric_type | display_name        |
| --- | --------- | --------- | ------------- | ------------------- | --------- | ----------- | ------------------- |
| 5   | 9         | B1        | energy        | Grid export energy  | import    | energy      | Grid export energy  |
| 2   | 9         | B1        | price         | Grid export price   | export    | energy      | Grid export price   |
| 6   | 9         | B1        | revenue       | Grid export revenue | import    | rate        | Grid export revenue |
| 3   | 9         | E1        | energy        | Grid import energy  | export    | rate        | Grid import energy  |
| 1   | 9         | E1        | price         | Grid import price   | export    | value       | Grid import price   |

**Note**: These points have completely incorrect metadata:

- **Wrong extensions**: import vs export swapped in some cases
- **Wrong metric_type values**: For example, `B1.price` has `metric_type='energy'` when it should be `'rate'`, and `E1.energy` has `metric_type='rate'` when it should be `'energy'`
- This indicates they were created with very old code before the proper Amber adapter was implemented

Because the metric_type values are unreliable, the cleanup script deletes purely based on `origin_sub_id` matching the old naming pattern (`energy`, `price`, `revenue`).

## Verification

After running the cleanup script, verify only correct points remain:

```sql
SELECT origin_id, origin_sub_id, point_name, extension, metric_type
FROM point_info
WHERE origin_id IN ('E1', 'B1', 'CL1')
ORDER BY origin_id, origin_sub_id;
```

Expected results should show only:

- `B1.kwh`, `B1.cost`, `B1.perKwh` (all with extension=export)
- `E1.kwh`, `E1.cost`, `E1.perKwh` (all with extension=import)

## Related Migrations

- Migration 0036: Updated Amber point metadata to use prefixed originSubId (import_kwh, etc.)
- Migration 0038: Fixed system-level points (removed prefixes from renewables, spotPerKwh, tariffPeriod)
- Current code (point-metadata.ts): Uses simple originSubId without prefixes (kwh, cost, perKwh) with originId as channel ID (E1, B1, etc.)
