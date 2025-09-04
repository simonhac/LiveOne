# Enphase API `/telemetry/production_micro` Endpoint Documentation

## Summary of Learnings

### 1. Default Behavior (no parameters)
- Returns **today's data** from 00:05 up to the most recent 5-minute interval
- Data is always in 5-minute intervals
- Returns partial day data (only what's available so far)

### 2. Granularity Parameter Behavior
- `granularity=day` with `start_at` and `end_at`: Returns **288 intervals** (full day of 5-minute data)
- `granularity=5mins` with `start_at`: Returns only **1 interval** at that specific time
- `granularity` alone (without `start_at`): **Ignored** - still returns today's partial data
- Despite the name, `granularity=day` doesn't aggregate to daily totals, it returns all 5-minute intervals for the day

### 3. Date Range Queries
- Must provide both `start_at` and `end_at` as Unix timestamps
- For a complete day: Set `start_at` to 00:00 and `end_at` to 00:00 of the next day
- Cannot request future dates (returns 422 "Requested date is in the future")

### 4. Interval Timestamps
- `end_at` in each interval represents the **END** of that 5-minute period
- First interval of a day: `00:05` (covers 00:00-00:05)
- Last interval of a day: `00:00` next day (covers 23:55-00:00)
- A complete day has exactly 288 intervals

### 5. Key Implementation Points
- For **current/today's data**: Call without parameters
- For **historical complete days**: Use `start_at`, `end_at`, and `granularity=day`
- The interval ending at midnight (00:00) belongs to the **current day**, not the next day
- When storing, include intervals where `end_at <= endUnix` (not `< endUnix`)

## API Quirks
This API has an unusual quirk where `granularity=day` returns 5-minute interval data rather than daily aggregates. This means we need different strategies for fetching current vs. historical data.

## Example API Calls

### Get Today's Data (partial)
```
GET /api/v4/systems/{system_id}/telemetry/production_micro
```

### Get Complete Historical Day
```
GET /api/v4/systems/{system_id}/telemetry/production_micro?start_at={unix_00:00}&end_at={unix_00:00_next_day}&granularity=day
```

### Get Single 5-Minute Interval
```
GET /api/v4/systems/{system_id}/telemetry/production_micro?start_at={unix_timestamp}&granularity=5mins
```