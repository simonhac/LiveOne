CREATE TABLE `clerk_id_mapping` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`prod_clerk_id` text NOT NULL,
	`dev_clerk_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clerk_id_mapping_prod_clerk_id_unique` ON `clerk_id_mapping` (`prod_clerk_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `clerk_id_mapping_dev_clerk_id_unique` ON `clerk_id_mapping` (`dev_clerk_id`);--> statement-breakpoint
CREATE TABLE `polling_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`system_id` integer NOT NULL,
	`last_poll_time` integer,
	`last_success_time` integer,
	`last_error_time` integer,
	`last_error` text,
	`last_response` text,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`total_polls` integer DEFAULT 0 NOT NULL,
	`successful_polls` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polling_system_idx` ON `polling_status` (`system_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `polling_status_system_id_unique` ON `polling_status` (`system_id`);--> statement-breakpoint
CREATE TABLE `readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`system_id` integer NOT NULL,
	`inverter_time` integer NOT NULL,
	`received_time` integer NOT NULL,
	`delay_seconds` integer,
	`solar_w` integer,
	`solar_local_w` integer,
	`solar_remote_w` integer,
	`load_w` integer,
	`battery_w` integer,
	`grid_w` integer,
	`battery_soc` real,
	`fault_code` text,
	`fault_timestamp` integer,
	`generator_status` integer,
	`sequence` text,
	`solar_wh_interval` integer,
	`load_wh_interval` integer,
	`battery_in_wh_interval` integer,
	`battery_out_wh_interval` integer,
	`grid_in_wh_interval` integer,
	`grid_out_wh_interval` integer,
	`solar_kwh_total` real,
	`load_kwh_total` real,
	`battery_in_kwh_total` real,
	`battery_out_kwh_total` real,
	`grid_in_kwh_total` real,
	`grid_out_kwh_total` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `readings_system_inverter_time_unique` ON `readings` (`system_id`,`inverter_time`);--> statement-breakpoint
CREATE INDEX `system_inverter_time_idx` ON `readings` (`system_id`,`inverter_time`);--> statement-breakpoint
CREATE INDEX `inverter_time_idx` ON `readings` (`inverter_time`);--> statement-breakpoint
CREATE INDEX `received_time_idx` ON `readings` (`received_time`);--> statement-breakpoint
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
	`interval_count` integer DEFAULT 0 NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_readings_agg_1d_system_day` ON `readings_agg_1d` (`system_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_readings_agg_1d_day` ON `readings_agg_1d` (`day`);--> statement-breakpoint
CREATE INDEX `idx_readings_agg_1d_updated` ON `readings_agg_1d` (`updated_at`);--> statement-breakpoint
CREATE TABLE `readings_agg_5m` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`system_id` integer NOT NULL,
	`interval_end` integer NOT NULL,
	`solar_w_avg` integer,
	`solar_w_min` integer,
	`solar_w_max` integer,
	`solar_interval_wh` integer,
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
CREATE UNIQUE INDEX `readings_agg_5m_system_interval_idx` ON `readings_agg_5m` (`system_id`,`interval_end`);--> statement-breakpoint
CREATE INDEX `readings_agg_5m_system_id_idx` ON `readings_agg_5m` (`system_id`);--> statement-breakpoint
CREATE INDEX `readings_agg_5m_interval_end_idx` ON `readings_agg_5m` (`interval_end`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_label` text,
	`system_id` integer NOT NULL,
	`vendor_type` text NOT NULL,
	`system_name` text NOT NULL,
	`cause` text NOT NULL,
	`started` integer NOT NULL,
	`duration` integer NOT NULL,
	`successful` integer NOT NULL,
	`error_code` text,
	`error` text,
	`response` text,
	`num_rows` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_system_idx` ON `sessions` (`system_id`);--> statement-breakpoint
CREATE INDEX `sessions_started_idx` ON `sessions` (`started`);--> statement-breakpoint
CREATE INDEX `sessions_cause_idx` ON `sessions` (`cause`);--> statement-breakpoint
CREATE TABLE `systems` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_clerk_user_id` text,
	`vendor_type` text NOT NULL,
	`vendor_site_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`display_name` text NOT NULL,
	`model` text,
	`serial` text,
	`ratings` text,
	`solar_size` text,
	`battery_size` text,
	`location` text,
	`timezone_offset_min` integer DEFAULT 600 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `owner_clerk_user_idx` ON `systems` (`owner_clerk_user_id`);--> statement-breakpoint
CREATE INDEX `systems_status_idx` ON `systems` (`status`);--> statement-breakpoint
CREATE TABLE `user_systems` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clerk_user_id` text NOT NULL,
	`system_id` integer NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_system_unique` ON `user_systems` (`clerk_user_id`,`system_id`);--> statement-breakpoint
CREATE INDEX `user_systems_user_idx` ON `user_systems` (`clerk_user_id`);--> statement-breakpoint
CREATE INDEX `user_systems_system_idx` ON `user_systems` (`system_id`);