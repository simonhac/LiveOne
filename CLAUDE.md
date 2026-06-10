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

- **Docs index**: `docs/README.md` — start here; canonical docs are `docs/architecture/overview.md` and `docs/architecture/engine-web-separation.md`
- **Data Model**: See `docs/architecture/data-model.md` (semantics/invariants); schema source of truth is `lib/db/planetscale/schema.ts`
- **API Documentation**: See `docs/architecture/api.md` for conventions and route inventory
- **Database (primary)**: PostgreSQL on PlanetScale — prod = `sydney` branch (`aws-ap-southeast-2`), dev = shared PlanetScale dev branch
- **Database (legacy)**: Turso `liveone-tokyo` — transitional raw+sessions backup until migration Phase 5; local SQLite `dev.db` for the legacy dev paths. Migration state: `docs/turso-pg-migration.md`
- **Deployment**: Vercel (automatic from main branch; region `syd1`)

### Environment Variables

```bash
# PostgreSQL (PlanetScale) - PRIMARY database
PLANETSCALE_DATABASE_URL=<runtime connection string>           # dev: dev branch; prod: sydney branch
PLANETSCALE_DATABASE_URL_MIGRATIONS=<DDL connection string>    # for npm run db:pg:migrate (or discrete DB_* vars)
PLANETSCALE_PRODUCTION_HOST=<prod host>                        # arms the dev guardrail (assertNotProdDbInDev)
# ALLOW_PROD_DB_IN_DEV=true                                    # escape hatch for the guardrail - use deliberately
# PLANETSCALE_POOL_MAX=10                                      # optional pool size

# Turso (LEGACY backup - until migration Phase 5)
TURSO_DATABASE_URL=libsql://liveone-tokyo-simonhac.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=<your-token>  # Generate with: ~/.turso/turso db tokens create liveone-tokyo

# Vercel KV (for latest point values cache)
KV_REST_API_URL=<your-kv-url>
KV_REST_API_TOKEN=<your-kv-token>
```

#### Setting up Vercel KV

The application uses Vercel KV to cache the latest point values for fast retrieval. Follow these steps to set up:

1. **Create KV databases in Vercel dashboard**:
   - Development: `liveone-kv-dev`
   - Production: `liveone-kv-prod`

2. **Get credentials from Vercel dashboard**:
   - Go to your project → Storage → Your KV database
   - Copy `KV_REST_API_URL` and `KV_REST_API_TOKEN`

3. **Add to `.env.local` (development)**:

   ```bash
   KV_REST_API_URL=https://your-kv-instance.kv.vercel-storage.com
   KV_REST_API_TOKEN=your-token-here
   ```

4. **Add to Vercel project settings (production)**:
   - Go to project settings → Environment Variables
   - Add both `KV_REST_API_URL` and `KV_REST_API_TOKEN`

5. **Build subscription registry** (one-time setup):
   ```bash
   # After first deployment, call this to build the composite system subscription registry:
   curl -X POST https://your-app.vercel.app/api/admin/kv/build-registry \
     -H "Authorization: Bearer <your-token>"
   ```

**Note**: The KV cache will gracefully degrade if not configured (warnings in logs but no errors).

### Git Best Practices

- **NEVER push directly to `main`** - All changes land via a pull request. Push your branch and open a PR (`gh pr create --base main`); never `git push origin <branch>:main` or commit straight onto `main`, even for hotfixes/cutovers. No exceptions.
- **Never discard uncommitted changes with `git restore`** - Always use `git stash` instead to preserve work
- If you need to temporarily set aside changes: `git stash push -m "description"`
- To restore stashed changes: `git stash pop` or `git stash apply`
- Lesson learned: `git restore` permanently deletes uncommitted work and it cannot be recovered

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
npm run db:pg:generate   # Diff PG schema.ts -> new migration in /drizzle-planetscale/
npm run db:pg:migrate    # Apply pending PG migrations
npm run db:push          # Push schema changes to the SQLite/Turso dev DB (legacy; NEVER for PG)
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

#### Development API Authentication

In development mode, you can bypass Clerk authentication for API testing by using the `x-claude` header:

```bash
# Use x-claude header to authenticate as admin (development only)
curl -H "x-claude: true" http://localhost:3000/api/admin/storage

# Example: trigger db-stats cron job
curl -H "x-claude: true" http://localhost:3000/api/cron/db-stats
```

**Note**: The value must be exactly `"true"` (not `"1"` or other truthy values). This header only works in development mode.

## Database Management

### PostgreSQL (primary)

```bash
# Connect with psql (dev branch, from .env.local)
psql "$PLANETSCALE_DATABASE_URL"
# Production (sydney branch): use the prod connection string deliberately
```

PG uses **native UTC timestamps** (no epoch-ms conversion needed):

```sql
-- Latest point readings
SELECT pr.measurement_time, pi.display_name, pr.value
FROM point_readings pr
JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
WHERE pr.system_id = 1
ORDER BY pr.measurement_time DESC
LIMIT 10;

-- 5-min aggregation lag (minutes behind now)
SELECT MAX(interval_end) AS latest_agg,
       EXTRACT(EPOCH FROM (now() AT TIME ZONE 'UTC' - MAX(interval_end))) / 60 AS minutes_behind
FROM point_readings_agg_5m;

-- Approximate row counts (instant; never COUNT(*) the big tables)
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;
```

**PG backups:** PITR schedules are database-wide, set in the PlanetScale dashboard (currently 12h-keep-2d immutable + 3-day-keep-6mo); `pscale backup create` makes a one-off base backup.

**PG migrations:** `npm run db:pg:generate` / `npm run db:pg:migrate` — **never `drizzle-kit push`**. See `drizzle-planetscale/README.md`.

### Turso (legacy backup — until migration Phase 5)

#### Quick Setup

```bash
# Install Turso CLI (one-time)
curl -sSfL https://get.tur.so/install.sh | bash
echo 'export PATH="$HOME/.turso:$PATH"' >> ~/.zshrc

# Authenticate
~/.turso/turso auth login

# Connect to production database
~/.turso/turso db shell liveone-tokyo
```

#### Common Queries (SQLite — timestamps are epoch-ms)

> ⚠️ **Never `COUNT(*)` (or run any full-table scan/aggregate) on the big tables** — `point_readings` (~13M rows), `point_readings_agg_5m` (~3M), `sessions` (~870K). It's slow and almost never what you actually need.
>
> - **Approximate row counts:** Postgres → `SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC` (planner estimate, instant). SQLite/Turso has no cheap exact count — don't try to get one.
> - **Presence / recency / "is it current":** use an indexed `ORDER BY <indexed col> DESC LIMIT 1` — e.g. `SELECT MAX(measurement_time) FROM point_readings` or `SELECT 1 FROM <table> LIMIT 1`. This is how you verify a snapshot/backup has data, too.
> - **Exact `COUNT(*)` is fine** only on the small config tables: `systems`, `point_info`, `users`, `user_systems`, `polling_status`, `share_tokens`.

##### Check Recent Data

```sql
-- Latest point readings (timestamps in milliseconds)
SELECT
  datetime(pr.measurement_time / 1000, 'unixepoch') as time,
  pi.display_name,
  pr.value
FROM point_readings pr
JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
WHERE pr.system_id = 1
ORDER BY pr.measurement_time DESC
LIMIT 10;

-- Check 5-min aggregation status
SELECT
  datetime(MAX(interval_end) / 1000, 'unixepoch') as latest_agg,
  (strftime('%s', 'now') * 1000 - MAX(interval_end)) / 60000 as minutes_behind
FROM point_readings_agg_5m;
```

##### Data Health Checks

```sql
-- Check for duplicate timestamps in point_readings
SELECT measurement_time, COUNT(*) as count
FROM point_readings
WHERE system_id = 1 AND point_id = 0
GROUP BY measurement_time
HAVING COUNT(*) > 1;

-- Find data gaps > 10 minutes (point_readings uses ms)
WITH time_diffs AS (
  SELECT
    measurement_time,
    LAG(measurement_time) OVER (ORDER BY measurement_time) as prev_time,
    measurement_time - LAG(measurement_time) OVER (ORDER BY measurement_time) as diff_ms
  FROM point_readings
  WHERE system_id = 1 AND point_id = 0
)
SELECT
  datetime(prev_time / 1000, 'unixepoch') as gap_start,
  datetime(measurement_time / 1000, 'unixepoch') as gap_end,
  diff_ms / 60000 as gap_minutes
FROM time_diffs
WHERE diff_ms > 600000
ORDER BY measurement_time DESC
LIMIT 20;
```

#### Backup & Restore (Turso)

##### Recommended: Turso Snapshots (Instant, Copy-on-Write)

Turso's native branching feature creates instant point-in-time snapshots using copy-on-write:

```bash
# Create instant snapshot (recommended before migrations or risky operations)
~/.turso/turso db create liveone-snapshot-$(date +%Y%m%d-%H%M%S) \
  --from-db liveone-tokyo \
  --location aws-ap-northeast-1 \
  --wait

# Verify snapshot has data
~/.turso/turso db shell liveone-snapshot-YYYYMMDD-HHMMSS \
  "SELECT COUNT(*) FROM readings; SELECT COUNT(*) FROM systems;"

# List all snapshots
~/.turso/turso db list | grep snapshot

# Delete old snapshot when no longer needed
~/.turso/turso db destroy liveone-snapshot-YYYYMMDD-HHMMSS
```

Benefits:

- Instant creation (seconds, not minutes)
- No storage cost until data diverges (copy-on-write)
- Can query directly without restore
- Perfect for pre-migration snapshots

##### Alternative: File Export (for offline backups)

```bash
# Backup to file (slower, but portable)
~/.turso/turso db export liveone-tokyo > backup-$(date +%Y%m%d).sql

# Or use the backup script (includes compression)
./scripts/utils/backup-prod-db.sh

# Restore from file
~/.turso/turso db create liveone-restored --location aws-ap-northeast-1
~/.turso/turso db shell liveone-restored < backup-20250817.sql
```

## Database Migrations

### PostgreSQL (primary)

PG schema changes are versioned drizzle-kit migrations generated from `lib/db/planetscale/schema.ts`:

```bash
npm run db:pg:generate   # diff schema.ts -> new migration SQL in /drizzle-planetscale/
npm run db:pg:migrate    # apply pending migrations (needs PLANETSCALE_DATABASE_URL_MIGRATIONS)
```

- **Never use `drizzle-kit push`** — destructive diff with no transaction or validation (the migration-0016 failure mode). See `drizzle-planetscale/README.md`.
- The Safety Guidelines below (backup/snapshot first, test on a copy, validate row counts before any DROP) apply to PG too. PG backup = PITR schedules + `pscale backup create`.

### Turso/SQLite (legacy — until migration Phase 5)

This section covers the legacy plain-SQL migrations in `/migrations/`. Migrations are tracked in a `migrations` table to ensure they're only applied once per database.

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
   # Recommended: Create instant Turso snapshot (seconds, not minutes)
   ~/.turso/turso db create liveone-snapshot-$(date +%Y%m%d-%H%M%S) \
     --from-db liveone-tokyo \
     --location aws-ap-northeast-1 \
     --wait

   # Alternative: File-based backup (slower)
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

> ⚠️ **Migration-0056 lesson**: in SQLite, `RAISE(ABORT, ...)` only works inside trigger
> programs — the Step 3 validation above will error outside a trigger. Validate row counts
> via application code or manually before the DROP instead. (In PostgreSQL, use a `DO` block
> with `RAISE EXCEPTION`, which works fine.) See `docs/migrations.md`.

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

- **PostgreSQL Drizzle ORM (`planetscaleDb`)**: the primary store
  - Import: `import { planetscaleDb } from '@/lib/db/planetscale'`
  - Example: `await planetscaleDb.select().from(systems).where(eq(systems.id, systemId))`
  - Read/write routing between PG and Turso during the migration goes through `lib/db/routing.ts` flags — check there before adding a direct DB call

- **Turso Drizzle ORM (`db`)**: legacy paths only (until Phase 5)
  - Example: `await db.select().from(systems).where(eq(systems.id, systemId))`
  - Does NOT have `.execute()` or `.all()` methods

- **Turso raw SQL (`rawClient`)**: direct SQL against Turso
  - Import: `import { rawClient } from '@/lib/db/turso'`
  - Example: `await rawClient.execute('SELECT 1 FROM point_readings LIMIT 1')`
  - Returns `{ rows: [...], columns: [...] }` format

## Data Pipeline

1. **Collection**: Cron polls vendor APIs (minutely or per-vendor smart schedule); push vendors (`fusher`) arrive via webhook
2. **Publish**: Poll collector builds `QueueMessage`s → durable tee to the PG `observations_outbox` (`WRITE_OUTBOX`) + direct QStash enqueue; the relay cron drains the outbox to QStash
3. **Materialise**: `/api/observations/receive` (the **single writer** of the serving store, idempotent) → PG `point_readings` + real-time `point_readings_agg_5m` upsert
4. **Daily Aggregation**: Cron at 00:05 local → `point_readings_agg_1d`
5. **Serve**: APIs read pre-aggregated PG data; latest values from the KV cache
6. **Transitional**: an inline Turso write keeps the legacy backup current until Phase 5

Details and invariants: `docs/architecture/data-model.md`, `docs/architecture/engine-web-separation.md`.

### Manual Operations

```bash
# Trigger daily aggregation manually (admin; in dev use -H "x-claude: true" instead)
# action: aggregate | regenerate (delete + re-aggregate) | delete; no action = yesterday
# dates: date=YYYY-MM-DD | start=...&end=... | last=7d; no dates = all available data
curl -X POST https://liveone.vercel.app/api/cron/daily \
  -H "Authorization: Bearer $CRON_SECRET" \
  -d '{"action": "aggregate", "last": "7d"}'
```

## Code Style & Conventions

- **TypeScript**: Strict mode enabled
- **Imports**: Use `@/` for root imports
- **Dates**: UTC everywhere — PG uses native `timestamp` columns; Turso/legacy uses Unix epoch-ms integers
- **Power**: Watts (floats in the point tables)
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
3. Batch inserts (max 100 records for SQLite; PG autovacuums and handles larger batches)
4. Use prepared statements for repeated queries

- when backing up prod **Turso**, use @scripts/utils/backup-prod-db.sh and check that the file is at least 6MB in size; for prod **Postgres**, PITR schedules run automatically and `pscale backup create` makes a one-off base backup
- don't use NPM run to check for typescript errors
