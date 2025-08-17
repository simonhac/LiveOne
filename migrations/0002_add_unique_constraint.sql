-- Migration to add unique constraint on readings table
-- This prevents duplicate readings for the same system at the same time

-- First, clean up any existing duplicates
DELETE FROM readings
WHERE id NOT IN (
  SELECT MIN(id)
  FROM readings
  GROUP BY system_id, inverter_time
);

-- Add unique index to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS readings_system_inverter_time_unique 
  ON readings (system_id, inverter_time);