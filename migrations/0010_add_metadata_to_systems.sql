-- Add metadata column to systems table
-- This will store JSON configuration for composite systems and other vendor-specific settings

ALTER TABLE systems ADD COLUMN metadata TEXT;
