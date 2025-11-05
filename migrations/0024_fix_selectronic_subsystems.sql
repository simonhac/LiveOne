-- Migration: Fix subsystem and metadata for Selectronic diagnostic and generator points

-- Update fault_code: subsystem = 'system', point_name = 'Fault Code', metric_type = 'code', metric_unit = 'text'
UPDATE point_info
SET
  subsystem = 'system',
  point_name = 'Fault Code',
  metric_type = 'code',
  metric_unit = 'text'
WHERE origin_id = 'selectronic'
  AND origin_sub_id = 'fault_code';

-- Update fault_ts: subsystem = 'system', point_name = 'Fault Time', metric_type = 'time'
UPDATE point_info
SET
  subsystem = 'system',
  point_name = 'Fault Time',
  metric_type = 'time'
WHERE origin_id = 'selectronic'
  AND origin_sub_id = 'fault_ts';

-- Update gen_status: subsystem = 'generator', point_name = 'Generator Status', metric_type = 'active'
UPDATE point_info
SET
  subsystem = 'generator',
  point_name = 'Generator Status',
  metric_type = 'active'
WHERE origin_id = 'selectronic'
  AND origin_sub_id = 'gen_status';

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)  -- Unix timestamp in milliseconds
);

INSERT INTO migrations (id) VALUES ('0024_fix_selectronic_subsystems');
