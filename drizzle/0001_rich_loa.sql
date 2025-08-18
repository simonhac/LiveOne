CREATE TABLE `readings_agg_1d` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`system_id` text NOT NULL,
	`day` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`solar_kwh` real,
	`load_kwh` real,
	`battery_charge_kwh` real,
	`battery_discharge_kwh` real,
	`grid_import_kwh` real,
	`grid_export_kwh` real,
	`solar_w_max` real,
	`solar_w_avg` real,
	`load_w_max` real,
	`load_w_avg` real,
	`battery_w_max` real,
	`battery_w_min` real,
	`battery_soc_max` real,
	`battery_soc_min` real,
	`battery_soc_avg` real,
	`battery_soc_end` real,
	`solar_alltime_kwh` real,
	`load_alltime_kwh` real,
	`battery_charge_alltime_kwh` real,
	`battery_discharge_alltime_kwh` real,
	`grid_import_alltime_kwh` real,
	`grid_export_alltime_kwh` real,
	`interval_count` integer,
	`version` integer DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_readings_agg_1d_system_day` ON `readings_agg_1d` (`system_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_readings_agg_1d_day` ON `readings_agg_1d` (`day`);--> statement-breakpoint
CREATE INDEX `idx_readings_agg_1d_updated` ON `readings_agg_1d` (`updated_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_readings_agg_5m` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`system_id` integer NOT NULL,
	`interval_end` integer NOT NULL,
	`solar_w_avg` integer,
	`solar_w_min` integer,
	`solar_w_max` integer,
	`load_w_avg` integer,
	`load_w_min` integer,
	`load_w_max` integer,
	`battery_w_avg` integer,
	`battery_w_min` integer,
	`battery_w_max` integer,
	`grid_w_avg` integer,
	`grid_w_min` integer,
	`grid_w_max` integer,
	`battery_soc_last` real,
	`solar_kwh_total_last` real,
	`load_kwh_total_last` real,
	`battery_in_kwh_total_last` real,
	`battery_out_kwh_total_last` real,
	`grid_in_kwh_total_last` real,
	`grid_out_kwh_total_last` real,
	`sample_count` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_readings_agg_5m`("id", "system_id", "interval_end", "solar_w_avg", "solar_w_min", "solar_w_max", "load_w_avg", "load_w_min", "load_w_max", "battery_w_avg", "battery_w_min", "battery_w_max", "grid_w_avg", "grid_w_min", "grid_w_max", "battery_soc_last", "solar_kwh_total_last", "load_kwh_total_last", "battery_in_kwh_total_last", "battery_out_kwh_total_last", "grid_in_kwh_total_last", "grid_out_kwh_total_last", "sample_count", "created_at") SELECT "id", "system_id", "interval_end", "solar_w_avg", "solar_w_min", "solar_w_max", "load_w_avg", "load_w_min", "load_w_max", "battery_w_avg", "battery_w_min", "battery_w_max", "grid_w_avg", "grid_w_min", "grid_w_max", "battery_soc_last", "solar_kwh_total_last", "load_kwh_total_last", "battery_in_kwh_total_last", "battery_out_kwh_total_last", "grid_in_kwh_total_last", "grid_out_kwh_total_last", "sample_count", "created_at" FROM `readings_agg_5m`;--> statement-breakpoint
DROP TABLE `readings_agg_5m`;--> statement-breakpoint
ALTER TABLE `__new_readings_agg_5m` RENAME TO `readings_agg_5m`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `readings_agg_5m_system_interval_idx` ON `readings_agg_5m` (`system_id`,`interval_end`);--> statement-breakpoint
CREATE INDEX `readings_agg_5m_system_id_idx` ON `readings_agg_5m` (`system_id`);--> statement-breakpoint
CREATE INDEX `readings_agg_5m_interval_end_idx` ON `readings_agg_5m` (`interval_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `readings_system_inverter_time_unique` ON `readings` (`system_id`,`inverter_time`);