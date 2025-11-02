-- Backfill point_readings for Daylesford system from last 7 days of readings data
-- Creates point_readings entries for each monitored point in point_info

-- Calculate 7 days ago timestamp
-- For each point in point_info (system_id=1), create point_readings from readings table

-- Point 1: solar_w
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1 as system_id,
  1 as point_id,
  inverter_time * 1000 as measurement_time,
  received_time * 1000 as received_time,
  solar_w as value,
  CASE WHEN solar_w IS NULL THEN 'error' ELSE 'good' END as data_quality
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 2: solar_local_w
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 2, inverter_time * 1000, received_time * 1000, solar_local_w,
  CASE WHEN solar_local_w IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 3: solar_remote_w
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 3, inverter_time * 1000, received_time * 1000, solar_remote_w,
  CASE WHEN solar_remote_w IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 4: load_w
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 4, inverter_time * 1000, received_time * 1000, load_w,
  CASE WHEN load_w IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 5: battery_w
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 5, inverter_time * 1000, received_time * 1000, battery_w,
  CASE WHEN battery_w IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 6: battery_soc
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 6, inverter_time * 1000, received_time * 1000, battery_soc,
  CASE WHEN battery_soc IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 7: grid_w
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 7, inverter_time * 1000, received_time * 1000, grid_w,
  CASE WHEN grid_w IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 8: generator_status
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 8, inverter_time * 1000, received_time * 1000, generator_status,
  CASE WHEN generator_status IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 9: solar_kwh_total
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 9, inverter_time * 1000, received_time * 1000, solar_kwh_total,
  CASE WHEN solar_kwh_total IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 10: load_kwh_total
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 10, inverter_time * 1000, received_time * 1000, load_kwh_total,
  CASE WHEN load_kwh_total IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 11: battery_in_kwh_total
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 11, inverter_time * 1000, received_time * 1000, battery_in_kwh_total,
  CASE WHEN battery_in_kwh_total IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 12: battery_out_kwh_total
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 12, inverter_time * 1000, received_time * 1000, battery_out_kwh_total,
  CASE WHEN battery_out_kwh_total IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 13: grid_in_kwh_total
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 13, inverter_time * 1000, received_time * 1000, grid_in_kwh_total,
  CASE WHEN grid_in_kwh_total IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 14: grid_out_kwh_total
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 14, inverter_time * 1000, received_time * 1000, grid_out_kwh_total,
  CASE WHEN grid_out_kwh_total IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 15: fault_code (text field - store as error with message)
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, error, data_quality)
SELECT
  1, 15, inverter_time * 1000, received_time * 1000,
  NULL as value,
  fault_code as error,
  CASE WHEN fault_code IS NOT NULL AND fault_code != '' THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Point 16: fault_timestamp (convert to milliseconds)
INSERT INTO point_readings (system_id, point_id, measurement_time, received_time, value, data_quality)
SELECT
  1, 16, inverter_time * 1000, received_time * 1000,
  CASE WHEN fault_timestamp IS NOT NULL THEN fault_timestamp * 1000 ELSE NULL END as value,
  CASE WHEN fault_timestamp IS NULL THEN 'error' ELSE 'good' END
FROM readings
WHERE system_id = 1
  AND inverter_time > (SELECT MAX(inverter_time) - 7*24*60*60 FROM readings WHERE system_id = 1);

-- Track migration
INSERT INTO migrations (id) VALUES ('0019_backfill_daylesford_point_readings');
