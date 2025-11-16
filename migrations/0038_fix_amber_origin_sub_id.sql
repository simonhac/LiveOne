-- Migration: Fix originSubId for Amber Electric system-level points
-- Remove channel-specific prefixes (export_, import_) from renewables, spot price, and tariff period points
-- These are system-level metrics that apply to the whole system, not specific channels

-- Update renewables point
UPDATE point_info
SET origin_sub_id = 'renewables'
WHERE origin_id = 'grid'
  AND (origin_sub_id = 'export_renewables' OR origin_sub_id = 'import_renewables');

-- Update spot price point
UPDATE point_info
SET origin_sub_id = 'spotPerKwh'
WHERE origin_id = 'grid'
  AND (origin_sub_id = 'export_spotPerKwh' OR origin_sub_id = 'import_spotPerKwh');

-- Update tariff period point
UPDATE point_info
SET origin_sub_id = 'tariffPeriod'
WHERE origin_id = 'grid'
  AND (origin_sub_id = 'export_tariffPeriod' OR origin_sub_id = 'import_tariffPeriod');

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0038_fix_amber_origin_sub_id');
