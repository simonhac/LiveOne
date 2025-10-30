# Database Schema Documentation

## Overview

LiveOne uses SQLite (locally) and Turso (production) for data storage. The database is optimized for time-series data with efficient aggregation tables for different time intervals.

## Tables

### 1. `systems` - Inverter System Registry

Stores configuration for each monitored inverter system with multi-user support.

| Column                | Type                           | Description                                                      |
| --------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `id`                  | INTEGER PRIMARY KEY            | Auto-incrementing unique identifier                              |
| `owner_clerk_user_id` | TEXT                           | **Clerk user ID** - authoritative owner (e.g., 'user_31xcrI...') |
| `vendor_type`         | TEXT NOT NULL                  | Vendor type (e.g., 'selectronic', 'enphase')                     |
| `vendor_site_id`      | TEXT NOT NULL                  | Vendor's site/system identifier (e.g., '1586', '648')            |
| `display_name`        | TEXT                           | User-friendly name (e.g., 'Daylesford', 'Craig Home')            |
| `model`               | TEXT                           | Inverter model (e.g., 'SP PRO GO 7.5kW', 'Enphase IQ')           |
| `serial`              | TEXT                           | Serial number                                                    |
| `ratings`             | TEXT                           | Power ratings (e.g., '7.5kW, 48V')                               |
| `solar_size`          | TEXT                           | Solar array size (e.g., '9 kW')                                  |
| `battery_size`        | TEXT                           | Battery capacity (e.g., '14.3 kWh')                              |
| `status`              | TEXT NOT NULL DEFAULT 'active' | System status ('active', 'disabled', 'removed')                  |
| `location`            | TEXT                           | JSON location data (e.g., {"lat": -37.123, "lng": 145.456})      |
| `timezone_offset_min` | INTEGER NOT NULL DEFAULT 600   | Standard timezone offset in minutes (600 for AEST/UTC+10)        |
| `created_at`          | INTEGER (timestamp)            | Creation timestamp                                               |
| `updated_at`          | INTEGER (timestamp)            | Last update timestamp                                            |

**Indexes:**

- `vendor_site_unique` UNIQUE on (`vendor_type`, `vendor_site_id`)
- `owner_clerk_user_idx` on (`owner_clerk_user_id`)
- `systems_status_idx` on (`status`)

**Important Notes:**

- **`owner_clerk_user_id`** is the authoritative field for ownership (required for polling)
- Each system owner must have vendor credentials stored in Clerk private metadata:
  - Select.Live: Username/password credentials
  - Enphase: OAuth tokens (access_token, refresh_token)
- The polling job uses the owner's credentials to fetch data from the vendor API
- **`status`** field controls system visibility:
  - `active`: System is polled and visible
  - `disabled`: System is not polled but remains visible
  - `removed`: System is hidden but data is preserved
- **`location`** stores JSON data (coordinates for Select.Live, address for Enphase)
- Multiple systems per user are supported

### 2. `readings` - Raw Inverter Data

Stores minute-by-minute readings from the inverter.

| Column                  | Type                | Description                                                 |
| ----------------------- | ------------------- | ----------------------------------------------------------- |
| `id`                    | INTEGER PRIMARY KEY | Auto-incrementing unique identifier                         |
| `system_id`             | INTEGER NOT NULL    | Foreign key to systems.id                                   |
| `inverter_time`         | INTEGER (timestamp) | When inverter recorded the data                             |
| `received_time`         | INTEGER (timestamp) | When we fetched the data                                    |
| `delay_seconds`         | INTEGER             | Lag between inverter_time and received_time                 |
| **Power Readings**      |                     |                                                             |
| `solar_w`               | INTEGER             | Total solar power (W)                                       |
| `solar_inverter_w`      | INTEGER             | Solar power through inverter (W)                            |
| `shunt_w`               | INTEGER             | DC-coupled solar power (W)                                  |
| `load_w`                | INTEGER             | Load consumption (W)                                        |
| `battery_w`             | INTEGER             | Battery power (negative=charging, positive=discharging) (W) |
| `grid_w`                | INTEGER             | Grid power (positive=import, negative=export) (W)           |
| **Battery State**       |                     |                                                             |
| `battery_soc`           | REAL                | Battery state of charge (%)                                 |
| **System Status**       |                     |                                                             |
| `fault_code`            | INTEGER             | Current fault code (0 = no fault)                           |
| `fault_timestamp`       | INTEGER             | Unix timestamp of last fault                                |
| `generator_status`      | INTEGER             | Generator running status                                    |
| **Energy Totals**       |                     |                                                             |
| `solar_kwh_total`       | REAL                | Cumulative solar energy (kWh)                               |
| `load_kwh_total`        | REAL                | Cumulative load energy (kWh)                                |
| `battery_in_kwh_total`  | REAL                | Cumulative battery charge energy (kWh)                      |
| `battery_out_kwh_total` | REAL                | Cumulative battery discharge energy (kWh)                   |
| `grid_in_kwh_total`     | REAL                | Cumulative grid import energy (kWh)                         |
| `grid_out_kwh_total`    | REAL                | Cumulative grid export energy (kWh)                         |
| `created_at`            | INTEGER (timestamp) | Record creation timestamp                                   |

**Indexes:**

- `readings_system_inverter_time_unique` UNIQUE on (`system_id`, `inverter_time`)
- `system_inverter_time_idx` on (`system_id`, `inverter_time`)
- `inverter_time_idx` on (`inverter_time`)
- `received_time_idx` on (`received_time`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Unique constraint prevents duplicate readings for same timestamp

### 3. `readings_agg_5m` - 5-Minute Aggregated Data

Pre-aggregated 5-minute intervals for efficient querying.

| Column                       | Type                | Description                                     |
| ---------------------------- | ------------------- | ----------------------------------------------- |
| `id`                         | INTEGER PRIMARY KEY | Auto-incrementing unique identifier             |
| `system_id`                  | INTEGER NOT NULL    | System identifier                               |
| `interval_end`               | INTEGER (timestamp) | End of 5-minute interval                        |
| **Power Statistics**         |                     |                                                 |
| `solar_w_avg`                | INTEGER             | Average solar power (W)                         |
| `solar_w_min`                | INTEGER             | Minimum solar power (W)                         |
| `solar_w_max`                | INTEGER             | Maximum solar power (W)                         |
| `solar_interval_wh`          | INTEGER             | Energy produced in this interval (Wh)           |
| `load_w_avg`                 | INTEGER             | Average load power (W)                          |
| `load_w_min`                 | INTEGER             | Minimum load power (W)                          |
| `load_w_max`                 | INTEGER             | Maximum load power (W)                          |
| `battery_w_avg`              | INTEGER             | Average battery power (W)                       |
| `battery_w_min`              | INTEGER             | Minimum battery power (W)                       |
| `battery_w_max`              | INTEGER             | Maximum battery power (W)                       |
| `grid_w_avg`                 | INTEGER             | Average grid power (W)                          |
| `grid_w_min`                 | INTEGER             | Minimum grid power (W)                          |
| `grid_w_max`                 | INTEGER             | Maximum grid power (W)                          |
| **Interval Energy (TODO)**   |                     |                                                 |
| `load_wh_interval`           | INTEGER             | ⚠️ MISSING - Energy consumed in interval (Wh)   |
| `battery_in_wh_interval`     | INTEGER             | ⚠️ MISSING - Energy charged in interval (Wh)    |
| `battery_out_wh_interval`    | INTEGER             | ⚠️ MISSING - Energy discharged in interval (Wh) |
| `grid_in_wh_interval`        | INTEGER             | ⚠️ MISSING - Energy imported in interval (Wh)   |
| `grid_out_wh_interval`       | INTEGER             | ⚠️ MISSING - Energy exported in interval (Wh)   |
| **End-of-Interval Values**   |                     |                                                 |
| `battery_soc_last`           | REAL                | Battery SOC at end of interval (%)              |
| `solar_kwh_total_last`       | REAL                | Solar total at end of interval (kWh)            |
| `load_kwh_total_last`        | REAL                | Load total at end of interval (kWh)             |
| `battery_in_kwh_total_last`  | REAL                | Battery charge total at end (kWh)               |
| `battery_out_kwh_total_last` | REAL                | Battery discharge total at end (kWh)            |
| `grid_in_kwh_total_last`     | REAL                | Grid import total at end (kWh)                  |
| `grid_out_kwh_total_last`    | REAL                | Grid export total at end (kWh)                  |
| **Data Quality**             |                     |                                                 |
| `sample_count`               | INTEGER             | Number of raw readings in this interval         |
| `created_at`                 | INTEGER (timestamp) | Aggregation timestamp                           |

**Indexes:**

- `readings_agg_5m_system_interval_idx` UNIQUE on (`system_id`, `interval_end`)
- `readings_agg_5m_system_id_idx` on (`system_id`)
- `readings_agg_5m_interval_end_idx` on (`interval_end`)

### 4. `readings_agg_1d` - Daily Aggregated Data

Daily summaries aggregated at 00:05 each day via cron job.

| Column                          | Type                       | Description                                          |
| ------------------------------- | -------------------------- | ---------------------------------------------------- |
| `id`                            | INTEGER PRIMARY KEY        | Auto-incrementing unique identifier                  |
| `system_id`                     | TEXT                       | System identifier (stored as string)                 |
| `day`                           | TEXT                       | Date in YYYY-MM-DD format                            |
| **Daily Energy Totals**         |                            |                                                      |
| `solar_kwh`                     | REAL                       | Total solar generation for the day (kWh)             |
| `load_kwh`                      | REAL                       | Total load consumption for the day (kWh)             |
| `battery_charge_kwh`            | REAL                       | Total battery charging for the day (kWh)             |
| `battery_discharge_kwh`         | REAL                       | Total battery discharging for the day (kWh)          |
| `grid_import_kwh`               | REAL                       | Total grid import for the day (kWh)                  |
| `grid_export_kwh`               | REAL                       | Total grid export for the day (kWh)                  |
| **Power Statistics**            |                            |                                                      |
| `solar_w_min`                   | INTEGER                    | Minimum solar power (W)                              |
| `solar_w_avg`                   | INTEGER                    | Average solar power (W)                              |
| `solar_w_max`                   | INTEGER                    | Maximum solar power (W)                              |
| `load_w_min`                    | INTEGER                    | Minimum load power (W)                               |
| `load_w_avg`                    | INTEGER                    | Average load power (W)                               |
| `load_w_max`                    | INTEGER                    | Maximum load power (W)                               |
| `battery_w_min`                 | INTEGER                    | Minimum battery power (W)                            |
| `battery_w_avg`                 | INTEGER                    | Average battery power (W)                            |
| `battery_w_max`                 | INTEGER                    | Maximum battery power (W)                            |
| `grid_w_min`                    | INTEGER                    | Minimum grid power (W)                               |
| `grid_w_avg`                    | INTEGER                    | Average grid power (W)                               |
| `grid_w_max`                    | INTEGER                    | Maximum grid power (W)                               |
| **Battery SOC Statistics**      |                            |                                                      |
| `battery_soc_min`               | REAL                       | Minimum battery SOC (%)                              |
| `battery_soc_avg`               | REAL                       | Average battery SOC (%)                              |
| `battery_soc_max`               | REAL                       | Maximum battery SOC (%)                              |
| `battery_soc_end`               | REAL                       | Battery SOC at end of day (%)                        |
| **All-Time Totals**             |                            |                                                      |
| `solar_alltime_kwh`             | REAL                       | Cumulative solar at end of day (kWh)                 |
| `load_alltime_kwh`              | REAL                       | Cumulative load at end of day (kWh)                  |
| `battery_charge_alltime_kwh`    | REAL                       | Cumulative battery charge at end (kWh)               |
| `battery_discharge_alltime_kwh` | REAL                       | Cumulative battery discharge at end (kWh)            |
| `grid_import_alltime_kwh`       | REAL                       | Cumulative grid import at end (kWh)                  |
| `grid_export_alltime_kwh`       | REAL                       | Cumulative grid export at end (kWh)                  |
| **Data Quality**                |                            |                                                      |
| `interval_count`                | INTEGER NOT NULL DEFAULT 0 | Number of 5-minute intervals in this day             |
| `sample_count`                  | INTEGER NOT NULL DEFAULT 0 | Total raw samples (cascaded from 5-minute intervals) |
| `version`                       | INTEGER                    | Schema version (currently 1)                         |
| `created_at`                    | INTEGER (timestamp)        | Creation timestamp                                   |
| `updated_at`                    | INTEGER (timestamp)        | Last update timestamp                                |

**Indexes:**

- `readings_agg_1d_system_day_idx` UNIQUE on (`system_id`, `day`)
- `readings_agg_1d_system_id_idx` on (`system_id`)
- `readings_agg_1d_day_idx` on (`day`)

**Notes:**

- Energy values are NULL for the first day (no baseline for calculation)
- Coverage percentage can be calculated as `interval_count / 288 * 100` (288 = 24 hours \* 12 intervals/hour)
- `sample_count` cascades from 5-minute aggregations, representing total raw readings for the day
- Typical sample_count is ~1400-1440 per day (5 samples per 5-minute interval)

### 5. `polling_status` - System Health Monitoring

Tracks the health and status of data collection for each system.

| Column               | Type                 | Description                         |
| -------------------- | -------------------- | ----------------------------------- |
| `id`                 | INTEGER PRIMARY KEY  | Auto-incrementing unique identifier |
| `system_id`          | INTEGER NOT NULL     | Foreign key to systems.id           |
| `last_poll_time`     | INTEGER (timestamp)  | Last polling attempt                |
| `last_success_time`  | INTEGER (timestamp)  | Last successful poll                |
| `last_error_time`    | INTEGER (timestamp)  | Last error occurrence               |
| `last_error`         | TEXT                 | Last error message                  |
| `last_response`      | TEXT (JSON)          | Raw JSON response from vendor API   |
| `consecutive_errors` | INTEGER DEFAULT 0    | Current error streak                |
| `is_active`          | BOOLEAN DEFAULT true | Whether polling is enabled          |
| `total_polls`        | INTEGER DEFAULT 0    | Total polling attempts              |
| `successful_polls`   | INTEGER DEFAULT 0    | Total successful polls              |
| `updated_at`         | INTEGER (timestamp)  | Last update timestamp               |

**Indexes:**

- `polling_system_idx` on (`system_id`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete

### 6. `user_systems` - User-System Access Control

Manages many-to-many relationships between users and systems, controlling access permissions.

| Column          | Type                           | Description                                              |
| --------------- | ------------------------------ | -------------------------------------------------------- |
| `id`            | INTEGER PRIMARY KEY            | Auto-incrementing unique identifier                      |
| `clerk_user_id` | TEXT NOT NULL                  | Clerk user ID (e.g., 'user_31xcrI...')                   |
| `system_id`     | INTEGER NOT NULL               | Foreign key to systems.id                                |
| `role`          | TEXT NOT NULL DEFAULT 'viewer' | User's role for this system ('owner', 'admin', 'viewer') |
| `created_at`    | INTEGER (timestamp)            | Creation timestamp                                       |
| `updated_at`    | INTEGER (timestamp)            | Last update timestamp                                    |

**Indexes:**

- `user_system_unique` UNIQUE on (`clerk_user_id`, `system_id`)
- `user_systems_user_idx` on (`clerk_user_id`)
- `user_systems_system_idx` on (`system_id`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Unique constraint prevents duplicate user-system pairs

**Roles:**

- **owner**: Full control (only one per system, must match systems.owner_clerk_user_id)
- **admin**: Can view and manage the system
- **viewer**: Read-only access to system data

### 7. `point_info` - Monitoring Points Configuration

Stores metadata for individual monitoring points within multi-point energy systems (e.g., Mondo Power systems with multiple devices).

| Column         | Type                | Description                                                       |
| -------------- | ------------------- | ----------------------------------------------------------------- |
| `id`           | INTEGER PRIMARY KEY | Auto-incrementing unique identifier                               |
| `system_id`    | INTEGER NOT NULL    | Foreign key to systems.id                                         |
| `point_id`     | TEXT NOT NULL       | Vendor's point identifier (e.g., 'DEV123')                        |
| `point_sub_id` | TEXT                | Sub-identifier for metric type (e.g., 'power', 'energy')          |
| `point_name`   | TEXT NOT NULL       | Default point name from vendor                                    |
| `display_name` | TEXT NOT NULL       | User-customizable display name                                    |
| `subsystem`    | TEXT                | Energy subsystem ('solar', 'battery', 'grid', 'load', 'inverter') |
| `metric_type`  | TEXT NOT NULL       | Type of measurement ('power', 'energy')                           |
| `metric_unit`  | TEXT NOT NULL       | Unit of measurement ('W', 'Wh')                                   |
| `created_at`   | INTEGER (timestamp) | Creation timestamp                                                |
| `updated_at`   | INTEGER (timestamp) | Last update timestamp                                             |

**Indexes:**

- `point_info_system_idx` on (`system_id`)
- `point_info_unique` UNIQUE on (`system_id`, `point_id`, `point_sub_id`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete

**Notes:**

- Points are lazily created when first data is received
- Each device typically has multiple points (e.g., power and energy)
- The `subsystem` field enables color-coding in the UI

### 8. `point_readings` - Monitoring Points Time-Series Data

Stores time-series measurements from individual monitoring points.

| Column             | Type                | Description                                                      |
| ------------------ | ------------------- | ---------------------------------------------------------------- |
| `id`               | INTEGER PRIMARY KEY | Auto-incrementing unique identifier                              |
| `point_id`         | INTEGER NOT NULL    | Foreign key to point_info.id                                     |
| `measurement_time` | INTEGER NOT NULL    | Unix timestamp (ms) when measurement was taken                   |
| `received_time`    | INTEGER NOT NULL    | Unix timestamp (ms) when data was received                       |
| `value`            | REAL                | Measurement value (null if error)                                |
| `error`            | TEXT                | Error message if reading failed                                  |
| `data_quality`     | TEXT NOT NULL       | Quality indicator ('good', 'error', 'estimated', 'interpolated') |
| `session_id`       | INTEGER             | Foreign key to sessions.id for tracking                          |

**Indexes:**

- `point_readings_point_idx` on (`point_id`)
- `point_readings_time_idx` on (`measurement_time`)
- `point_readings_composite_idx` on (`point_id`, `measurement_time` DESC)

**Constraints:**

- Foreign key to `point_info(id)` with CASCADE delete
- Foreign key to `sessions(id)` with SET NULL on delete

**Notes:**

- The API returns pivoted data with one row per timestamp

## Data Retention

Currently, no automatic retention policies are implemented:

- **Raw readings**: No automatic deletion
- **5-minute aggregates**: No automatic deletion
- **Daily aggregates**: Permanent storage

## Timezone Handling

**Critical**: All timestamps in the database are stored as Unix timestamps (seconds since epoch) in UTC.

The daily aggregation uses the system's `timezone_offset_min` to determine day boundaries:

- Day starts at 00:00:00 local time (e.g., 2025-08-17T00:00:00+10:00)
- Day ends at 00:00:00 next day local time (e.g., 2025-08-18T00:00:00+10:00)
- Intervals use `> start_time` and `<= end_time` for proper boundary handling

## Data Precision

| Data Type     | Precision         | Storage      |
| ------------- | ----------------- | ------------ |
| Power values  | Integer           | Watts        |
| Energy values | 3 decimal places  | kWh          |
| Battery SOC   | 1 decimal place   | Percentage   |
| Timestamps    | Second resolution | Unix seconds |

## Performance Considerations

1. **Indexes**: All time-based queries should use indexed columns
2. **Aggregation**: Use pre-aggregated tables for historical queries
3. **Unique Constraints**: Prevent duplicate data at the database level
4. **Foreign Keys**: Maintain referential integrity with CASCADE deletes

## Multi-User Architecture

### User-System Relationship

```sql
-- Each system has one owner (via owner_clerk_user_id)
-- The owner's Select.Live credentials are used for polling
SELECT
  s.system_number,
  s.display_name,
  s.owner_clerk_user_id,
  -- Credentials stored in Clerk, not in database
FROM systems s
WHERE s.owner_clerk_user_id = 'user_31xcrI...';
```

### Data Access Control

- **Users** can only see systems where `owner_clerk_user_id` matches their Clerk ID
- **Admins** can see all systems regardless of ownership
- **Polling** uses the owner's credentials from Clerk metadata

### Example Systems Setup

```sql
-- Simon's system (Daylesford)
INSERT INTO systems (owner_clerk_user_id, vendor_type, vendor_site_id, display_name, timezone_offset_min)
VALUES ('user_31xcrIbiSrjjTIKlXShEPilRow7', 'selectronic', '1586', 'Daylesford', 600);

-- Craig's system
INSERT INTO systems (owner_clerk_user_id, vendor_type, vendor_site_id, display_name, timezone_offset_min)
VALUES ('user_31xhdEB9tgNk4sWNyFVg6EEpXq7', 'selectronic', '648', 'Craig Home', 600);
```

## Migration History

1. **0001**: Initial schema creation
2. **0002**: Added aggregation tables
3. **0003**: Added polling status table
4. **0004**: Added timezone_offset to systems table
5. **0005**: Added owner_clerk_user_id for multi-user support
6. **0006**: Renamed system_number to vendor_type/vendor_site_id, changed timezone_offset to timezone_offset_min
7. **0007**: Added status and location columns to systems table, removed is_active from polling_status

## Size Estimates

- **Raw readings**: ~125 bytes per minute
- **5-minute aggregates**: ~135 bytes per 5 minutes (~27 bytes/minute)
- **Daily aggregates**: ~200 bytes per day

At 1-minute polling:

- Daily raw data: ~180 KB/system
- Monthly raw data: ~5.4 MB/system
- Yearly raw data: ~65 MB/system
