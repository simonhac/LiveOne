# CLAUDE.md - Project Guidelines

## Important: Type Checking During Development

**Never kill or restart the dev server just to check compilation!**

- The dev server already runs `tsc --noEmit --watch` - it shows all TypeScript errors in real-time
- Look for `[1]` prefixed lines in the dev server output for TypeScript compilation status
- `[1] X:XX:XX pm - Found 0 errors` means TypeScript is happy
- `[1] X:XX:XX pm - Found N errors` means there are TypeScript issues

**Never run `npm run build` while the dev server is running** - it will interfere with the dev server.

To check TypeScript compilation:

1. **First choice**: Check the running dev server output (look for `[1]` lines)
2. **Second choice**: Run `npm run type-check` in a separate terminal (doesn't build, just checks types)
3. **Never**: Kill the dev server just to restart it to check compilation
4. **Never**: Run `npm run build` to check compilation

## Quick Reference

### Key Documentation

- **Database Schema**: See `docs/SCHEMA.md` for complete table documentation
- **API Documentation**: See `docs/API.md` for endpoint details
- **Database**: Turso (production: `liveone-tokyo`), SQLite (development: `dev.db`)
- **Deployment**: Vercel (automatic from main branch)

### Environment Variables

```bash
TURSO_DATABASE_URL=libsql://liveone-tokyo-simonhac.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=<your-token>  # Generate with: ~/.turso/turso db tokens create liveone-tokyo
```

## Testing Guidelines

- **Framework**: Use Jest for all tests (not Vitest or other frameworks)
- **Location**: Place test files in `__tests__` directories within the relevant module folder
  - Example: `lib/__tests__/date-utils.test.ts` for testing `lib/date-utils.ts`
  - Example: `app/api/__tests__/data.test.ts` for testing API routes
- **Naming conventions**:
  - **Unit tests**: `[name].test.ts` (e.g., `date-utils.test.ts`)
  - **Integration tests**: `[name].integration.test.ts` (e.g., `api.integration.test.ts`)
- **Test structure**: Import from `@jest/globals` for describe, it, expect
- **Running tests**:

  | Command                    | Description                | What it runs                                             |
  | -------------------------- | -------------------------- | -------------------------------------------------------- |
  | `npm test`                 | Run unit tests only        | All `*.test.ts` files, excluding `*.integration.test.ts` |
  | `npm run test:integration` | Run integration tests only | Only `*.integration.test.ts` files                       |
  | `npm run test:all`         | Run all tests              | Both unit and integration tests                          |
  | `npm test [pattern]`       | Run specific tests         | Tests matching the pattern (e.g., `npm test date-utils`) |
  | `npm run test:watch`       | Watch mode                 | Re-runs tests on file changes                            |
  | `npm run test:coverage`    | Coverage report            | Runs tests with coverage analysis                        |

- **Integration tests**:
  - Should test interactions with external services, databases, or multiple modules
  - Are excluded from the default `npm test` command to keep it fast
  - Should be named with `.integration.test.ts` suffix
  - May require additional setup/teardown or environment variables

## Development Scripts

### Common Commands

```bash
npm run dev              # Start development server with TypeScript checking
npm run build            # Build for production
npm run type-check       # Check TypeScript types
npm test                 # Run unit tests
npm run db:push          # Push schema changes to database
npm run db:studio        # Open Drizzle Studio for database exploration
```

### Database Sync (Development Only)

```bash
# Sync production data to development database
# NEVER run in production - has multiple safeguards
npm run db:sync-prod
```

### Scripts Directory

The project has utility scripts in `/scripts`:

- `/scripts/temp/` - Temporary scripts for one-off tasks
- `/scripts/utils/` - Reusable utility scripts

#### Authentication for Testing

```bash
# Generate a test session token for API testing (development only)
# Requires CLERK_SECRET_KEY in .env.local
npx tsx scripts/utils/get-test-token.ts

# This generates a Bearer token that authenticates as simon (admin)
# Use it with: curl -H "Authorization: Bearer <token>" http://localhost:3000/api/...
```

## Turso Database Management

### Quick Setup

```bash
# Install Turso CLI (one-time)
curl -sSfL https://get.tur.so/install.sh | bash
echo 'export PATH="$HOME/.turso:$PATH"' >> ~/.zshrc

# Authenticate
~/.turso/turso auth login

# Connect to production database
~/.turso/turso db shell liveone-tokyo
```

### Common Queries

#### Check Recent Data

```sql
-- Latest readings
SELECT datetime(inverter_time, 'unixepoch') as time,
       solar_w, load_w, battery_w, battery_soc
FROM readings
ORDER BY inverter_time DESC
LIMIT 5;

-- Check aggregation status
SELECT
  datetime(MAX(interval_end), 'unixepoch') as latest_agg,
  (strftime('%s', 'now') - MAX(interval_end)) / 60 as minutes_behind
FROM readings_agg_5m;
```

#### Data Health Checks

```sql
-- Check for duplicate timestamps
SELECT inverter_time, COUNT(*) as count
FROM readings
WHERE system_id = 1586
GROUP BY inverter_time
HAVING COUNT(*) > 1;

-- Find data gaps > 2 minutes
WITH time_diffs AS (
  SELECT
    inverter_time,
    LAG(inverter_time) OVER (ORDER BY inverter_time) as prev_time,
    inverter_time - LAG(inverter_time) OVER (ORDER BY inverter_time) as diff
  FROM readings
  WHERE system_id = 1586
)
SELECT
  datetime(prev_time, 'unixepoch') as gap_start,
  datetime(inverter_time, 'unixepoch') as gap_end,
  diff / 60 as gap_minutes
FROM time_diffs
WHERE diff > 120
ORDER BY inverter_time DESC
LIMIT 20;
```

### Backup & Restore

```bash
# Backup
turso db export liveone-tokyo > backup-$(date +%Y%m%d).sql

# Restore
turso db create liveone-restored --location hnd
turso db shell liveone-restored < backup-20250817.sql
```

## Database Migrations

### Overview

This project uses plain SQL migration files for database schema changes. Migrations are tracked in a `migrations` table to ensure they're only applied once per database.

### Migration File Structure

- **Location**: `/migrations/` directory
- **Naming**: `NNNN_description.sql` (e.g., `0016_composite_primary_keys_point_tables.sql`)
- **Format**: Plain SQL with migration tracking at the end

### Migration Tracking

Every migration should end with:

```sql
-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)  -- Unix timestamp in milliseconds
);

INSERT INTO migrations (id) VALUES ('0016_composite_primary_keys_point_tables');
```

The `migrations` table:

- `id`: Migration filename without `.sql` extension
- `applied_at`: Unix timestamp in milliseconds when migration was applied

### Creating a Migration

1. **Create the migration file** in `/migrations/` with sequential number:

   ```bash
   # Check latest migration number
   ls migrations/ | tail -1

   # Create new migration (e.g., 0017)
   touch migrations/0017_add_new_feature.sql
   ```

2. **Write the migration SQL**:

   ```sql
   -- Migration: Description of what this migration does

   -- Your schema changes here
   ALTER TABLE systems ADD COLUMN new_field TEXT;

   -- Track migration (always include this at the end)
   CREATE TABLE IF NOT EXISTS migrations (
     id TEXT PRIMARY KEY,
     applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
   );

   INSERT INTO migrations (id) VALUES ('0017_add_new_feature');
   ```

3. **Apply to development**:

   ```bash
   sqlite3 dev.db < migrations/0017_add_new_feature.sql
   ```

4. **Apply to production** (via Turso CLI):
   ```bash
   ~/.turso/turso db shell liveone-tokyo < migrations/0017_add_new_feature.sql
   ```

### Checking Migration Status

```bash
# List all applied migrations
sqlite3 dev.db "SELECT id, datetime(applied_at/1000, 'unixepoch') as applied FROM migrations ORDER BY applied_at"

# Check if specific migration was applied
sqlite3 dev.db "SELECT * FROM migrations WHERE id = '0017_add_new_feature'"
```

### Migration Safety Guidelines

**Critical lessons learned from migration 0016 (which lost 345K+ records):**

#### Before Running ANY Migration

1. **Always backup production first**:

   ```bash
   ./scripts/utils/backup-prod-db.sh
   # Verify backup is at least 6MB and contains expected data
   ls -lh db-backups/ | tail -1
   ```

2. **Test on a database copy**:

   ```bash
   # Extract backup to test database
   gunzip -c db-backups/liveone-tokyo-YYYYMMDD-HHMMSS.db.gz > /tmp/test.db

   # Test migration on copy
   sqlite3 /tmp/test.db < migrations/NNNN_migration.sql

   # Verify data integrity
   sqlite3 /tmp/test.db "SELECT COUNT(*) FROM critical_table"
   ```

#### Writing Safe Migrations

**Pattern for destructive migrations (CREATE new → DROP old → RENAME):**

```sql
-- Migration: Description

-- ALWAYS wrap in explicit transaction
BEGIN TRANSACTION;

-- Step 1: Create new table
CREATE TABLE table_name_new (
  -- new schema
);

-- Step 2: Copy data
INSERT INTO table_name_new SELECT * FROM table_name;

-- Step 3: VALIDATE before dropping (CRITICAL!)
-- This will abort if counts don't match
SELECT CASE
  WHEN (SELECT COUNT(*) FROM table_name) != (SELECT COUNT(*) FROM table_name_new)
  THEN RAISE(ABORT, 'Data copy failed - row count mismatch')
END;

-- Step 4: Only drop if we get here
DROP TABLE table_name;

-- Step 5: Rename
ALTER TABLE table_name_new RENAME TO table_name;

-- Step 6: Recreate indexes
CREATE INDEX idx_name ON table_name(column);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO migrations (id) VALUES ('NNNN_migration_name');
```

#### Why Migration 0016 Failed

The migration had INSERT...SELECT statements but **no validation** before dropping old tables:

1. ❌ No explicit `BEGIN TRANSACTION` at start
2. ❌ No row count validation after INSERT
3. ❌ Immediately dropped old table without checking copy succeeded
4. ❌ Foreign key constraints may have silently rejected rows
5. ❌ Not tested on production data copy first

Result: 345,456 point_readings lost, requiring 8+ hour restoration from backup.

#### Migration Checklist

- [ ] Backup production database
- [ ] Test migration on backup copy
- [ ] Migration wrapped in explicit `BEGIN TRANSACTION`
- [ ] Row count validation before DROP statements
- [ ] Idempotent (safe to run multiple times with `IF NOT EXISTS`, etc.)
- [ ] Foreign key constraints accounted for
- [ ] Indexes recreated after table operations
- [ ] Migration tracking at end
- [ ] Tested on development database
- [ ] Ready to restore from backup if needed

#### Other Notes

- **No Rollbacks**: This project doesn't use rollback migrations - if you need to undo a change, create a new forward migration
- **Composite Keys**: When creating foreign keys with composite primary keys, remember that SQLite doesn't update FK table references on `ALTER TABLE RENAME` - create tables with final names or use temporary tables
- **Run pre-checks**: Before complex migrations, check data volumes and estimate time required

## Vercel Deployment

### Build & Deploy

```bash
# Deploy to production
vercel --prod

# Check recent deployments
vercel ls

# View build logs
./scripts/vercel-build-log.sh
```

### Troubleshooting

**Build Failures**

1. Check TypeScript: `npm run type-check`
2. Test build locally: `npm run build`
3. View logs: `./scripts/vercel-build-log.sh`

**Type Errors with Drizzle**

- `select()` doesn't accept arguments in our version
- Use: `select()` then filter in JavaScript
- Example: `[...new Set(results.map(r => r.systemId))]`

**Database Access Patterns**

- **Drizzle ORM (`db`)**: Use for type-safe queries with Drizzle query builder
  - Example: `await db.select().from(systems).where(eq(systems.id, systemId))`
  - Does NOT have `.execute()` or `.all()` methods

- **Raw SQL queries (`rawClient`)**: Use for direct SQL execution (e.g., complex queries, migrations)
  - Import: `import { rawClient } from '@/lib/db'`
  - Example: `await rawClient.execute('SELECT COUNT(*) FROM readings')`
  - Returns `{ rows: [...], columns: [...] }` format
  - Use this when you need to run raw SQL queries that can't be expressed with Drizzle query builder

## Data Pipeline

1. **Collection**: Cron job polls vendor APIs every minute
2. **Storage**: Raw data → `readings` table
3. **5-Min Aggregation**: Real-time as data arrives
4. **Daily Aggregation**: Runs at 00:05 daily
5. **API**: Queries use pre-aggregated data (< 1s response)

### Manual Operations

```bash
# Trigger daily aggregation manually
curl -X POST https://liveone.vercel.app/api/cron/daily \
  -H "Cookie: auth-token=password" \
  -d '{"action": "catchup"}'  # or "clear" to regenerate
```

## Code Style & Conventions

- **TypeScript**: Strict mode enabled
- **Imports**: Use `@/` for root imports
- **Dates**: Store as Unix timestamps (UTC) in database
- **Power**: Store as integers (Watts)
- **Energy**: Store with 3 decimal places (kWh)
- **Test Scripts**: Save in `/scripts` directory

## Security

- Never commit auth tokens
- Use environment variables for secrets
- Rotate tokens periodically
- Limit database access to necessary operations
- Production safeguards in sync operations

## Performance Tips

1. Use indexes for time-based queries
2. Query aggregated tables for historical data
3. Batch inserts (max 100 records for SQLite)
4. Run `VACUUM` periodically
5. Use prepared statements for repeated queries

- when backing up prod, use @scripts/utils/backup-prod-db.sh and check that the file is at least 6MB in size
- don't use NPM run to check for typescript errors
