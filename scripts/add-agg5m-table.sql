-- Create 5-minute aggregated readings table
CREATE TABLE IF NOT EXISTS `readings_agg_5m` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`system_id` integer NOT NULL,
	`interval_end` integer NOT NULL,
	`solar_w_avg` real,
	`solar_w_min` real,
	`solar_w_max` real,
	`load_w_avg` real,
	`load_w_min` real,
	`load_w_max` real,
	`battery_w_avg` real,
	`battery_w_min` real,
	`battery_w_max` real,
	`grid_w_avg` real,
	`grid_w_min` real,
	`grid_w_max` real,
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

-- Create indexes
CREATE UNIQUE INDEX IF NOT EXISTS `readings_agg_5m_system_interval_idx` ON `readings_agg_5m` (`system_id`,`interval_end`);
CREATE INDEX IF NOT EXISTS `readings_agg_5m_system_id_idx` ON `readings_agg_5m` (`system_id`);
CREATE INDEX IF NOT EXISTS `readings_agg_5m_interval_end_idx` ON `readings_agg_5m` (`interval_end`);