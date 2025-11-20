
-- Migration: Remove PRIMARY KEY from migrations table to allow audit logging
-- This allows migrations to be run multiple times with each run logged

-- Step 1: Create new migrations table without PRIMARY KEY
CREATE TABLE IF NOT EXISTS migrations_new (
  id TEXT NOT NULL,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Step 2: Copy all existing migration records
INSERT INTO migrations_new SELECT * FROM migrations;

-- Step 3: Verify counts match - this will show the output
-- If counts don't match, STOP and investigate before running the DROP below
SELECT '=== Verification: Counts should match ===' as step;
SELECT
  (SELECT COUNT(*) FROM migrations) as old_count,
  (SELECT COUNT(*) FROM migrations_new) as new_count,
  CASE
    WHEN (SELECT COUNT(*) FROM migrations) = (SELECT COUNT(*) FROM migrations_new)
    THEN '✓ SAFE TO PROCEED'
    ELSE '✗ COUNTS MISMATCH - DO NOT PROCEED'
  END as status;

-- Step 4: ONLY RUN THIS AFTER VERIFYING COUNTS MATCH ABOVE
-- Wrap the destructive part in a transaction
BEGIN TRANSACTION;

DROP TABLE migrations;
ALTER TABLE migrations_new RENAME TO migrations;

COMMIT;

-- Track this migration (no more PRIMARY KEY, so regular INSERT)
INSERT INTO migrations (id) VALUES ('0046_remove_migrations_primary_key');
