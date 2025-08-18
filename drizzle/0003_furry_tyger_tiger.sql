PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_readings_agg_1d` (
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
	`solar_w_min` integer,
	`solar_w_avg` integer,
	`solar_w_max` integer,
	`load_w_min` integer,
	`load_w_avg` integer,
	`load_w_max` integer,
	`battery_w_min` integer,
	`battery_w_avg` integer,
	`battery_w_max` integer,
	`grid_w_min` integer,
	`grid_w_avg` integer,
	`grid_w_max` integer,
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
INSERT INTO `__new_readings_agg_1d`("id", "system_id", "day", "created_at", "updated_at", "solar_kwh", "load_kwh", "battery_charge_kwh", "battery_discharge_kwh", "grid_import_kwh", "grid_export_kwh", "solar_w_min", "solar_w_avg", "solar_w_max", "load_w_min", "load_w_avg", "load_w_max", "battery_w_min", "battery_w_avg", "battery_w_max", "grid_w_min", "grid_w_avg", "grid_w_max", "battery_soc_max", "battery_soc_min", "battery_soc_avg", "battery_soc_end", "solar_alltime_kwh", "load_alltime_kwh", "battery_charge_alltime_kwh", "battery_discharge_alltime_kwh", "grid_import_alltime_kwh", "grid_export_alltime_kwh", "interval_count", "version") SELECT "id", "system_id", "day", "created_at", "updated_at", "solar_kwh", "load_kwh", "battery_charge_kwh", "battery_discharge_kwh", "grid_import_kwh", "grid_export_kwh", "solar_w_min", "solar_w_avg", "solar_w_max", "load_w_min", "load_w_avg", "load_w_max", "battery_w_min", "battery_w_avg", "battery_w_max", "grid_w_min", "grid_w_avg", "grid_w_max", "battery_soc_max", "battery_soc_min", "battery_soc_avg", "battery_soc_end", "solar_alltime_kwh", "load_alltime_kwh", "battery_charge_alltime_kwh", "battery_discharge_alltime_kwh", "grid_import_alltime_kwh", "grid_export_alltime_kwh", "interval_count", "version" FROM `readings_agg_1d`;--> statement-breakpoint
DROP TABLE `readings_agg_1d`;--> statement-breakpoint
ALTER TABLE `__new_readings_agg_1d` RENAME TO `readings_agg_1d`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_readings_agg_1d_system_day` ON `readings_agg_1d` (`system_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_readings_agg_1d_day` ON `readings_agg_1d` (`day`);--> statement-breakpoint
CREATE INDEX `idx_readings_agg_1d_updated` ON `readings_agg_1d` (`updated_at`);