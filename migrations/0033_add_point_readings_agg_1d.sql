-- Migration: Add daily aggregation table for point readings

-- Create daily aggregation table
CREATE TABLE point_readings_agg_1d (
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  point_id INTEGER NOT NULL,
  day TEXT NOT NULL,  -- YYYYMMDD format (system local timezone)

  -- Aggregated values (nullable if all readings were errors)
  avg REAL,  -- Average of 5-min averages
  min REAL,  -- Minimum of 5-min minimums
  max REAL,  -- Maximum of 5-min maximums
  last REAL, -- Value from 00:00 interval (last interval of previous day)
  delta REAL, -- Sum of 5-min deltas (for differentiated points with transform='d')

  -- Metadata
  sample_count INTEGER NOT NULL,  -- Total samples across all 5-min intervals
  error_count INTEGER NOT NULL,   -- Total errors across all 5-min intervals
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),  -- Unix timestamp in milliseconds
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),  -- Unix timestamp in milliseconds

  PRIMARY KEY (system_id, point_id, day),
  FOREIGN KEY (system_id, point_id) REFERENCES point_info(system_id, id) ON DELETE CASCADE
);

-- Create indexes for efficient querying
CREATE INDEX pr1d_system_day_idx ON point_readings_agg_1d(system_id, day);
CREATE INDEX pr1d_day_idx ON point_readings_agg_1d(day);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0033_add_point_readings_agg_1d');
