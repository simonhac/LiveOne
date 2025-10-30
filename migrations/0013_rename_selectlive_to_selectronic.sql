-- Migration: Rename vendor_type from 'select.live' to 'selectronic'
-- Date: 2025-10-30
-- Description: Standardize vendor naming - select.live is the website name, selectronic is the vendor name
--
-- This migration updates:
-- 1. systems table - vendor_type column
-- 2. sessions table - vendor_type column
--
-- IMPORTANT: Run this on production database after deploying code changes

-- Start transaction
BEGIN TRANSACTION;

-- Update systems table
UPDATE systems
SET vendor_type = 'selectronic'
WHERE vendor_type = 'select.live';

-- Update sessions table (historical data)
UPDATE sessions
SET vendor_type = 'selectronic'
WHERE vendor_type = 'select.live';

-- Verify the changes
SELECT 'Systems migrated:', COUNT(*) FROM systems WHERE vendor_type = 'selectronic';
SELECT 'Sessions migrated:', COUNT(*) FROM sessions WHERE vendor_type = 'selectronic';
SELECT 'Remaining select.live in systems:', COUNT(*) FROM systems WHERE vendor_type = 'select.live';
SELECT 'Remaining select.live in sessions:', COUNT(*) FROM sessions WHERE vendor_type = 'select.live';

-- Commit transaction
COMMIT;
