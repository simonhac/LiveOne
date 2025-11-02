-- Add remaining point_info records for Daylesford Selectronic system (system_id = 1)
-- Includes: generator status, cumulative energy totals, and fault info

INSERT INTO point_info (system_id, id, point_id, point_sub_id, point_name, subsystem, type, subtype, extension, display_name, short_name, metric_type, metric_unit)
VALUES
  -- Generator status
  (1, 8, 'selectronic-1586', 'generator_status', 'Generator', NULL, NULL, NULL, NULL, 'Generator Status', 'gen_status', 'status', 'bool'),

  -- Cumulative energy totals
  (1, 9, 'selectronic-1586', 'solar_kwh_total', 'Solar', 'solar', 'source', 'solar', NULL, 'Solar Total', 'solar_e_total', 'energy', 'kWh'),
  (1, 10, 'selectronic-1586', 'load_kwh_total', 'Load', 'load', 'load', NULL, NULL, 'Load Total', 'load_e_total', 'energy', 'kWh'),
  (1, 11, 'selectronic-1586', 'battery_in_kwh_total', 'Battery In', 'battery', NULL, 'battery', 'in', 'Battery In Total', 'batt_in_e_total', 'energy', 'kWh'),
  (1, 12, 'selectronic-1586', 'battery_out_kwh_total', 'Battery Out', 'battery', NULL, 'battery', 'out', 'Battery Out Total', 'batt_out_e_total', 'energy', 'kWh'),
  (1, 13, 'selectronic-1586', 'grid_in_kwh_total', 'Grid In', 'grid', NULL, 'grid', 'in', 'Grid In Total', 'grid_in_e_total', 'energy', 'kWh'),
  (1, 14, 'selectronic-1586', 'grid_out_kwh_total', 'Grid Out', 'grid', NULL, 'grid', 'out', 'Grid Out Total', 'grid_out_e_total', 'energy', 'kWh'),

  -- Fault diagnostics
  (1, 15, 'selectronic-1586', 'fault_code', 'Fault', NULL, NULL, NULL, NULL, 'Fault Code', 'fault_code', 'diagnostic', 'text'),
  (1, 16, 'selectronic-1586', 'fault_timestamp', 'Fault', NULL, NULL, NULL, NULL, 'Fault Timestamp', 'fault_ts', 'diagnostic', 'timestamp');

-- Track migration
INSERT INTO migrations (id) VALUES ('0018_add_remaining_daylesford_points');
