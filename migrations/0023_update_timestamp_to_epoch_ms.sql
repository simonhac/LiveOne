-- Migration: Update timestamp points to epochMs
-- Changes metricUnit from "timestamp" to "epochMs" for fault timestamp points
-- This reflects that these values are stored as milliseconds since epoch

UPDATE point_info
SET metric_unit = 'epochMs'
WHERE origin_sub_id IN ('fault_ts', 'faultTimestamp')
  AND metric_unit = 'timestamp';

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0023_update_timestamp_to_epoch_ms');
