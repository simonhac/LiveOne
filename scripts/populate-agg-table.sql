-- Populate the 5-minute aggregated table from existing readings
-- This uses the actual column names from the database

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
  AVG(solar_power) as solar_w_avg,
  MIN(solar_power) as solar_w_min,
  MAX(solar_power) as solar_w_max,
  AVG(load_power) as load_w_avg,
  MIN(load_power) as load_w_min,
  MAX(load_power) as load_w_max,
  AVG(battery_power) as battery_w_avg,
  MIN(battery_power) as battery_w_min,
  MAX(battery_power) as battery_w_max,
  AVG(grid_power) as grid_w_avg,
  MIN(grid_power) as grid_w_min,
  MAX(grid_power) as grid_w_max,
  -- For SOC and kWh totals, take the last value in each interval
  MAX(battery_soc) as battery_soc_last,
  MAX(solar_kwh_total) as solar_kwh_total_last,
  MAX(load_kwh_total) as load_kwh_total_last,
  MAX(battery_in_kwh_total) as battery_in_kwh_total_last,
  MAX(battery_out_kwh_total) as battery_out_kwh_total_last,
  MAX(grid_in_kwh_total) as grid_in_kwh_total_last,
  MAX(grid_out_kwh_total) as grid_out_kwh_total_last,
  COUNT(*) as sample_count,
  strftime('%s', 'now') as created_at
FROM readings
GROUP BY 
  system_id,
  inverter_time / 300  -- Group by 5-minute intervals (inverter_time is unix timestamp)
ORDER BY interval_end;