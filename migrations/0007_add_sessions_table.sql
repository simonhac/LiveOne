-- Migration: Add sessions table
-- Date: 2025-09-28
-- Purpose: Add missing sessions table to production for tracking polling sessions
-- URGENT: This table is required for the cron job to work properly

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    session_label TEXT,
    system_id INTEGER NOT NULL,
    vendor_type TEXT NOT NULL,
    system_name TEXT NOT NULL,
    cause TEXT NOT NULL,
    started INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    successful INTEGER NOT NULL,
    error_code TEXT,
    error TEXT,
    response TEXT,
    num_rows INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
    FOREIGN KEY (system_id) REFERENCES systems(id) ON UPDATE no action ON DELETE cascade
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS sessions_system_idx ON sessions (system_id);
CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions (started);
CREATE INDEX IF NOT EXISTS sessions_cause_idx ON sessions (cause);

-- Verify the table was created
-- SELECT name FROM sqlite_master WHERE type='table' AND name='sessions';