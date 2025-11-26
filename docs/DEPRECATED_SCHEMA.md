# Deprecated Schema - Legacy Readings Tables

> **Deprecated as of November 2025**
> These tables are no longer written to. Use the `point_*` tables instead.
> See `lib/db/schema-monitoring-points.ts` for the current schema.

## Overview

The legacy readings tables (`readings`, `readings_agg_5m`, `readings_agg_1d`) were the original data storage system. They have been superseded by the point-based system which offers:

- Flexible per-metric storage (not fixed columns)
- Support for multiple data points per system
- Better handling of composite/virtual systems
- Cleaner separation of metadata and measurements

## Legacy Tables

### `readings` - Raw Time-Series Data

Stored raw inverter readings at ~1 minute intervals.

```sql
CREATE TABLE readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,

  -- Timestamps
  inverter_time INTEGER NOT NULL,    -- When inverter recorded the data (Unix seconds)
  received_time INTEGER NOT NULL,    -- When we fetched the data (Unix seconds)
  delay_seconds INTEGER,             -- receivedTime - inverterTime

  -- Power readings (Watts)
  solar_w INTEGER,
  solar_local_w INTEGER,             -- Local solar (from shunt/CT)
  solar_remote_w INTEGER,            -- Remote solar (from inverter)
  load_w INTEGER,
  battery_w INTEGER,
  grid_w INTEGER,

  -- Battery state
  battery_soc REAL,                  -- State of charge (0-100%)

  -- System status
  fault_code TEXT,
  fault_timestamp INTEGER,           -- Unix timestamp of fault
  generator_status INTEGER,

  -- Sequence identifier (for push-based systems)
  sequence TEXT,

  -- Energy counters - interval values (Wh)
  solar_wh_interval INTEGER,
  load_wh_interval INTEGER,
  battery_in_wh_interval INTEGER,
  battery_out_wh_interval INTEGER,
  grid_in_wh_interval INTEGER,
  grid_out_wh_interval INTEGER,

  -- Energy counters - lifetime totals (kWh)
  solar_kwh_total REAL,
  load_kwh_total REAL,
  battery_in_kwh_total REAL,
  battery_out_kwh_total REAL,
  grid_in_kwh_total REAL,
  grid_out_kwh_total REAL,

  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

**Indexes:**

- `readings_system_inverter_time_unique` - Unique constraint on (system_id, inverter_time)
- `system_inverter_time_idx` - Query performance
- `inverter_time_idx` - Time range queries
- `received_time_idx` - Delay analysis

### `readings_agg_5m` - 5-Minute Aggregates

Pre-computed 5-minute aggregates for dashboard queries.

```sql
CREATE TABLE readings_agg_5m (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  interval_end INTEGER NOT NULL,     -- End of 5-minute interval (Unix seconds)

  -- Power statistics (Watts)
  solar_w_avg INTEGER,
  solar_w_min INTEGER,
  solar_w_max INTEGER,
  solar_interval_wh INTEGER,         -- Energy in this interval (Wh)

  load_w_avg INTEGER,
  load_w_min INTEGER,
  load_w_max INTEGER,

  battery_w_avg INTEGER,
  battery_w_min INTEGER,
  battery_w_max INTEGER,

  grid_w_avg INTEGER,
  grid_w_min INTEGER,
  grid_w_max INTEGER,

  -- State values (last value in interval)
  battery_soc_last REAL,

  -- Energy counters (last values in interval)
  solar_kwh_total_last REAL,
  load_kwh_total_last REAL,
  battery_in_kwh_total_last REAL,
  battery_out_kwh_total_last REAL,
  grid_in_kwh_total_last REAL,
  grid_out_kwh_total_last REAL,

  sample_count INTEGER NOT NULL,     -- Number of readings aggregated
  created_at INTEGER NOT NULL
);
```

**Indexes:**

- `readings_agg_5m_system_interval_idx` - Unique constraint on (system_id, interval_end)
- `readings_agg_5m_system_id_idx` - System filtering
- `readings_agg_5m_interval_end_idx` - Time range queries

### `readings_agg_1d` - Daily Aggregates

Pre-computed daily aggregates for historical charts and analytics.

```sql
CREATE TABLE readings_agg_1d (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,           -- Note: TEXT type for historical reasons
  day TEXT NOT NULL,                 -- YYYY-MM-DD format (system local time)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Daily energy totals (kWh)
  solar_kwh REAL,
  load_kwh REAL,
  battery_charge_kwh REAL,
  battery_discharge_kwh REAL,
  grid_import_kwh REAL,
  grid_export_kwh REAL,

  -- Power statistics (Watts)
  solar_w_min INTEGER,
  solar_w_avg INTEGER,
  solar_w_max INTEGER,
  load_w_min INTEGER,
  load_w_avg INTEGER,
  load_w_max INTEGER,
  battery_w_min INTEGER,
  battery_w_avg INTEGER,
  battery_w_max INTEGER,
  grid_w_min INTEGER,
  grid_w_avg INTEGER,
  grid_w_max INTEGER,

  -- Battery SOC statistics (%)
  battery_soc_max REAL,
  battery_soc_min REAL,
  battery_soc_avg REAL,
  battery_soc_end REAL,

  -- All-time totals at end of day (kWh)
  solar_alltime_kwh REAL,
  load_alltime_kwh REAL,
  battery_charge_alltime_kwh REAL,
  battery_discharge_alltime_kwh REAL,
  grid_import_alltime_kwh REAL,
  grid_export_alltime_kwh REAL,

  -- Data quality
  interval_count INTEGER NOT NULL DEFAULT 0,  -- Non-null 5-min intervals
  sample_count INTEGER NOT NULL DEFAULT 0,    -- Total raw samples
  version INTEGER DEFAULT 1
);
```

**Indexes:**

- `idx_readings_agg_1d_system_day` - Unique constraint on (system_id, day)
- `idx_readings_agg_1d_day` - Date range queries
- `idx_readings_agg_1d_updated` - Finding stale records

## Replacement Tables

The legacy tables have been replaced by:

| Legacy Table      | Replacement             | Notes                                         |
| ----------------- | ----------------------- | --------------------------------------------- |
| `readings`        | `point_readings`        | Per-point storage, timestamps in milliseconds |
| `readings_agg_5m` | `point_readings_agg_5m` | Per-point aggregates                          |
| `readings_agg_1d` | `point_readings_agg_1d` | Per-point daily summaries                     |

See `docs/SCHEMA.md` and `lib/db/schema-monitoring-points.ts` for the current schema.

## Historical Data Access

The legacy tables remain in the database for historical analysis. To query historical data:

```sql
-- Example: Get daily solar production for 2024
SELECT day, solar_kwh
FROM readings_agg_1d
WHERE system_id = '1'
  AND day BETWEEN '2024-01-01' AND '2024-12-31'
ORDER BY day;

-- Example: Get 5-minute data for a specific day
SELECT
  datetime(interval_end, 'unixepoch') as time,
  solar_w_avg,
  load_w_avg
FROM readings_agg_5m
WHERE system_id = 1
  AND interval_end BETWEEN 1704067200 AND 1704153600  -- 2024-01-01
ORDER BY interval_end;
```

## Migration History

- **August 2024**: Initial schema created
- **August 2025**: Point-based tables added (`point_*`)
- **November 2025**: Stopped writing to legacy tables, deprecated

## Files Moved to /legacy

The following files were moved to the untracked `/legacy` folder for reference when building future `point_readings_agg_1d` infrastructure:

- `aggregation-helper.ts` - 5-minute aggregation logic
- `aggregate-daily.ts` - Daily aggregation logic for legacy tables

These files are not tracked in git but are preserved locally for reference.
