-- Migration: Rename power columns from _power to _w and convert from REAL to INTEGER
-- This migration preserves data by rounding float values to nearest integer

-- Step 1: Add new integer columns with _w suffix
ALTER TABLE readings ADD COLUMN solar_w INTEGER;
ALTER TABLE readings ADD COLUMN solar_inverter_w INTEGER;
ALTER TABLE readings ADD COLUMN shunt_w INTEGER;
ALTER TABLE readings ADD COLUMN load_w INTEGER;
ALTER TABLE readings ADD COLUMN battery_w INTEGER;
ALTER TABLE readings ADD COLUMN grid_w INTEGER;

-- Step 2: Copy data from old columns to new columns, rounding to nearest integer
UPDATE readings 
SET 
    solar_w = ROUND(solar_power),
    solar_inverter_w = ROUND(solar_inverter_power),
    shunt_w = ROUND(shunt_power),
    load_w = ROUND(load_power),
    battery_w = ROUND(battery_power),
    grid_w = ROUND(grid_power)
WHERE solar_w IS NULL;

-- Step 3: Drop unused aggregate tables
DROP TABLE IF EXISTS hourly_aggregates;
DROP TABLE IF EXISTS daily_aggregates;

-- Step 4: Verify the migration
SELECT 
    COUNT(*) as total_rows,
    COUNT(solar_w) as migrated_rows,
    MIN(solar_w) as min_solar_w,
    MAX(solar_w) as max_solar_w,
    AVG(solar_w) as avg_solar_w
FROM readings;

-- Note: Old columns are preserved for now as backup
-- To drop them later, run:
-- ALTER TABLE readings DROP COLUMN solar_power;
-- ALTER TABLE readings DROP COLUMN solar_inverter_power;
-- ALTER TABLE readings DROP COLUMN shunt_power;
-- ALTER TABLE readings DROP COLUMN load_power;
-- ALTER TABLE readings DROP COLUMN battery_power;
-- ALTER TABLE readings DROP COLUMN grid_power;