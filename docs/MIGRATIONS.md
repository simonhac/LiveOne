# Database Migrations

This project uses plain SQL migration files for database schema changes. See also `CLAUDE.md` for the migration checklist.

## File Structure

- **Location**: `/migrations/` directory
- **Naming**: `NNNN_description.sql` (e.g., `0056_add_snapshot_hour.sql`)
- **Format**: Plain SQL with migration tracking at the end

## Migration Template

```sql
-- Migration: Brief description of what this migration does
--
-- Details:
-- - What changes are being made
-- - Why these changes are needed

-- Your schema changes here
ALTER TABLE example ADD COLUMN new_field TEXT;

-- Or for table recreation (see below for safe pattern)

-- Track migration (always include at end)
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('NNNN_description');
```

## SQLite Limitations

### RAISE() Only Works in Triggers

**Problem**: `RAISE(ABORT, 'message')` only works inside trigger programs, NOT in regular SELECT statements.

```sql
-- THIS DOES NOT WORK in SQLite outside of triggers:
SELECT CASE
  WHEN (SELECT COUNT(*) FROM old_table) != (SELECT COUNT(*) FROM new_table)
  THEN RAISE(ABORT, 'Row count mismatch')
END;
-- Error: RAISE() may only be used within a trigger-program
```

**Solution**: Validate row counts after migration via application code or manual verification, not in the SQL itself.

### No Transactional DDL for All Operations

SQLite's transaction support for DDL (CREATE, DROP, ALTER) is limited:

- `CREATE TABLE` and `DROP TABLE` work in transactions
- But `ALTER TABLE ... RENAME` commits implicitly in some cases

**Best practice**: Don't rely on `BEGIN TRANSACTION` / `COMMIT` to roll back failed migrations. Instead, verify the migration worked after running it.

## Safe Table Recreation Pattern

When you need to change a primary key or make schema changes that ALTER TABLE can't handle:

```sql
-- 1. Create new table with desired schema
CREATE TABLE example_new (
  id INTEGER PRIMARY KEY,
  new_column TEXT NOT NULL,
  -- ... rest of schema
);

-- 2. Copy data from old table
INSERT INTO example_new SELECT
  id,
  COALESCE(old_column, 'default_value'),
  -- ... handle each column
FROM example;

-- 3. Drop old table
DROP TABLE example;

-- 4. Rename new table
ALTER TABLE example_new RENAME TO example;

-- 5. Recreate any indexes
CREATE INDEX idx_example_column ON example(column);

-- 6. Track migration
INSERT INTO migrations (id) VALUES ('NNNN_migration_name');
```

**Important**: After running, verify the row count matches expectations manually.

## Running Migrations

### Development

```bash
sqlite3 dev.db < migrations/NNNN_migration.sql
```

### Production (Turso)

```bash
~/.turso/turso db shell liveone-tokyo < migrations/NNNN_migration.sql
```

## Checking Migration Status

```bash
# List applied migrations
sqlite3 dev.db "SELECT id, datetime(applied_at/1000, 'unixepoch') as applied FROM migrations ORDER BY applied_at"

# Check if specific migration was applied
sqlite3 dev.db "SELECT * FROM migrations WHERE id = 'NNNN_migration_name'"

# For production
~/.turso/turso db shell liveone-tokyo "SELECT id FROM migrations ORDER BY id"
```

## Pre-Migration Checklist

1. **Backup production** before any migration
2. **Test on dev** first
3. **Verify row counts** before and after
4. **Check indexes** are recreated if needed
5. **Update application code** to use new schema

## Lessons Learned

### Migration 0016: Lost 345K records

- INSERT...SELECT without validation before DROP
- No explicit transaction
- Foreign key constraints silently rejected rows

### Migration 0056: RAISE() doesn't work

- Attempted to use `RAISE(ABORT, ...)` in SELECT for validation
- SQLite only allows RAISE in trigger programs
- Solution: Remove validation from SQL, verify manually
