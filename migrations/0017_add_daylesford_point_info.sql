-- Add point_info records for Daylesford Selectronic system (system_id = 1)
-- point_sub_id matches the column name in the readings table

INSERT INTO point_info (system_id, id, point_id, point_sub_id, point_name, subsystem, type, subtype, extension, display_name, short_name, metric_type, metric_unit)
VALUES
  (1, 1, 'selectronic-1586', 'solar_w', 'Solar', 'solar', 'source', 'solar', NULL, 'Solar', 'solar_p', 'power', 'W'),
  (1, 2, 'selectronic-1586', 'solar_local_w', 'Solar Local', 'solar', 'source', 'solar', 'local', 'Solar Local', 'solar_local_p', 'power', 'W'),
  (1, 3, 'selectronic-1586', 'solar_remote_w', 'Solar Remote', 'solar', 'source', 'solar', 'remote', 'Solar Remote', 'solar_remote_p', 'power', 'W'),
  (1, 4, 'selectronic-1586', 'load_w', 'Load', 'load', 'load', NULL, NULL, 'Load', 'load_p', 'power', 'W'),
  (1, 5, 'selectronic-1586', 'battery_w', 'Battery', 'battery', 'bidi', 'battery', NULL, 'Battery', 'batt_p', 'power', 'W'),
  (1, 6, 'selectronic-1586', 'battery_soc', 'Battery', 'battery', NULL, NULL, NULL, 'Battery SOC', 'batt_soc', 'soc', '%'),
  (1, 7, 'selectronic-1586', 'grid_w', 'Grid', 'grid', 'bidi', 'grid', NULL, 'Grid', 'grid_p', 'power', 'W');

-- Track migration
INSERT INTO migrations (id) VALUES ('0017_add_daylesford_point_info');
