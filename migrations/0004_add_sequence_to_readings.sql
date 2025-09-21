-- Migration: Add sequence field to readings table
-- Date: 2025-01-21
-- Purpose: Add a sequence field for Fronius push data to track unique readings

-- Add the sequence column to the readings table
ALTER TABLE readings ADD COLUMN sequence TEXT;

-- Note: The column is nullable by default, which is what we want since:
-- 1. Existing data won't have sequence values
-- 2. Only Fronius push data will provide sequences
-- 3. Poll-based systems don't need sequences