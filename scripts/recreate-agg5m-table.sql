-- Drop and recreate the 5-minute aggregated table with correct data types

-- Drop existing table
DROP TABLE IF EXISTS readings_agg_5m;

-- Create table with proper data types matching source
CREATE TABLE readings_agg_5m (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  system_id INTEGER NOT NULL,
  interval_end INTEGER NOT NULL, -- Unix timestamp of interval end
  
  -- Power values (Watts) - stored as INTEGER like source
  solar_w_avg INTEGER,
  solar_w_min INTEGER,
  solar_w_max INTEGER,
  load_w_avg INTEGER,
  load_w_min INTEGER,
  load_w_max INTEGER,
  battery_w_avg INTEGER,
  battery_w_min INTEGER,
  battery_w_max INTEGER,
  grid_w_avg INTEGER,
  grid_w_min INTEGER,
  grid_w_max INTEGER,
  
  -- Battery SOC (percentage) - REAL with 1 decimal precision
  battery_soc_last REAL,
  
  -- Energy totals (kWh) - REAL with 3 decimal precision
  solar_kwh_total_last REAL,
  load_kwh_total_last REAL,
  battery_in_kwh_total_last REAL,
  battery_out_kwh_total_last REAL,
  grid_in_kwh_total_last REAL,
  grid_out_kwh_total_last REAL,
  
  -- Metadata
  sample_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Create indexes for performance
CREATE UNIQUE INDEX readings_agg_5m_system_interval_idx 
  ON readings_agg_5m (system_id, interval_end);

CREATE INDEX readings_agg_5m_system_id_idx 
  ON readings_agg_5m (system_id);

CREATE INDEX readings_agg_5m_interval_end_idx 
  ON readings_agg_5m (interval_end);