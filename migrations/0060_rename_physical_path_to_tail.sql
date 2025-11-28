-- Migration: Rename physical_path to physical_path_tail
-- Prepares for MQTT topic structure: liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}

BEGIN TRANSACTION;

-- Backup point_info table with timestamp
CREATE TABLE point_info_2024_11_28_1230 AS SELECT * FROM point_info;

-- Rename column
ALTER TABLE point_info RENAME COLUMN physical_path TO physical_path_tail;

-- Clean up redundant vendor prefixes
-- selectronic/xxx -> xxx (remove 12 chars: "selectronic/")
UPDATE point_info
SET physical_path_tail = SUBSTR(physical_path_tail, 13)
WHERE physical_path_tail LIKE 'selectronic/%';

-- fronius/xxx -> xxx (remove 8 chars: "fronius/")
UPDATE point_info
SET physical_path_tail = SUBSTR(physical_path_tail, 9)
WHERE physical_path_tail LIKE 'fronius/%';

-- enphase/xxx -> xxx (remove 8 chars: "enphase/")
UPDATE point_info
SET physical_path_tail = SUBSTR(physical_path_tail, 9)
WHERE physical_path_tail LIKE 'enphase/%';

-- Recreate unique index with new column name
DROP INDEX IF EXISTS idx_point_info_system_physical;
CREATE UNIQUE INDEX idx_point_info_system_physical ON point_info(system_id, physical_path_tail);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('0060_rename_physical_path_to_tail');
