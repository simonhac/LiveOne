# Daily Aggregates Table Schema

## Overview
Pre-calculated daily summaries to dramatically improve performance for historical queries.

## Table: `readings_agg_1d`

### Primary Fields
| Field | Type | Description |
|-------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Unique identifier |
| `system_id` | TEXT NOT NULL | References systems.id |
| `day` | TEXT NOT NULL | Date in YYYY-MM-DD format (system local time) |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds when record created |
| `updated_at` | INTEGER NOT NULL | Unix epoch seconds when record last updated |

### Energy Metrics
| Field | Type | Description |
|-------|------|-------------|
| `solar_kwh` | REAL | Total solar generation for the day (kWh) |
| `load_kwh` | REAL | Total load consumption for the day (kWh) |
| `battery_charge_kwh` | REAL | Total battery charging for the day (kWh) |
| `battery_discharge_kwh` | REAL | Total battery discharging for the day (kWh) |
| `grid_import_kwh` | REAL | Total grid import for the day (kWh) |
| `grid_export_kwh` | REAL | Total grid export for the day (kWh) |

### Power Statistics
| Field | Type | Description |
|-------|------|-------------|
| `solar_w_min` | INTEGER | Minimum solar power (W) |
| `solar_w_avg` | INTEGER | Average solar power (W) |
| `solar_w_max` | INTEGER | Maximum solar power (W) |
| `load_w_min` | INTEGER | Minimum load power (W) |
| `load_w_avg` | INTEGER | Average load power (W) |
| `load_w_max` | INTEGER | Maximum load power (W) |
| `battery_w_min` | INTEGER | Minimum battery power (W, negative = charge) |
| `battery_w_avg` | INTEGER | Average battery power (W) |
| `battery_w_max` | INTEGER | Maximum battery power (W, positive = discharge) |
| `grid_w_min` | INTEGER | Minimum grid power (W, negative = export) |
| `grid_w_avg` | INTEGER | Average grid power (W) |
| `grid_w_max` | INTEGER | Maximum grid power (W, positive = import) |

### Battery State Statistics
| Field | Type | Description |
|-------|------|-------------|
| `battery_soc_max` | REAL | Maximum battery SOC (%) |
| `battery_soc_min` | REAL | Minimum battery SOC (%) |
| `battery_soc_avg` | REAL | Average battery SOC (%) |
| `battery_soc_end` | REAL | SOC at end of day (%) |

### All-Time Energy Metrics
| Field | Type | Description |
|-------|------|-------------|
| `solar_alltime_kwh` | REAL | All time solar generation as at end of day (kWh) |
| `load_alltime_kwh` | REAL | All time load consumption as at end of day (kWh) |
| `battery_charge_alltime_kwh` | REAL | All time battery charging as at end of day (kWh) |
| `battery_discharge_alltime_kwh` | REAL | All time battery discharging as at end of day (kWh) |
| `grid_import_alltime_kwh` | REAL | All time grid import as at end of day (kWh) |
| `grid_export_alltime_kwh` | REAL | All time grid export as at end of day (kWh) |

### Data Quality Fields
| Field | Type | Description |
|-------|------|-------------|
| `interval_count` | INTEGER | Number of non-null 5 min intervals aggregated |

### Performance & Metadata
| Field | Type | Description |
|-------|------|-------------|
| `version` | INTEGER DEFAULT 1 | Schema version for migrations |

## Indexes

```sql
-- Unique constraint on system and day
CREATE UNIQUE INDEX idx_readings_agg_1d_system_day ON readings_agg_1d(system_id, day);

-- For filtering by day ranges
CREATE INDEX idx_readings_agg_1d_day ON readings_agg_1d(day);

-- For finding records that need updating
CREATE INDEX idx_readings_agg_1d_updated ON readings_agg_1d(updated_at);
```

## SQL Create Statement

```sql
CREATE TABLE readings_agg_1d (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id TEXT NOT NULL,
    day TEXT NOT NULL,  -- YYYY-MM-DD format (system local time)
    created_at INTEGER NOT NULL,  -- Unix epoch seconds
    updated_at INTEGER NOT NULL,  -- Unix epoch seconds

    -- Energy metrics (kWh)
    solar_kwh REAL,
    load_kwh REAL,
    battery_charge_kwh REAL,
    battery_discharge_kwh REAL,
    grid_import_kwh REAL,
    grid_export_kwh REAL,
    
    -- Power statistics (W) - stored as integers
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

    -- All-time Energy metrics (kWh)
    solar_alltime_kwh REAL,
    load_alltime_kwh REAL,
    battery_charge_alltime_kwh REAL,
    battery_discharge_alltime_kwh REAL,
    grid_import_alltime_kwh REAL,
    grid_export_alltime_kwh REAL,
    
    -- Data quality
    interval_count INTEGER,
    
    -- Metadata
    version INTEGER DEFAULT 1,
    
    FOREIGN KEY (system_id) REFERENCES systems (id)
);
```

## Benefits

### Query Performance
- **1 row per day** instead of 1440 rows (1-minute data)
- **~30x faster** for weekly views
- **~900x faster** for monthly views
- **~27,000x faster** for yearly views

### Storage Efficiency
- Pre-calculated totals and averages
- No need to aggregate on every query
- Reduces database load significantly

### Data Quality Tracking
- Know when days have incomplete data
- Identify data gaps

### Extensibility
- Version field allows schema evolution
- Easy to add new metrics

### Initial Creation and ongoing update
- Need a function to generate values for all days that don't have a summary
- Run this initially, and every day at 12.05am
- the Energy metrics values should be calculated from the difference between the date's all time values and those of the day before -— not by accumulating the power ratings.

## Usage Examples

### Get monthly summary
```sql
SELECT 
    day,
    solar_kwh,
    load_kwh,
    battery_soc_avg
FROM readings_agg_1d
WHERE system_id = ?
    AND day >= date('now', '-30 days')
ORDER BY day;
```

### Find days with incomplete data
```sql
SELECT day, interval_count
FROM readings_agg_1d
WHERE system_id = ?
    AND interval_count < (24 * 60 / 5) -- Less than 288 5-minute intervals
    AND day >= date('now', '-7 days');
```

### Calculate monthly totals
```sql
SELECT 
    strftime('%Y-%m', day) as month,
    SUM(solar_kwh) as monthly_solar,
    SUM(load_kwh) as monthly_load,
    AVG(battery_soc_avg) as avg_battery_soc
FROM readings_agg_1d
WHERE system_id = ?
GROUP BY month
ORDER BY month DESC;
```

## Implementation Notes

1. **Aggregation Timing**: Run 5 minutes after midnight local time for previous day
2. **Update Strategy**: Recalculate if new data arrives for a completed day
3. **Timezone Handling**: Store day as YYYY-MM-DD in system local time, timestamps as Unix epoch seconds
4. **Retention**: Keep indefinitely (365 rows per year per system)