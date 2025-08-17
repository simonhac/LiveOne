-- Populate the 5-minute aggregated table from existing readings (production schema)
-- This uses the correct column names from the production database

INSERT OR REPLACE INTO readings_agg_5m (
  system_id,
  interval_end,
  solar_w_avg,
  solar_w_min,
  solar_w_max,
  load_w_avg,
  load_w_min,
  load_w_max,
  battery_w_avg,
  battery_w_min,
  battery_w_max,
  grid_w_avg,
  grid_w_min,
  grid_w_max,
  battery_soc_last,
  solar_kwh_total_last,
  load_kwh_total_last,
  battery_in_kwh_total_last,
  battery_out_kwh_total_last,
  grid_in_kwh_total_last,
  grid_out_kwh_total_last,
  sample_count,
  created_at
)
SELECT 
  system_id,
  -- Round up to next 5-minute interval (inverter_time is already unix timestamp)
  ((inverter_time / 300) + 1) * 300 as interval_end,
  -- Power values (Watts) - round to integers
  ROUND(AVG(solar_w)) as solar_w_avg,
  ROUND(MIN(solar_w)) as solar_w_min,
  ROUND(MAX(solar_w)) as solar_w_max,
  ROUND(AVG(load_w)) as load_w_avg,
  ROUND(MIN(load_w)) as load_w_min,
  ROUND(MAX(load_w)) as load_w_max,
  ROUND(AVG(battery_w)) as battery_w_avg,
  ROUND(MIN(battery_w)) as battery_w_min,
  ROUND(MAX(battery_w)) as battery_w_max,
  ROUND(AVG(grid_w)) as grid_w_avg,
  ROUND(MIN(grid_w)) as grid_w_min,
  ROUND(MAX(grid_w)) as grid_w_max,
  -- Battery SOC (percentage) - round to 1 decimal place
  ROUND(MAX(battery_soc), 1) as battery_soc_last,
  -- Energy counters (kWh) - round to 3 decimal places
  ROUND(MAX(solar_kwh_total), 3) as solar_kwh_total_last,
  ROUND(MAX(load_kwh_total), 3) as load_kwh_total_last,
  ROUND(MAX(battery_in_kwh_total), 3) as battery_in_kwh_total_last,
  ROUND(MAX(battery_out_kwh_total), 3) as battery_out_kwh_total_last,
  ROUND(MAX(grid_in_kwh_total), 3) as grid_in_kwh_total_last,
  ROUND(MAX(grid_out_kwh_total), 3) as grid_out_kwh_total_last,
  COUNT(*) as sample_count,
  strftime('%s', 'now') as created_at
FROM readings
GROUP BY 
  system_id,
  inverter_time / 300  -- Group by 5-minute intervals (inverter_time is unix timestamp)
ORDER BY interval_end;