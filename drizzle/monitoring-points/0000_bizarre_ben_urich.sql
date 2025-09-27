CREATE TABLE `measurement_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`session_type` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	`points_queried` integer DEFAULT 0 NOT NULL,
	`points_success` integer DEFAULT 0 NOT NULL,
	`points_failed` integer DEFAULT 0 NOT NULL,
	`api_call_count` integer DEFAULT 0 NOT NULL,
	`total_duration_ms` integer,
	`error_messages` text,
	`vendor_response_metadata` text,
	FOREIGN KEY (`group_id`) REFERENCES `point_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ms_group_idx` ON `measurement_sessions` (`group_id`);--> statement-breakpoint
CREATE INDEX `ms_started_at_idx` ON `measurement_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `ms_session_type_idx` ON `measurement_sessions` (`session_type`);--> statement-breakpoint
CREATE TABLE `point_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_type` text NOT NULL,
	`vendor_id` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`description` text,
	`location` text,
	`timezone_offset_min` integer DEFAULT 600 NOT NULL,
	`owner_clerk_user_id` text,
	`shared_with_clerk_user_ids` text,
	`polling_enabled` integer DEFAULT true NOT NULL,
	`polling_interval_seconds` integer DEFAULT 60 NOT NULL,
	`vendor_metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pg_vendor_unique` ON `point_groups` (`vendor_type`,`vendor_id`);--> statement-breakpoint
CREATE INDEX `pg_owner_idx` ON `point_groups` (`owner_clerk_user_id`);--> statement-breakpoint
CREATE INDEX `pg_polling_idx` ON `point_groups` (`polling_enabled`);--> statement-breakpoint
CREATE TABLE `point_info` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`sub_group_id` integer,
	`vendor_id` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`description` text,
	`point_type` text NOT NULL,
	`device_type` text,
	`measurement_types` text NOT NULL,
	`units` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` integer,
	`polling_enabled` integer DEFAULT true NOT NULL,
	`aggregation_enabled` integer DEFAULT true NOT NULL,
	`vendor_metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `point_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sub_group_id`) REFERENCES `point_sub_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pi_group_vendor_unique` ON `point_info` (`group_id`,`vendor_id`);--> statement-breakpoint
CREATE INDEX `pi_group_idx` ON `point_info` (`group_id`);--> statement-breakpoint
CREATE INDEX `pi_sub_group_idx` ON `point_info` (`sub_group_id`);--> statement-breakpoint
CREATE INDEX `pi_type_idx` ON `point_info` (`point_type`);--> statement-breakpoint
CREATE INDEX `pi_status_idx` ON `point_info` (`status`);--> statement-breakpoint
CREATE INDEX `pi_polling_idx` ON `point_info` (`polling_enabled`);--> statement-breakpoint
CREATE TABLE `point_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`point_id` integer NOT NULL,
	`session_id` integer,
	`measurement_time` integer NOT NULL,
	`received_time` integer NOT NULL,
	`delay_ms` integer,
	`power_w` real,
	`energy_wh` real,
	`energy_today_wh` real,
	`energy_yesterday_wh` real,
	`battery_soc` real,
	`battery_voltage` real,
	`battery_current` real,
	`battery_temperature` real,
	`additional_metrics` text,
	`device_status` text,
	`data_quality` text,
	`raw_data` text,
	FOREIGN KEY (`point_id`) REFERENCES `point_info`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `measurement_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_point_time_unique` ON `point_readings` (`point_id`,`measurement_time`);--> statement-breakpoint
CREATE INDEX `pr_point_idx` ON `point_readings` (`point_id`);--> statement-breakpoint
CREATE INDEX `pr_time_idx` ON `point_readings` (`measurement_time`);--> statement-breakpoint
CREATE INDEX `pr_session_idx` ON `point_readings` (`session_id`);--> statement-breakpoint
CREATE TABLE `point_readings_agg_5m` (
	`point_id` integer NOT NULL,
	`interval_start` integer NOT NULL,
	`interval_end` integer NOT NULL,
	`sample_count` integer NOT NULL,
	`power_avg` real,
	`power_min` real,
	`power_max` real,
	`power_std_dev` real,
	`energy_delta` real,
	`energy_end` real,
	`battery_soc_avg` real,
	`battery_soc_min` real,
	`battery_soc_max` real,
	`additional_aggregates` text,
	`data_completeness` real,
	`uptime_seconds` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`point_id`, `interval_start`),
	FOREIGN KEY (`point_id`) REFERENCES `point_info`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pr5m_time_idx` ON `point_readings_agg_5m` (`interval_start`);--> statement-breakpoint
CREATE INDEX `pr5m_point_time_idx` ON `point_readings_agg_5m` (`point_id`,`interval_start`);--> statement-breakpoint
CREATE TABLE `point_sub_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`parent_sub_group_id` integer,
	`vendor_id` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`description` text,
	`group_type` text,
	`polling_enabled` integer DEFAULT true NOT NULL,
	`vendor_metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `point_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_sub_group_id`) REFERENCES `point_sub_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `psg_group_vendor_unique` ON `point_sub_groups` (`group_id`,`vendor_id`);--> statement-breakpoint
CREATE INDEX `psg_group_idx` ON `point_sub_groups` (`group_id`);--> statement-breakpoint
CREATE INDEX `psg_parent_idx` ON `point_sub_groups` (`parent_sub_group_id`);--> statement-breakpoint
CREATE INDEX `psg_polling_idx` ON `point_sub_groups` (`polling_enabled`);