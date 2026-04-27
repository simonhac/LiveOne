-- Migration: Create share_tokens table for view-only access links

BEGIN TRANSACTION;

CREATE TABLE share_tokens (
  token TEXT PRIMARY KEY,
  owner_clerk_user_id TEXT NOT NULL,
  label TEXT,
  created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  last_used_at_ms INTEGER
);

CREATE INDEX share_tokens_owner_idx ON share_tokens(owner_clerk_user_id);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0062_share_tokens');
