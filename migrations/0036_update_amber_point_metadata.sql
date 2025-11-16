-- Migration: Update Amber Electric point metadata
-- Updates originSubId to include extension prefix and simplifies defaultName

BEGIN TRANSACTION;

-- Update Amber points to new naming convention
-- Pattern: ${extension}_${apiField} for originSubId, simplified defaultName
-- Uses JOIN with systems table to identify Amber systems by vendor_type

-- Grid import energy: energy → import_kwh
UPDATE point_info
SET origin_sub_id = 'import_kwh',
    point_name = 'Grid import',
    display_name = 'Grid import'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'import'
    AND pi.metric_type = 'energy'
    AND pi.origin_sub_id = 'energy'
);

-- Grid export energy: energy → export_kwh
UPDATE point_info
SET origin_sub_id = 'export_kwh',
    point_name = 'Grid export',
    display_name = 'Grid export'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'export'
    AND pi.metric_type = 'energy'
    AND pi.origin_sub_id = 'energy'
);

-- Grid import cost: cost → import_cost
UPDATE point_info
SET origin_sub_id = 'import_cost',
    point_name = 'Grid import',
    display_name = 'Grid import'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'import'
    AND pi.metric_type = 'value'
    AND pi.origin_sub_id = 'cost'
);

-- Grid export cost (was revenue): revenue → export_cost
UPDATE point_info
SET origin_sub_id = 'export_cost',
    point_name = 'Grid export',
    display_name = 'Grid export'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'export'
    AND pi.metric_type = 'value'
    AND pi.origin_sub_id = 'revenue'
);

-- Grid import price: price → import_perKwh
UPDATE point_info
SET origin_sub_id = 'import_perKwh',
    point_name = 'Grid import',
    display_name = 'Grid import'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'import'
    AND pi.metric_type = 'rate'
    AND pi.origin_sub_id = 'price'
);

-- Grid export price: price → export_perKwh
UPDATE point_info
SET origin_sub_id = 'export_perKwh',
    point_name = 'Grid export',
    display_name = 'Grid export'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'export'
    AND pi.metric_type = 'rate'
    AND pi.origin_sub_id = 'price'
);

-- Controlled load energy (if exists): energy → controlled_kwh
UPDATE point_info
SET origin_sub_id = 'controlled_kwh',
    point_name = 'Controlled load',
    display_name = 'Controlled load'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'controlled'
    AND pi.metric_type = 'energy'
    AND pi.origin_sub_id = 'energy'
);

-- Controlled load cost (if exists): cost → controlled_cost
UPDATE point_info
SET origin_sub_id = 'controlled_cost',
    point_name = 'Controlled load',
    display_name = 'Controlled load'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'controlled'
    AND pi.metric_type = 'value'
    AND pi.origin_sub_id = 'cost'
);

-- Controlled load price (if exists): price → controlled_perKwh
UPDATE point_info
SET origin_sub_id = 'controlled_perKwh',
    point_name = 'Controlled load',
    display_name = 'Controlled load'
WHERE id IN (
  SELECT pi.id
  FROM point_info pi
  JOIN systems s ON pi.system_id = s.id
  WHERE s.vendor_type = 'amber'
    AND pi.subsystem = 'grid'
    AND pi.type = 'bidi'
    AND pi.subtype = 'grid'
    AND pi.extension = 'controlled'
    AND pi.metric_type = 'rate'
    AND pi.origin_sub_id = 'price'
);

-- renewables and spotPerKwh don't need updating (already correct)

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0036_update_amber_point_metadata');
