-- Migration: Add display_timezone field to systems table
-- This field stores the IANA timezone string for display purposes (e.g., 'Australia/Melbourne')
-- Unlike timezoneOffsetMin (used for backend processes), displayTimezone observes DST

BEGIN TRANSACTION;

-- Add display_timezone column to systems table
ALTER TABLE systems ADD COLUMN display_timezone TEXT;

-- Set all existing systems to Australia/Melbourne
UPDATE systems SET display_timezone = 'Australia/Melbourne';

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0041_add_display_timezone');
