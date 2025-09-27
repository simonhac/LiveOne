-- Migration: Migrate point_groups references to systems table
-- Date: 2025-01-27
-- Purpose: Remove point_groups table and update all references to use systems table
-- Note: This is for existing dev databases that already have point_groups

-- ============================================================================
-- PART 1: Update foreign key references to use systems instead of point_groups
-- ============================================================================

-- Drop and recreate point_sub_groups with systems reference
CREATE TABLE point_sub_groups_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    group_id INTEGER NOT NULL,  -- Now references systems.id
    parent_sub_group_id INTEGER,
    vendor_id TEXT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    aggregation_type TEXT DEFAULT 'sum' NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL,
    polling_enabled INTEGER DEFAULT 1 NOT NULL,
    vendor_metadata TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    FOREIGN KEY (group_id) REFERENCES systems(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_sub_group_id) REFERENCES point_sub_groups_new(id) ON DELETE CASCADE
);

-- Copy data (assuming point_groups.id maps to systems.id)
INSERT INTO point_sub_groups_new (
    id,
    group_id,
    parent_sub_group_id,
    vendor_id,
    name,
    display_name,
    description,
    aggregation_type,
    status,
    polling_enabled,
    vendor_metadata,
    created_at,
    updated_at
)
SELECT
    id,
    group_id,
    parent_sub_group_id,
    vendor_id,
    name,
    display_name,
    description,
    aggregation_type,
    status,
    polling_enabled,
    vendor_metadata,
    created_at,
    updated_at
FROM point_sub_groups;

DROP TABLE point_sub_groups;
ALTER TABLE point_sub_groups_new RENAME TO point_sub_groups;

-- Recreate indexes
CREATE UNIQUE INDEX psg_group_vendor_unique ON point_sub_groups(group_id, vendor_id);
CREATE INDEX psg_group_idx ON point_sub_groups(group_id);
CREATE INDEX psg_parent_idx ON point_sub_groups(parent_sub_group_id);
CREATE INDEX psg_status_idx ON point_sub_groups(status);

-- Drop and recreate point_info with systems reference
CREATE TABLE point_info_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    group_id INTEGER NOT NULL,  -- Now references systems.id
    sub_group_id INTEGER,
    vendor_id TEXT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    point_type TEXT NOT NULL,
    device_type TEXT,
    measurement_types TEXT NOT NULL,
    units TEXT,
    status TEXT DEFAULT 'active' NOT NULL,
    last_seen_at INTEGER,
    polling_enabled INTEGER DEFAULT 1 NOT NULL,
    aggregation_enabled INTEGER DEFAULT 1 NOT NULL,
    vendor_metadata TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    FOREIGN KEY (group_id) REFERENCES systems(id) ON DELETE CASCADE,
    FOREIGN KEY (sub_group_id) REFERENCES point_sub_groups(id) ON DELETE SET NULL
);

-- Copy data
INSERT INTO point_info_new (
    id,
    group_id,
    sub_group_id,
    vendor_id,
    name,
    display_name,
    description,
    point_type,
    device_type,
    measurement_types,
    units,
    status,
    last_seen_at,
    polling_enabled,
    aggregation_enabled,
    vendor_metadata,
    created_at,
    updated_at
)
SELECT
    id,
    group_id,
    sub_group_id,
    vendor_id,
    name,
    display_name,
    description,
    point_type,
    device_type,
    measurement_types,
    units,
    status,
    last_seen_at,
    polling_enabled,
    aggregation_enabled,
    vendor_metadata,
    created_at,
    updated_at
FROM point_info;

DROP TABLE point_info;
ALTER TABLE point_info_new RENAME TO point_info;

-- Recreate indexes
CREATE UNIQUE INDEX pi_group_vendor_unique ON point_info(group_id, vendor_id);
CREATE INDEX pi_group_idx ON point_info(group_id);
CREATE INDEX pi_sub_group_idx ON point_info(sub_group_id);
CREATE INDEX pi_type_idx ON point_info(point_type);
CREATE INDEX pi_status_idx ON point_info(status);
CREATE INDEX pi_polling_idx ON point_info(polling_enabled);

-- Drop and recreate measurement_sessions with systems reference
CREATE TABLE measurement_sessions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    group_id INTEGER NOT NULL,  -- Now references systems.id
    session_type TEXT NOT NULL,
    started_at INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
    completed_at INTEGER,
    points_queried INTEGER DEFAULT 0 NOT NULL,
    points_success INTEGER DEFAULT 0 NOT NULL,
    points_failed INTEGER DEFAULT 0 NOT NULL,
    api_call_count INTEGER DEFAULT 0 NOT NULL,
    total_duration_ms INTEGER,
    error_messages TEXT,
    vendor_response_metadata TEXT,
    FOREIGN KEY (group_id) REFERENCES systems(id) ON DELETE CASCADE
);

-- Copy data
INSERT INTO measurement_sessions_new (
    id,
    group_id,
    session_type,
    started_at,
    completed_at,
    points_queried,
    points_success,
    points_failed,
    api_call_count,
    total_duration_ms,
    error_messages,
    vendor_response_metadata
)
SELECT
    id,
    group_id,
    session_type,
    started_at,
    completed_at,
    points_queried,
    points_success,
    points_failed,
    api_call_count,
    total_duration_ms,
    error_messages,
    vendor_response_metadata
FROM measurement_sessions;

DROP TABLE measurement_sessions;
ALTER TABLE measurement_sessions_new RENAME TO measurement_sessions;

-- Recreate indexes
CREATE INDEX ms_group_idx ON measurement_sessions(group_id);
CREATE INDEX ms_started_at_idx ON measurement_sessions(started_at);
CREATE INDEX ms_session_type_idx ON measurement_sessions(session_type);

-- ============================================================================
-- PART 2: Drop the point_groups table
-- ============================================================================

DROP TABLE IF EXISTS point_groups;

-- ============================================================================
-- Verification
-- ============================================================================

-- Check that point_groups is gone:
-- SELECT name FROM sqlite_master WHERE type='table' AND name = 'point_groups';

-- Verify foreign keys now reference systems:
-- SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('point_sub_groups', 'point_info', 'measurement_sessions');