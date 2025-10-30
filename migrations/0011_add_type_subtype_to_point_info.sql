-- Add type and subtype columns to point_info table
-- Type is a dropdown (source, load, bidi) and subtype is free text

ALTER TABLE point_info ADD COLUMN type TEXT;
ALTER TABLE point_info ADD COLUMN subtype TEXT;
