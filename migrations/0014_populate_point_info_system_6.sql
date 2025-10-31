-- Migration: Populate type, subtype, and extension for system 6 point_info
-- Date: 2025-10-31
-- Description: Copy taxonomy data from dev system 10 to prod system 6
--
-- This migration updates the point_info table for system 6 with taxonomy data
-- (type, subtype, extension) based on the configuration from system 10 on dev.
--

-- Start transaction
BEGIN TRANSACTION;

-- Tesla EV charger (8fb1e79b-82a2-4447-a217-ad12e0acca16) - energyNowW only
UPDATE point_info
SET type = 'load', subtype = 'ev', extension = NULL
WHERE system_id = 6 AND point_id = '8fb1e79b-82a2-4447-a217-ad12e0acca16' AND point_sub_id = 'energyNowW';

-- Heat Pump (79cb48d6-bcd8-4055-b89a-93a53ab80226) - energyNowW only
UPDATE point_info
SET type = 'load', subtype = 'hws', extension = NULL
WHERE system_id = 6 AND point_id = '79cb48d6-bcd8-4055-b89a-93a53ab80226' AND point_sub_id = 'energyNowW';

-- Update display name for totalEnergyWh to 'HWS'
UPDATE point_info
SET display_name = 'HWS'
WHERE system_id = 6 AND point_id = '79cb48d6-bcd8-4055-b89a-93a53ab80226' AND point_sub_id = 'totalEnergyWh';

-- Update display name for energyNowW to 'EV'
UPDATE point_info
SET display_name = 'EV'
WHERE system_id = 6 AND point_id = '8fb1e79b-82a2-4447-a217-ad12e0acca16' AND point_sub_id = 'totalEnergyWh';

-- Pool (6ddf41bc-7a1e-4252-a6ae-78205b057662) - energyNowW only
UPDATE point_info
SET type = 'load', subtype = 'pool', extension = NULL
WHERE system_id = 6 AND point_id = '6ddf41bc-7a1e-4252-a6ae-78205b057662' AND point_sub_id = 'energyNowW';

-- Solar 2 (fccfe689-5402-4311-9cdc-713a9d6a2339) - energyNowW only
UPDATE point_info
SET type = 'source', subtype = 'solar', extension = 'remote'
WHERE system_id = 6 AND point_id = 'fccfe689-5402-4311-9cdc-713a9d6a2339' AND point_sub_id = 'energyNowW';

-- Battery Storage (ddd29e41-a615-4214-97e0-ab00663b8c4d) - energyNowW only
UPDATE point_info
SET type = 'bidi', subtype = 'battery', extension = NULL
WHERE system_id = 6 AND point_id = 'ddd29e41-a615-4214-97e0-ab00663b8c4d' AND point_sub_id = 'energyNowW';

-- HVAC (cce8d2ca-cafd-4d44-8995-948577f639d4) - energyNowW only
UPDATE point_info
SET type = 'load', subtype = 'hvac', extension = NULL
WHERE system_id = 6 AND point_id = 'cce8d2ca-cafd-4d44-8995-948577f639d4' AND point_sub_id = 'energyNowW';

-- Meter / Grid (b3ce3208-a657-45a7-b7ae-a54d35efd0c7) - energyNowW only
UPDATE point_info
SET type = 'bidi', subtype = 'grid', extension = NULL
WHERE system_id = 6 AND point_id = 'b3ce3208-a657-45a7-b7ae-a54d35efd0c7' AND point_sub_id = 'energyNowW';

-- Update display name for energyNowW to 'Grid'
UPDATE point_info
SET display_name = 'Grid'
WHERE system_id = 6 AND point_id = 'b3ce3208-a657-45a7-b7ae-a54d35efd0c7' AND point_sub_id = 'energyNowW';

-- Battery Inverter (5ecacac2-3cc3-447a-b3b5-423e333031e6) - no taxonomy on dev, leave NULL

-- Solar 1 (19978c75-9ce4-4f5c-9cf6-f488129d95f1) - energyNowW only
UPDATE point_info
SET type = 'source', subtype = 'solar', extension = 'local'
WHERE system_id = 6 AND point_id = '19978c75-9ce4-4f5c-9cf6-f488129d95f1' AND point_sub_id = 'energyNowW';

-- Verify the changes
SELECT
  'Point Info Updated:' as label,
  point_id,
  point_sub_id,
  display_name,
  type,
  subtype,
  extension
FROM point_info
WHERE system_id = 6 AND type IS NOT NULL
ORDER BY point_id, point_sub_id;

-- Count updated records
SELECT 'Total records with taxonomy:', COUNT(*)
FROM point_info
WHERE system_id = 6 AND type IS NOT NULL;

-- Commit transaction
COMMIT;
