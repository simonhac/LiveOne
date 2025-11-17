# Hardcoded Timezone References

This document lists all hardcoded timezone references found in the codebase that may need to be updated in the future to use the system's `displayTimezone` field.

## Files with Hardcoded Timezone References

### [app/api/cron/minutely/route.ts](app/api/cron/minutely/route.ts)

Multiple references to `"Australia/Brisbane"`:

- Line 105: Date formatting in cron job
- Line 138: Date formatting in cron job
- Line 182: Date formatting in cron job
- Line 219: Date formatting in cron job
- Line 356: Last poll time formatting
- Line 399: Date formatting in cron job
- Line 446: Date formatting in cron job
- Line 481: Current time zoning

**Context**: These are used in the minutely cron job for polling systems. Consider whether these should use the system's displayTimezone or remain as Brisbane (AEST without DST).

### [app/api/admin/systems/route.ts](app/api/admin/systems/route.ts)

Multiple references to `"Australia/Brisbane"`:

- Line 183: Poll status last poll time formatting
- Line 188: Poll status last success time formatting
- Line 193: Poll status last error time formatting
- Line 218: Reading inverter time formatting

**Context**: These are used in the admin systems API for displaying system information. These could potentially use the system's displayTimezone.

### [app/api/history/route.ts](app/api/history/route.ts)

- Line 770: Response creation timestamp using `now("Australia/Brisbane")`

**Context**: This is the `created_at` timestamp for the history API response. Consider whether this should remain as Brisbane or use UTC/system timezone.

### [lib/date-utils.ts](lib/date-utils.ts)

Multiple references to `"Australia/Sydney"` and `"Australia/Brisbane"`:

- Line 176: `toZoned(absolute, "Australia/Sydney")` in parseTimeString helper
- Line 185: `toZoned(absolute, "Australia/Sydney")` in parseTimeString helper
- Line 194: `toZoned(absolute, "Australia/Sydney")` in parseTimeString end time
- Line 198: `toZoned(absolute, "Australia/Sydney")` in parseTimeString error case
- Line 275: Conditional `"Australia/Brisbane"` or `"UTC"` based on timezoneOffsetMin in fromUnixTimestamp
- Line 332: `now("Australia/Brisbane")` in parseRelativeTime

**Context**: These are utility functions for parsing and formatting dates. These are critical functions that may need refactoring to accept a timezone parameter instead of hardcoding.

### [lib/**tests**/date-utils.test.ts](lib/__tests__/date-utils.test.ts)

- Line 260: `toZoned(absolute, "Australia/Sydney")` in test

**Context**: Test file - may need updating if date-utils.ts changes.

## Summary

**Total hardcoded timezone references**: 23 occurrences across 4 main files

**Breakdown by timezone**:

- `Australia/Brisbane`: 13 occurrences (primarily in cron jobs and date utilities)
- `Australia/Sydney`: 5 occurrences (in date parsing utilities)
- Mixed/Conditional: 5 occurrences

## Recommendations for Future Work

1. **High Priority - Date Utilities** ([lib/date-utils.ts](lib/date-utils.ts)):
   - Consider adding timezone parameters to `parseTimeString`, `fromUnixTimestamp`, and `parseRelativeTime`
   - These are widely used utility functions that affect the entire application

2. **Medium Priority - Cron Jobs** ([app/api/cron/minutely/route.ts](app/api/cron/minutely/route.ts)):
   - Determine if cron jobs should use system's displayTimezone or remain backend-focused with AEST/Brisbane
   - May be appropriate to keep as Brisbane for consistency in backend operations

3. **Medium Priority - Admin API** ([app/api/admin/systems/route.ts](app/api/admin/systems/route.ts)):
   - Could benefit from using system's displayTimezone for consistency with user-facing displays

4. **Low Priority - History API** ([app/api/history/route.ts](app/api/history/route.ts)):
   - The `created_at` timestamp for API responses - consider UTC or system timezone

## Notes

- The newly added `displayTimezone` field is now available on all system objects
- `timezoneOffsetMin` should continue to be used for backend processing (doesn't observe DST)
- `displayTimezone` should be used for user-facing displays (observes DST where applicable)
