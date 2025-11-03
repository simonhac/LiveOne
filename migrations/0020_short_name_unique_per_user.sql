-- Migration: Make short_name unique per user instead of globally unique
-- This allows different users to use the same short_name (e.g., "home", "office")
-- while preventing a single user from having duplicate short_names

-- Drop the old global unique index
DROP INDEX IF EXISTS short_name_unique;

-- Create a new composite unique index on (owner_clerk_user_id, short_name)
-- This makes short_name unique within each user's systems
CREATE UNIQUE INDEX short_name_unique ON systems(owner_clerk_user_id, short_name);

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)  -- Unix timestamp in milliseconds
);

INSERT INTO migrations (id) VALUES ('0020_short_name_unique_per_user');
