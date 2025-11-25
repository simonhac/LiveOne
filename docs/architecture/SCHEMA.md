# Database Schema Documentation

## Overview

LiveOne uses SQLite (development) and Turso (production) for data storage. The database supports:

- **Multi-vendor systems**: Selectronic, Enphase, Fronius, Mondo, Amber, and composite aggregations
- **Multi-user architecture**: Each system has an owner whose credentials are used for polling
- **Time-series data**: Minute-level raw data with 5-minute and daily pre-aggregated views
- **Point-based monitoring**: Flexible schema for multi-device systems with arbitrary metrics
- **Composite systems**: Virtual systems that aggregate data from multiple source systems

---

## Table of Contents

1. [Core System Tables](#core-system-tables)
2. [Legacy Time-Series Tables](#legacy-time-series-tables)
3. [Monitoring Points](#monitoring-points)
4. [Point Aggregation Tables](#point-aggregation-tables)
5. [Access Control](#access-control)
6. [Session Tracking](#session-tracking)
7. [Development-Only Tables](#development-only-tables)
8. [Data Architecture](#data-architecture)
9. [Timezone Handling](#timezone-handling)
10. [Data Precision](#data-precision)

---

## Core System Tables

### `systems` - Energy System Registry

Stores configuration for each monitored energy system.

| Column                | Type                           | Description                                                   |
| --------------------- | ------------------------------ | ------------------------------------------------------------- |
| `id`                  | INTEGER PRIMARY KEY            | Auto-incrementing unique identifier                           |
| `owner_clerk_user_id` | TEXT                           | Clerk user ID - owner who holds vendor credentials            |
| `vendor_type`         | TEXT NOT NULL                  | Vendor type: 'selectronic', 'enphase', 'fronius', 'composite' |
| `vendor_site_id`      | TEXT NOT NULL                  | Vendor's site/system identifier                               |
| `status`              | TEXT NOT NULL DEFAULT 'active' | 'active', 'disabled', or 'removed'                            |
| `display_name`        | TEXT NOT NULL                  | User-friendly name (e.g., 'Home Solar')                       |
| `alias`               | TEXT                           | URL-friendly identifier (letters, digits, underscore only)    |
| `model`               | TEXT                           | Inverter model                                                |
| `serial`              | TEXT                           | Serial number                                                 |
| `ratings`             | TEXT                           | Power ratings                                                 |
| `solar_size`          | TEXT                           | Solar array size                                              |
| `battery_size`        | TEXT                           | Battery capacity                                              |
| `location`            | TEXT (JSON)                    | Location data (lat/lng or address)                            |
| `metadata`            | TEXT (JSON)                    | Vendor-specific config (e.g., composite system mappings)      |
| `timezone_offset_min` | INTEGER NOT NULL               | Standard timezone offset in minutes (600 for AEST/UTC+10)     |
| `display_timezone`    | TEXT NOT NULL                  | IANA timezone (e.g., 'Australia/Melbourne') - observes DST    |
| `is_default`          | INTEGER NOT NULL DEFAULT 0     | User's default system (0 or 1)                                |
| `created_at`          | INTEGER (timestamp)            | Creation timestamp                                            |
| `updated_at`          | INTEGER (timestamp)            | Last update timestamp                                         |

**Indexes:**

- `owner_clerk_user_idx` on (`owner_clerk_user_id`)
- `systems_status_idx` on (`status`)
- `alias_unique` UNIQUE on (`owner_clerk_user_id`, `alias`)
- `is_default_unique` UNIQUE partial index on (`owner_clerk_user_id`) WHERE `is_default = 1`

**Notes:**

- **`owner_clerk_user_id`**: Required for polling. Vendor credentials stored in Clerk private metadata
- **`status`**: Controls polling and visibility
  - `active`: System is polled and visible
  - `disabled`: Not polled but visible
  - `removed`: Hidden but data preserved
- **`alias`**: Optional URL-friendly identifier, unique per user
- **`is_default`**: Only one default system per user (enforced by partial unique index)
- **Composite systems**: `vendor_type = 'composite'`, `metadata` contains mapping configuration

**Composite System Metadata Format:**

```json
{
  "version": 1,
  "mappings": {
    "solar": ["liveone.system1.source.solar.local.power.avg"],
    "battery": ["liveone.system1.bidi.battery.power.avg"],
    "load": ["liveone.system2.load.total.power.avg"],
    "grid": ["liveone.system1.bidi.grid.power.avg"]
  }
}
```

---

### `polling_status` - System Health Monitoring

Tracks health and status of data collection for each system.

| Column               | Type                | Description                       |
| -------------------- | ------------------- | --------------------------------- |
| `id`                 | INTEGER PRIMARY KEY | Auto-incrementing unique ID       |
| `system_id`          | INTEGER NOT NULL    | Foreign key to systems.id         |
| `last_poll_time`     | INTEGER (timestamp) | Last polling attempt              |
| `last_success_time`  | INTEGER (timestamp) | Last successful poll              |
| `last_error_time`    | INTEGER (timestamp) | Last error occurrence             |
| `last_error`         | TEXT                | Last error message                |
| `last_response`      | TEXT (JSON)         | Raw JSON response from vendor API |
| `consecutive_errors` | INTEGER DEFAULT 0   | Current error streak              |
| `total_polls`        | INTEGER DEFAULT 0   | Total polling attempts            |
| `successful_polls`   | INTEGER DEFAULT 0   | Total successful polls            |
| `updated_at`         | INTEGER (timestamp) | Last update timestamp             |

**Indexes:**

- `polling_system_idx` on (`system_id`)
- `polling_status_system_id_unique` UNIQUE on (`system_id`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete

---

## Legacy Time-Series Tables

**Note:** These tables are used for older Selectronic systems. Newer systems use the point-based monitoring tables.

### `readings` - Raw Inverter Data

Stores minute-by-minute readings from Selectronic inverters.

| Column                    | Type                | Description                                  |
| ------------------------- | ------------------- | -------------------------------------------- |
| `id`                      | INTEGER PRIMARY KEY | Auto-incrementing unique ID                  |
| `system_id`               | INTEGER NOT NULL    | Foreign key to systems.id                    |
| `inverter_time`           | INTEGER (timestamp) | When inverter recorded the data              |
| `received_time`           | INTEGER (timestamp) | When we fetched the data                     |
| `delay_seconds`           | INTEGER             | Lag between inverter_time and received_time  |
| **Power Readings**        |                     |                                              |
| `solar_w`                 | INTEGER             | Total solar power (W)                        |
| `solar_local_w`           | INTEGER             | Local solar power (W)                        |
| `solar_remote_w`          | INTEGER             | Remote solar power (W)                       |
| `load_w`                  | INTEGER             | Load consumption (W)                         |
| `battery_w`               | INTEGER             | Battery power (negative=charging) (W)        |
| `grid_w`                  | INTEGER             | Grid power (positive=import) (W)             |
| **Battery State**         |                     |                                              |
| `battery_soc`             | REAL                | Battery state of charge (%)                  |
| **System Status**         |                     |                                              |
| `fault_code`              | TEXT                | Current fault code (0 = no fault)            |
| `fault_timestamp`         | INTEGER             | Unix timestamp of last fault                 |
| `generator_status`        | INTEGER             | Generator running status                     |
| `sequence`                | TEXT                | Sequence identifier (for push-based systems) |
| **Interval Energy**       |                     |                                              |
| `solar_wh_interval`       | INTEGER             | Energy produced in this period (Wh)          |
| `load_wh_interval`        | INTEGER             | Energy consumed in this period (Wh)          |
| `battery_in_wh_interval`  | INTEGER             | Energy charged in this period (Wh)           |
| `battery_out_wh_interval` | INTEGER             | Energy discharged in this period (Wh)        |
| `grid_in_wh_interval`     | INTEGER             | Energy imported in this period (Wh)          |
| `grid_out_wh_interval`    | INTEGER             | Energy exported in this period (Wh)          |
| **Lifetime Totals**       |                     |                                              |
| `solar_kwh_total`         | REAL                | Cumulative solar energy (kWh)                |
| `load_kwh_total`          | REAL                | Cumulative load energy (kWh)                 |
| `battery_in_kwh_total`    | REAL                | Cumulative battery charge energy (kWh)       |
| `battery_out_kwh_total`   | REAL                | Cumulative battery discharge energy (kWh)    |
| `grid_in_kwh_total`       | REAL                | Cumulative grid import energy (kWh)          |
| `grid_out_kwh_total`      | REAL                | Cumulative grid export energy (kWh)          |
| `created_at`              | INTEGER (timestamp) | Record creation timestamp                    |

**Indexes:**

- `readings_system_inverter_time_unique` UNIQUE on (`system_id`, `inverter_time`)
- `system_inverter_time_idx` on (`system_id`, `inverter_time`)
- `inverter_time_idx` on (`inverter_time`)
- `received_time_idx` on (`received_time`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Unique constraint prevents duplicate readings for same timestamp

---

### `readings_agg_5m` - 5-Minute Aggregated Data

Pre-aggregated 5-minute intervals for efficient querying.

| Column                       | Type                | Description                        |
| ---------------------------- | ------------------- | ---------------------------------- |
| `id`                         | INTEGER PRIMARY KEY | Auto-incrementing unique ID        |
| `system_id`                  | INTEGER NOT NULL    | System identifier                  |
| `interval_end`               | INTEGER (timestamp) | End of 5-minute interval           |
| **Power Statistics**         |                     |                                    |
| `solar_w_avg`                | INTEGER             | Average solar power (W)            |
| `solar_w_min`                | INTEGER             | Minimum solar power (W)            |
| `solar_w_max`                | INTEGER             | Maximum solar power (W)            |
| `solar_interval_wh`          | INTEGER             | Energy produced in interval (Wh)   |
| `load_w_avg`                 | INTEGER             | Average load power (W)             |
| `load_w_min`                 | INTEGER             | Minimum load power (W)             |
| `load_w_max`                 | INTEGER             | Maximum load power (W)             |
| `battery_w_avg`              | INTEGER             | Average battery power (W)          |
| `battery_w_min`              | INTEGER             | Minimum battery power (W)          |
| `battery_w_max`              | INTEGER             | Maximum battery power (W)          |
| `grid_w_avg`                 | INTEGER             | Average grid power (W)             |
| `grid_w_min`                 | INTEGER             | Minimum grid power (W)             |
| `grid_w_max`                 | INTEGER             | Maximum grid power (W)             |
| **End-of-Interval Values**   |                     |                                    |
| `battery_soc_last`           | REAL                | Battery SOC at end of interval (%) |
| `solar_kwh_total_last`       | REAL                | Solar total at end of interval     |
| `load_kwh_total_last`        | REAL                | Load total at end of interval      |
| `battery_in_kwh_total_last`  | REAL                | Battery charge total at end        |
| `battery_out_kwh_total_last` | REAL                | Battery discharge total at end     |
| `grid_in_kwh_total_last`     | REAL                | Grid import total at end           |
| `grid_out_kwh_total_last`    | REAL                | Grid export total at end           |
| **Data Quality**             |                     |                                    |
| `sample_count`               | INTEGER             | Number of raw readings in interval |
| `created_at`                 | INTEGER (timestamp) | Aggregation timestamp              |

**Indexes:**

- `readings_agg_5m_system_interval_idx` UNIQUE on (`system_id`, `interval_end`)
- `readings_agg_5m_system_id_idx` on (`system_id`)
- `readings_agg_5m_interval_end_idx` on (`interval_end`)

---

### `readings_agg_1d` - Daily Aggregated Data

Daily summaries aggregated at 00:05 each day via cron job.

| Column                          | Type                | Description                          |
| ------------------------------- | ------------------- | ------------------------------------ |
| `id`                            | INTEGER PRIMARY KEY | Auto-incrementing unique ID          |
| `system_id`                     | TEXT                | System identifier (stored as string) |
| `day`                           | TEXT                | Date in YYYY-MM-DD format            |
| **Daily Energy Totals**         |                     |                                      |
| `solar_kwh`                     | REAL                | Total solar generation (kWh)         |
| `load_kwh`                      | REAL                | Total load consumption (kWh)         |
| `battery_charge_kwh`            | REAL                | Total battery charging (kWh)         |
| `battery_discharge_kwh`         | REAL                | Total battery discharging (kWh)      |
| `grid_import_kwh`               | REAL                | Total grid import (kWh)              |
| `grid_export_kwh`               | REAL                | Total grid export (kWh)              |
| **Power Statistics**            |                     |                                      |
| `solar_w_min/avg/max`           | INTEGER             | Solar power statistics (W)           |
| `load_w_min/avg/max`            | INTEGER             | Load power statistics (W)            |
| `battery_w_min/avg/max`         | INTEGER             | Battery power statistics (W)         |
| `grid_w_min/avg/max`            | INTEGER             | Grid power statistics (W)            |
| **Battery SOC Statistics**      |                     |                                      |
| `battery_soc_min/avg/max/end`   | REAL                | Battery SOC statistics (%)           |
| **All-Time Totals**             |                     |                                      |
| `solar_alltime_kwh`             | REAL                | Cumulative solar at end of day       |
| `load_alltime_kwh`              | REAL                | Cumulative load at end of day        |
| `battery_charge_alltime_kwh`    | REAL                | Cumulative battery charge at end     |
| `battery_discharge_alltime_kwh` | REAL                | Cumulative battery discharge at end  |
| `grid_import_alltime_kwh`       | REAL                | Cumulative grid import at end        |
| `grid_export_alltime_kwh`       | REAL                | Cumulative grid export at end        |
| **Data Quality**                |                     |                                      |
| `interval_count`                | INTEGER DEFAULT 0   | Number of 5-minute intervals         |
| `sample_count`                  | INTEGER DEFAULT 0   | Total raw samples                    |
| `version`                       | INTEGER             | Schema version (currently 1)         |
| `created_at`                    | INTEGER (timestamp) | Creation timestamp                   |
| `updated_at`                    | INTEGER (timestamp) | Last update timestamp                |

**Indexes:**

- `idx_readings_agg_1d_system_day` UNIQUE on (`system_id`, `day`)
- `idx_readings_agg_1d_day` on (`day`)
- `idx_readings_agg_1d_updated` on (`updated_at`)

**Notes:**

- Coverage percentage: `interval_count / 288 * 100` (288 = 24 hours × 12 intervals/hour)
- Typical sample_count: ~1400-1440 per day (5 samples per 5-minute interval)

---

## Monitoring Points

**Note:** This is the current architecture for all modern systems (Enphase, Fronius, Mondo, Amber).

### `point_info` - Monitoring Point Metadata

Stores metadata for individual monitoring points within energy systems.

| Column          | Type                       | Description                                                 |
| --------------- | -------------------------- | ----------------------------------------------------------- |
| `system_id`     | INTEGER NOT NULL           | Foreign key to systems.id (part of composite PK)            |
| `id`            | INTEGER NOT NULL           | Sequential per system (part of composite PK)                |
| `origin_id`     | TEXT NOT NULL              | Vendor's point identifier (e.g., device UUID)               |
| `origin_sub_id` | TEXT                       | Sub-identifier for metric type (e.g., 'power', 'energy')    |
| `point_name`    | TEXT NOT NULL              | Default point name from vendor                              |
| `display_name`  | TEXT NOT NULL              | User-customizable display name                              |
| `subsystem`     | TEXT                       | Energy subsystem: 'solar', 'battery', 'grid', 'load', etc.  |
| `type`          | TEXT                       | User-settable type: 'source', 'load', 'bidi'                |
| `subtype`       | TEXT                       | User-settable subtype: 'pool', 'ev', 'solar1'               |
| `extension`     | TEXT                       | Additional qualifier (user-settable)                        |
| `alias`         | TEXT                       | URL-friendly identifier (letters, digits, underscore only)  |
| `metric_type`   | TEXT NOT NULL              | Type of measurement: 'power', 'energy', 'soc', etc.         |
| `metric_unit`   | TEXT NOT NULL              | Unit: 'W', 'Wh', '%', etc.                                  |
| `active`        | BOOLEAN NOT NULL DEFAULT 1 | Whether this point is enabled                               |
| `transform`     | TEXT                       | Optional transform: null, 'i' (invert), 'd' (differentiate) |
| `created`       | INTEGER                    | Creation timestamp (Unix milliseconds)                      |

**Primary Key:** (`system_id`, `id`)

**Indexes:**

- `pi_system_point_unique` UNIQUE on (`system_id`, `origin_id`, `origin_sub_id`)
- `pi_system_idx` on (`system_id`)
- `pi_subsystem_idx` on (`subsystem`)
- `pi_metric_type_idx` on (`metric_type`)
- `pi_system_short_name_unique` UNIQUE on (`system_id`, `alias`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Composite primary key ensures sequential numbering per system

**Notes:**

- Points are lazily created when first data is received
- Each device typically has multiple points (e.g., power and energy)
- The `subsystem` field enables color-coding in the UI
- `transform = 'd'` indicates differentiated values (rate of change)
- `alias` is URL-friendly identifier unique within the system

---

### `point_readings` - Point Time-Series Data

Stores time-series measurements from individual monitoring points.

| Column             | Type                         | Description                                    |
| ------------------ | ---------------------------- | ---------------------------------------------- |
| `id`               | INTEGER PRIMARY KEY          | Auto-incrementing unique ID                    |
| `system_id`        | INTEGER NOT NULL             | Foreign key to systems.id                      |
| `point_id`         | INTEGER NOT NULL             | Foreign key to point_info.id                   |
| `session_id`       | INTEGER                      | Foreign key to sessions.id (optional)          |
| `measurement_time` | INTEGER NOT NULL             | Unix timestamp (ms) when measured              |
| `received_time`    | INTEGER NOT NULL             | Unix timestamp (ms) when received              |
| `value`            | REAL                         | Numeric value (null if error)                  |
| `value_str`        | TEXT                         | String value (e.g., tariff codes, fault codes) |
| `error`            | TEXT                         | Error message if reading failed                |
| `data_quality`     | TEXT NOT NULL DEFAULT 'good' | 'good', 'error', 'estimated', 'interpolated'   |

**Indexes:**

- `pr_point_time_unique` UNIQUE on (`system_id`, `point_id`, `measurement_time`)
- `pr_system_time_idx` on (`system_id`, `measurement_time`)
- `pr_point_idx` on (`point_id`)
- `pr_session_idx` on (`session_id`)
- `pr_measurement_time_idx` on (`measurement_time`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Composite foreign key to `point_info(system_id, id)` with CASCADE delete
- Foreign key to `sessions(id)` with SET NULL on delete

**Notes:**

- Timestamps in milliseconds for sub-second precision
- Both numeric and string values supported
- `data_quality` enables filtering and validation

---

## Point Aggregation Tables

### `point_readings_agg_5m` - 5-Minute Point Aggregates

Pre-aggregated 5-minute intervals for efficient point queries.

| Column         | Type             | Description                               |
| -------------- | ---------------- | ----------------------------------------- |
| `system_id`    | INTEGER NOT NULL | Foreign key to systems.id (part of PK)    |
| `point_id`     | INTEGER NOT NULL | Foreign key to point_info.id (part of PK) |
| `interval_end` | INTEGER NOT NULL | End of interval (ms) (part of PK)         |
| `session_id`   | INTEGER          | Optional session ID                       |
| `avg`          | REAL             | Average value in interval                 |
| `min`          | REAL             | Minimum value in interval                 |
| `max`          | REAL             | Maximum value in interval                 |
| `last`         | REAL             | Last value in interval                    |
| `delta`        | REAL             | For differentiated values (transform='d') |
| `value_str`    | TEXT             | For text values (e.g., tariff periods)    |
| `sample_count` | INTEGER NOT NULL | Number of samples in interval             |
| `error_count`  | INTEGER NOT NULL | Number of errors in interval              |
| `data_quality` | TEXT             | Quality indicator                         |
| `created_at`   | INTEGER NOT NULL | Creation timestamp (ms)                   |
| `updated_at`   | INTEGER NOT NULL | Last update timestamp (ms)                |

**Primary Key:** (`system_id`, `point_id`, `interval_end`)

**Indexes:**

- `pr5m_system_time_idx` on (`system_id`, `interval_end`)
- `pr5m_interval_end_idx` on (`interval_end`)
- `pr5m_session_idx` on (`session_id`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Composite foreign key to `point_info(system_id, id)` with CASCADE delete

---

### `point_readings_agg_1d` - Daily Point Aggregates

Daily aggregated data for long-term queries.

| Column         | Type             | Description                               |
| -------------- | ---------------- | ----------------------------------------- |
| `system_id`    | INTEGER NOT NULL | Foreign key to systems.id (part of PK)    |
| `point_id`     | INTEGER NOT NULL | Foreign key to point_info.id (part of PK) |
| `day`          | TEXT NOT NULL    | YYYY-MM-DD format (part of PK)            |
| `avg`          | REAL             | Average of 5-min averages                 |
| `min`          | REAL             | Minimum of 5-min minimums                 |
| `max`          | REAL             | Maximum of 5-min maximums                 |
| `last`         | REAL             | Value from 00:00 interval                 |
| `delta`        | REAL             | Sum of 5-min deltas                       |
| `sample_count` | INTEGER NOT NULL | Total samples in day                      |
| `error_count`  | INTEGER NOT NULL | Total errors in day                       |
| `created_at`   | INTEGER NOT NULL | Creation timestamp (ms)                   |
| `updated_at`   | INTEGER NOT NULL | Last update timestamp (ms)                |

**Primary Key:** (`system_id`, `point_id`, `day`)

**Indexes:**

- `pr1d_system_day_idx` on (`system_id`, `day`)
- `pr1d_day_idx` on (`day`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Composite foreign key to `point_info(system_id, id)` with CASCADE delete

---

## Access Control

### `user_systems` - User-System Access Control

Manages many-to-many relationships between users and systems.

| Column          | Type                           | Description                   |
| --------------- | ------------------------------ | ----------------------------- |
| `id`            | INTEGER PRIMARY KEY            | Auto-incrementing unique ID   |
| `clerk_user_id` | TEXT NOT NULL                  | Clerk user ID                 |
| `system_id`     | INTEGER NOT NULL               | Foreign key to systems.id     |
| `role`          | TEXT NOT NULL DEFAULT 'viewer' | 'owner', 'admin', or 'viewer' |
| `created_at`    | INTEGER (timestamp)            | Creation timestamp            |
| `updated_at`    | INTEGER (timestamp)            | Last update timestamp         |

**Indexes:**

- `user_system_unique` UNIQUE on (`clerk_user_id`, `system_id`)
- `user_systems_user_idx` on (`clerk_user_id`)
- `user_systems_system_idx` on (`system_id`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete
- Unique constraint prevents duplicate user-system pairs

**Roles:**

- **owner**: Full control (must match systems.owner_clerk_user_id)
- **admin**: Can view and manage the system
- **viewer**: Read-only access

---

## Session Tracking

### `sessions` - Communication Session Logs

Tracks all communication sessions with energy systems for debugging and monitoring.

| Column          | Type                | Description                              |
| --------------- | ------------------- | ---------------------------------------- |
| `id`            | INTEGER PRIMARY KEY | Auto-incrementing unique ID              |
| `session_label` | TEXT                | Label from remote system (if available)  |
| `system_id`     | INTEGER NOT NULL    | Foreign key to systems.id                |
| `cause`         | TEXT NOT NULL       | 'POLL', 'ADMIN', 'USER', etc.            |
| `started`       | INTEGER (timestamp) | Session start time                       |
| `duration`      | INTEGER NOT NULL    | Duration in milliseconds                 |
| `successful`    | BOOLEAN             | NULL=pending, 1=success, 0=failed        |
| `error_code`    | TEXT                | Short error code/number (if failed)      |
| `error`         | TEXT                | Detailed error message (if failed)       |
| `response`      | TEXT (JSON)         | Full server response as JSON             |
| `num_rows`      | INTEGER NOT NULL    | Number of data rows received (0 if none) |
| `created_at`    | INTEGER (timestamp) | Record creation timestamp                |

**Indexes:**

- `sessions_system_idx` on (`system_id`)
- `sessions_started_idx` on (`started`)
- `sessions_cause_idx` on (`cause`)

**Constraints:**

- Foreign key to `systems(id)` with CASCADE delete

**Notes:**

- Used for debugging API communication issues
- `response` field stores full vendor API response for analysis
- `session_label` provided by systems like Mondo for tracking

---

## Development-Only Tables

**WARNING:** These tables should ONLY exist in development databases.

### `clerk_id_mapping` - Development User Mapping

Maps production Clerk IDs to development Clerk IDs to prevent production user IDs from leaking into development databases.

| Column          | Type                | Description                        |
| --------------- | ------------------- | ---------------------------------- |
| `id`            | INTEGER PRIMARY KEY | Auto-incrementing unique ID        |
| `username`      | TEXT NOT NULL       | Username or email                  |
| `prod_clerk_id` | TEXT NOT NULL       | Production Clerk user ID (unique)  |
| `dev_clerk_id`  | TEXT NOT NULL       | Development Clerk user ID (unique) |
| `created_at`    | INTEGER (timestamp) | Creation timestamp                 |
| `updated_at`    | INTEGER (timestamp) | Last update timestamp              |

---

### `sync_status` - Development Sync Tracking

Tracks last synced timestamps for automatic sync from production to development.

| Column            | Type             | Description                                 |
| ----------------- | ---------------- | ------------------------------------------- |
| `table_name`      | TEXT PRIMARY KEY | Table name (e.g., 'readings')               |
| `last_entry_ms`   | INTEGER          | Unix timestamp in milliseconds (time-based) |
| `last_entry_date` | TEXT             | Calendar date YYYY-MM-DD (date-based)       |
| `updated_at`      | INTEGER          | Last update time (ms)                       |

---

## Data Architecture

### Data Flow

1. **Collection**: Cron job polls vendor APIs (minutely for Selectronic, smart schedule for Enphase)
2. **Storage**: Raw data → `readings` (legacy) or `point_readings` (modern)
3. **5-Min Aggregation**: Real-time as data arrives
4. **Daily Aggregation**: Runs at 00:05 daily via cron job
5. **API**: Queries use pre-aggregated data for fast response (< 1s)

### System Types

#### Legacy Systems (Selectronic)

- Use `readings`, `readings_agg_5m`, `readings_agg_1d` tables
- Minute-by-minute polling
- Fixed schema for standard metrics

#### Modern Systems (Enphase, Fronius, Mondo, Amber)

- Use `point_info`, `point_readings`, `point_readings_agg_5m`, `point_readings_agg_1d` tables
- Flexible schema supports arbitrary metrics
- Smart polling schedules

#### Composite Systems

- Virtual systems that aggregate data from other systems
- Do not poll (no vendor credentials needed)
- Metadata field contains mapping configuration
- Do not appear in other systems' source lists (no nesting)

### Data Retention

Currently, no automatic retention policies are implemented:

- **Raw readings**: No automatic deletion
- **5-minute aggregates**: No automatic deletion
- **Daily aggregates**: Permanent storage

---

## Timezone Handling

**Critical:** All timestamps in the database are stored as Unix timestamps in UTC.

### Systems Table

- `timezone_offset_min`: Standard timezone offset in minutes for polling and calculations (e.g., 600 for AEST/UTC+10) - does NOT observe DST
- `display_timezone`: IANA timezone string for user display (e.g., 'Australia/Melbourne') - observes DST

### Daily Aggregation

Uses the system's `timezone_offset_min` to determine day boundaries:

- Day starts at 00:00:00 local time (e.g., 2025-08-17T00:00:00+10:00)
- Day ends at 00:00:00 next day local time (e.g., 2025-08-18T00:00:00+10:00)
- Intervals use `> start_time` and `<= end_time` for proper boundary handling

---

## Data Precision

| Data Type             | Precision                              | Storage    | Notes                   |
| --------------------- | -------------------------------------- | ---------- | ----------------------- |
| Power values (legacy) | Integer                                | Watts      | readings tables only    |
| Power values (points) | REAL (floating point)                  | Watts      | point_readings tables   |
| Energy values         | 3 decimal places                       | kWh or Wh  | Both legacy and points  |
| Battery SOC           | 1 decimal place                        | Percentage | Both legacy and points  |
| Timestamps            | Millisecond (points) / Second (legacy) | Unix epoch | Points use ms precision |

---

## Performance Considerations

1. **Indexes**: All time-based queries use indexed columns
2. **Aggregation**: Use pre-aggregated tables for historical queries
3. **Unique Constraints**: Prevent duplicate data at the database level
4. **Foreign Keys**: Maintain referential integrity with CASCADE deletes
5. **Composite Keys**: Point tables use composite primary keys for efficient queries
