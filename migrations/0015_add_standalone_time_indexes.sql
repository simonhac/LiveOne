-- Add standalone indexes for time-based queries to improve COUNT(*) performance
-- These complement existing composite indexes for queries that don't filter by system_id

-- Add standalone index on point_readings.measurement_time
-- Improves: SELECT COUNT(*) FROM point_readings WHERE measurement_time > ?
CREATE INDEX IF NOT EXISTS pr_measurement_time_idx ON point_readings(measurement_time);

-- Add standalone index on point_readings_agg_5m.interval_end
-- Improves: SELECT COUNT(*) FROM point_readings_agg_5m WHERE interval_end > ?
CREATE INDEX IF NOT EXISTS pr5m_interval_end_idx ON point_readings_agg_5m(interval_end);
