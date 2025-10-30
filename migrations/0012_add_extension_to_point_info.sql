-- Add extension column to point_info table
-- Extension is free text for additional classification

ALTER TABLE point_info ADD COLUMN extension TEXT;
