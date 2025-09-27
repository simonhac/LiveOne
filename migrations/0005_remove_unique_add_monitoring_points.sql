-- Migration: Remove unique constraint and add monitoring points tables
-- Date: 2025-01-27
-- Changes:
--   1. Remove unique constraint on systems.vendor_type + vendor_site_id
--   2. Add monitoring points tables (using systems table instead of point_groups)

-- ============================================================================
-- PART 1: Remove unique constraint from systems table
-- ============================================================================

-- Step 1: Create a temporary table without the unique constraint
CREATE TABLE systems_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    owner_clerk_user_id TEXT,
    vendor_type TEXT NOT NULL,
    vendor_site_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    model TEXT,
    serial TEXT,
    ratings TEXT,
    solar_size TEXT,
    battery_size TEXT,
    location TEXT,
    timezone_offset_min INTEGER DEFAULT 600 NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL
);

-- Step 2: Copy data from the old table to the new table
INSERT INTO systems_new
SELECT
    id,
    owner_clerk_user_id,
    vendor_type,
    vendor_site_id,
    display_name,
    model,
    serial,
    ratings,
    solar_size,
    battery_size,
    location,
    timezone_offset_min,
    created_at,
    updated_at,
    status
FROM systems;

-- Step 3: Drop the old table
DROP TABLE systems;

-- Step 4: Rename the new table to the original name
ALTER TABLE systems_new RENAME TO systems;

-- Step 5: Recreate the non-unique indexes
CREATE INDEX owner_clerk_user_idx ON systems(owner_clerk_user_id);
CREATE INDEX systems_status_idx ON systems(status);

-- ============================================================================
-- PART 2: Create monitoring points tables
-- ============================================================================

-- Point Sub-Groups table - stores monitoring point groups/subcircuits
CREATE TABLE `point_sub_groups` (
    `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    `group_id` INTEGER NOT NULL,  -- References systems.id
    `parent_sub_group_id` INTEGER,
    `vendor_id` TEXT NOT NULL,
    `name` TEXT NOT NULL,
    `display_name` TEXT,
    `description` TEXT,
    `aggregation_type` TEXT DEFAULT 'sum' NOT NULL,
    `status` TEXT DEFAULT 'active' NOT NULL,
    `polling_enabled` INTEGER DEFAULT 1 NOT NULL,
    `vendor_metadata` TEXT,
    `created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    `updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    FOREIGN KEY (`group_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`parent_sub_group_id`) REFERENCES `point_sub_groups`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX `psg_group_vendor_unique` ON `point_sub_groups` (`group_id`,`vendor_id`);
CREATE INDEX `psg_group_idx` ON `point_sub_groups` (`group_id`);
CREATE INDEX `psg_parent_idx` ON `point_sub_groups` (`parent_sub_group_id`);
CREATE INDEX `psg_status_idx` ON `point_sub_groups` (`status`);

-- Point Info table - stores individual monitoring points
CREATE TABLE `point_info` (
    `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    `group_id` INTEGER NOT NULL,  -- References systems.id
    `sub_group_id` INTEGER,
    `vendor_id` TEXT NOT NULL,
    `name` TEXT NOT NULL,
    `display_name` TEXT,
    `description` TEXT,
    `point_type` TEXT NOT NULL,
    `device_type` TEXT,
    `measurement_types` TEXT NOT NULL,
    `units` TEXT,
    `status` TEXT DEFAULT 'active' NOT NULL,
    `last_seen_at` INTEGER,
    `polling_enabled` INTEGER DEFAULT 1 NOT NULL,
    `aggregation_enabled` INTEGER DEFAULT 1 NOT NULL,
    `vendor_metadata` TEXT,
    `created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    `updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    FOREIGN KEY (`group_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`sub_group_id`) REFERENCES `point_sub_groups`(`id`) ON UPDATE no action ON DELETE set null
);

CREATE UNIQUE INDEX `pi_group_vendor_unique` ON `point_info` (`group_id`,`vendor_id`);
CREATE INDEX `pi_group_idx` ON `point_info` (`group_id`);
CREATE INDEX `pi_sub_group_idx` ON `point_info` (`sub_group_id`);
CREATE INDEX `pi_type_idx` ON `point_info` (`point_type`);
CREATE INDEX `pi_status_idx` ON `point_info` (`status`);
CREATE INDEX `pi_polling_idx` ON `point_info` (`polling_enabled`);

-- Note: measurement_sessions table removed - using the existing sessions table instead
-- The sessions table already tracks polling sessions for all vendors

-- Point Readings table - time-series data
CREATE TABLE `point_readings` (
    `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    `point_id` INTEGER NOT NULL,
    `session_id` INTEGER,  -- No longer references measurement_sessions
    `measurement_time` INTEGER NOT NULL,
    `received_time` INTEGER NOT NULL,
    `delay_ms` INTEGER,
    `power_w` REAL,
    `energy_wh` REAL,
    `energy_today_wh` REAL,
    `energy_yesterday_wh` REAL,
    `battery_soc` REAL,
    `battery_voltage` REAL,
    `battery_current` REAL,
    `battery_temperature` REAL,
    `additional_metrics` TEXT,
    `device_status` TEXT,
    `data_quality` TEXT,
    `raw_data` TEXT,
    FOREIGN KEY (`point_id`) REFERENCES `point_info`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX `pr_point_time_unique` ON `point_readings` (`point_id`,`measurement_time`);
CREATE INDEX `pr_point_idx` ON `point_readings` (`point_id`);
CREATE INDEX `pr_time_idx` ON `point_readings` (`measurement_time`);
CREATE INDEX `pr_session_idx` ON `point_readings` (`session_id`);

-- 5-minute aggregation table
CREATE TABLE `point_readings_agg_5m` (
    `point_id` INTEGER NOT NULL,
    `interval_start` INTEGER NOT NULL,
    `interval_end` INTEGER NOT NULL,
    `record_count` INTEGER DEFAULT 0 NOT NULL,
    `power_w_avg` REAL,
    `power_w_min` REAL,
    `power_w_max` REAL,
    `energy_wh_sum` REAL,
    `battery_soc_avg` REAL,
    `battery_soc_min` REAL,
    `battery_soc_max` REAL,
    `data_quality` TEXT,
    `created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    PRIMARY KEY(`point_id`, `interval_start`),
    FOREIGN KEY (`point_id`) REFERENCES `point_info`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `pr5m_point_idx` ON `point_readings_agg_5m` (`point_id`);
CREATE INDEX `pr5m_interval_idx` ON `point_readings_agg_5m` (`interval_start`);

-- Daily aggregation table
CREATE TABLE `point_readings_agg_daily` (
    `point_id` INTEGER NOT NULL,
    `date` TEXT NOT NULL,
    `timezone_offset_min` INTEGER DEFAULT 600 NOT NULL,
    `record_count` INTEGER DEFAULT 0 NOT NULL,
    `power_w_avg` REAL,
    `power_w_min` REAL,
    `power_w_max` REAL,
    `power_w_peak_time` INTEGER,
    `energy_wh_total` REAL,
    `energy_today_wh_final` REAL,
    `battery_soc_avg` REAL,
    `battery_soc_min` REAL,
    `battery_soc_max` REAL,
    `battery_soc_morning` REAL,
    `battery_soc_evening` REAL,
    `data_quality` TEXT,
    `created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    `updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    PRIMARY KEY(`point_id`, `date`),
    FOREIGN KEY (`point_id`) REFERENCES `point_info`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `prd_point_idx` ON `point_readings_agg_daily` (`point_id`);
CREATE INDEX `prd_date_idx` ON `point_readings_agg_daily` (`date`);

-- ============================================================================
-- Verification queries (run manually after migration)
-- ============================================================================

-- Check systems without unique constraint:
-- SELECT vendor_type, vendor_site_id, COUNT(*) as count
-- FROM systems
-- GROUP BY vendor_type, vendor_site_id
-- HAVING COUNT(*) > 1;

-- Check monitoring points tables:
-- SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'point_%';
-- SELECT name FROM sqlite_master WHERE type='table' AND name = 'measurement_sessions';