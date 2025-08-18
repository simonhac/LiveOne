-- Drop table if exists (for clean creation)
DROP TABLE IF EXISTS readings_agg_1d;

-- Create the daily aggregates table with complete schema
CREATE TABLE readings_agg_1d (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    system_id TEXT NOT NULL,
    day TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
    solar_kwh REAL,
    load_kwh REAL,
    battery_charge_kwh REAL,
    battery_discharge_kwh REAL,
    grid_import_kwh REAL,
    grid_export_kwh REAL,
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
    battery_soc_max REAL,
    battery_soc_min REAL,
    battery_soc_avg REAL,
    battery_soc_end REAL,
    solar_alltime_kwh REAL,
    load_alltime_kwh REAL,
    battery_charge_alltime_kwh REAL,
    battery_discharge_alltime_kwh REAL,
    grid_import_alltime_kwh REAL,
    grid_export_alltime_kwh REAL,
    interval_count INTEGER,
    version INTEGER DEFAULT 1
);

-- Create indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_agg_1d_system_day ON readings_agg_1d (system_id, day);
CREATE INDEX IF NOT EXISTS idx_readings_agg_1d_day ON readings_agg_1d (day);
CREATE INDEX IF NOT EXISTS idx_readings_agg_1d_updated ON readings_agg_1d (updated_at);