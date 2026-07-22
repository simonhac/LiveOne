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
- **Database**: PostgreSQL on PlanetScale (the sole datastore) — prod = `sydney` branch (`aws-ap-southeast-2`), dev = shared PlanetScale dev branch
- **Deployment**: Vercel (automatic from main branch; region `syd1`)

### Environment Variables

```bash
# PostgreSQL (PlanetScale) - PRIMARY database
PLANETSCALE_DATABASE_URL=<runtime connection string>           # dev + preview: liveone-dev; prod: sydney branch
PLANETSCALE_DATABASE_URL_MIGRATIONS=<DDL connection string>    # for npm run db:pg:migrate (or discrete DB_* vars)
PLANETSCALE_PROD_BRANCH_ID=<prod branch id>                    # arms the DB-environment guard (assertDbEnvironmentMatches), matched as a substring of user@host. PlanetScale shares one regional host across branches, so this is the prod BRANCH ID (in the prod username), not a hostname. dev/preview: refuse if a connection carries it (fail-closed). prod: alert if a connection does NOT carry it — drift (fail-open). Set in ALL scopes incl. Production.
# ALLOW_PROD_DB_IN_DEV=true                                    # escape hatch for the guardrail - use deliberately
# PLANETSCALE_POOL_MAX=10                                      # optional pool size
CRONS_ENABLED=true                                            # scheduled crons run ONLY when "true" (every env, incl. prod); dev/preview leave unset = off. Admin/x-claude/?force=true bypass.

# Vercel KV (for latest point values cache)
KV_REST_API_URL=<your-kv-url>
KV_REST_API_TOKEN=<your-kv-token>

# Tesla Fleet API (monitoring + charge control). Required for any Tesla connection —
# the legacy Owner API path is removed (see docs/tesla-api-brief.md).
TESLA_CLIENT_ID=<developer.tesla.com app client id>
TESLA_CLIENT_SECRET=<developer.tesla.com app client secret>
TESLA_REDIRECT_URI=https://liveone.energy/api/auth/tesla/callback
TESLA_PUBLIC_KEY_PEM=<EC P-256 public key PEM; served at /.well-known/appspecific/com.tesla.3p.public-key.pem>
TESLA_PRIVATE_KEY_PEM=<EC P-256 private key PEM; reserved for Phase 2 command signing>
```

#### Setting up Tesla Fleet API

The Tesla integration uses the Fleet API (the Owner API auth path is de-registered).
See `docs/tesla-api-brief.md` for the full rationale. One-time setup:

1. **Register an app** at `developer.tesla.com` (MFA account) → `TESLA_CLIENT_ID` +
   `TESLA_CLIENT_SECRET`. Redirect URI `https://liveone.energy/api/auth/tesla/callback`;
   scopes `openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds`.
2. **Configure billing** on the developer account (pay-per-use; ~$10/mo discount).
3. **Generate the keypair**: `./scripts/utils/tesla-generate-keypair.sh` → set
   `TESLA_PUBLIC_KEY_PEM` / `TESLA_PRIVATE_KEY_PEM`. The public key is served at
   `/.well-known/appspecific/com.tesla.3p.public-key.pem`.
4. **Register the partner account** (once per env, after the public key is live):
   `curl -X POST https://liveone.energy/api/admin/tesla/register-partner` (admin auth;
   in dev use `-H "x-claude: true"`).

Pre-2021 Model S/X are exempt from command signing, so charge commands work over direct
REST. 2021+ vehicles need a signing proxy/SDK (Phase 2) — the command layer is built with
a pluggable signer so that's a config/infra add, not a rewrite.

#### Setting up Vercel KV

The application uses Vercel KV to cache the latest point values for fast retrieval.

**One store, prefix-namespaced (NOT one-store-per-environment).** There is a SINGLE physical KV
(Redis) store, shared by dev and prod. Isolation is by an environment key prefix: every key is
namespaced by `kvKey()` (`lib/kv.ts`) → `prod:` / `dev:` / `test:`, driven by `getEnvironment()`
(`lib/env.ts`: `prod` when `VERCEL_ENV=production`, `test` when `NODE_ENV=test`, else `dev`). So the
same `KV_REST_API_URL` / `KV_REST_API_TOKEN` pair is used everywhere and there is nothing to
"replicate between instances" — see `docs/sync-prod-to-dev.md` and `docs/architecture/kv-store.md`.
Follow these steps to set up:

1. **Create one KV database in the Vercel dashboard** (Storage → KV) — a single shared store.

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

5. **Build subscription registry** (one-time setup): there is no standalone admin route for this —
   `buildSubscriptionRegistry()` (`lib/kv-cache-manager.ts`) runs automatically via
   `refreshAreaServing` on every area/binding mutation. To rebuild it directly, run
   `npx tsx scripts/build-subscription-registry.ts`.

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

**`x-claude` is NOT enough when the Clerk middleware gates the route.** `x-claude` is honored
inside the route handler (`requireAuth`), but `middleware.ts` runs `auth.protect()` at the edge
_first_ and rewrites unauthenticated API calls to a 404 (`x-clerk-auth-reason: protect-rewrite`)
before the handler ever sees the header. So `x-claude` only reaches routes that are public/shareable
in `lib/route-matchers.ts` (e.g. `/api/cron/*`); anything else (e.g. `POST /api/areas/[areaId]/...`)
404s. For those, mint a real Clerk session JWT and pass it as a Bearer token — a real session passes
the middleware:

```bash
# Requires the target user (simon) to have an active browser session on the dev Clerk instance.
JWT=$(npx tsx scripts/utils/get-test-token.ts 2>/dev/null | grep -E '^eyJ' | head -1)
curl -H "Authorization: Bearer $JWT" -X POST http://localhost:3000/api/areas/<areaId>/recompute-flow -d '{...}'
```

The JWT expires after ~60s — mint it in the same command that uses it.

## Database Management

### PostgreSQL (primary)

```bash
# Connect with psql (dev branch, from .env.local)
npm run db:psql -- -c "select now()"   # wrapper sets PGSSLROOTCERT=system (verify-full needs a CA source)
# bare `psql "$PLANETSCALE_DATABASE_URL"` also works once ~/.zshrc exports PGSSLROOTCERT=system;
#   otherwise libpq fails on a missing root CA (~/.postgresql/root.crt). Node's pg is unaffected —
#   getPoolConfig (lib/db/planetscale/index.ts) strips the ssl params.
# Production (sydney branch): mint a role url, then PSQL_URL="<url>" npm run db:psql -- -c "…"
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

#### Common Queries

> ⚠️ **Never `COUNT(*)` (or run any full-table scan/aggregate) on the big tables** — `point_readings` (~13M rows), `point_readings_agg_5m` (~3M), `sessions` (~870K). It's slow and almost never what you actually need.
>
> - **Approximate row counts:** `SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC` (planner estimate, instant).
> - **Presence / recency / "is it current":** use an indexed `ORDER BY <indexed col> DESC LIMIT 1` — e.g. `SELECT MAX(measurement_time) FROM point_readings` or `SELECT 1 FROM <table> LIMIT 1`. This is how you verify a snapshot/backup has data, too.
> - **Exact `COUNT(*)` is fine** only on the small config tables: `systems`, `point_info`, `users`, `user_systems`, `polling_status`, `share_tokens`.

```sql
-- Check for duplicate timestamps in point_readings
SELECT measurement_time, COUNT(*) as count
FROM point_readings
WHERE system_id = 1 AND point_id = 0
GROUP BY measurement_time
HAVING COUNT(*) > 1;

-- Find data gaps > 10 minutes
WITH time_diffs AS (
  SELECT
    measurement_time,
    LAG(measurement_time) OVER (ORDER BY measurement_time) as prev_time,
    measurement_time - LAG(measurement_time) OVER (ORDER BY measurement_time) as diff
  FROM point_readings
  WHERE system_id = 1 AND point_id = 0
)
SELECT prev_time AS gap_start, measurement_time AS gap_end,
       EXTRACT(EPOCH FROM diff) / 60 AS gap_minutes
FROM time_diffs
WHERE diff > interval '10 minutes'
ORDER BY measurement_time DESC
LIMIT 20;
```

## Database Migrations

> 🛑 **Always ask before modifying the schema.** Never add/alter/drop a column, table, or index — or generate/apply a migration — without explicit approval first. Propose the change and wait for a "yes".

### PostgreSQL (primary)

PG schema changes are versioned drizzle-kit migrations generated from `lib/db/planetscale/schema.ts`:

```bash
npm run db:pg:generate   # diff schema.ts -> new migration SQL in /drizzle-planetscale/
npm run db:pg:migrate    # apply pending migrations (needs PLANETSCALE_DATABASE_URL_MIGRATIONS)
```

- **Never use `drizzle-kit push`** — destructive diff with no transaction or validation (the migration-0016 failure mode). See `drizzle-planetscale/README.md`.
- The Safety Guidelines below (backup/snapshot first, test on a copy, validate row counts before any DROP) apply to PG too. PG backup = PITR schedules + `pscale backup create`.
- Applying to a specific branch (`main` vs `sydney`), `pscale role` connections, the table-ownership pitfall, and parallel-agent number collisions: see **Applying Postgres (PlanetScale) migrations** below.

### Migration Safety Guidelines

**Critical lessons learned from migration 0016 (which lost 345K+ records).** These predate the
move to versioned drizzle-kit Postgres migrations but the principles still gate any destructive DDL:

#### Before running ANY destructive migration

1. **Back up production first** — confirm a recent PITR window and take a one-off base backup
   (`pscale backup create`); for an off-site copy, the `pg-backup` GitHub Action ships a 2-hourly
   `pg_dump` to R2 (via the [the-gitfather](https://github.com/simonhac/the-gitfather) reusable
   workflows; profile `pg-backup/liveone.yaml`).
2. **Test on a copy** — restore a base backup into a throwaway PlanetScale branch and run the
   migration there before touching prod; verify row counts on the critical tables afterward.
3. **Validate row counts before any DROP** — never drop/replace a table without first asserting
   the new copy has the expected rows.

> ⚠️ **Migration-0056 lesson**: row-count validation belongs in the migration itself. In PostgreSQL,
> use a `DO` block with `RAISE EXCEPTION` to abort if counts don't match before a DROP. See
> `docs/migrations.md`.

#### Why migration 0016 failed

The migration had INSERT...SELECT statements but **no validation** before dropping old tables:

1. ❌ No explicit transaction wrapping
2. ❌ No row count validation after INSERT
3. ❌ Immediately dropped the old table without checking the copy succeeded
4. ❌ Foreign key constraints may have silently rejected rows
5. ❌ Not tested on a production data copy first

Result: 345,456 point_readings lost, requiring 8+ hour restoration from backup.

#### Migration checklist

- [ ] Backup confirmed (PITR window + base backup)
- [ ] Tested on a throwaway branch / copy
- [ ] Row-count validation before any DROP (`DO`/`RAISE EXCEPTION`)
- [ ] Idempotent (re-run-safe via `IF NOT EXISTS` / `pg_constraint` guards, etc.)
- [ ] Foreign-key constraints accounted for
- [ ] Indexes recreated after table operations
- [ ] **No `drizzle-kit push`** — generated migration only
- [ ] Ready to restore from backup if needed

#### Other notes

- **No Rollbacks**: this project doesn't use rollback migrations — to undo a change, create a new forward migration.
- **Run pre-checks**: before complex migrations, check data volumes and estimate time required.

### Applying Postgres (PlanetScale) migrations

The `db:pg:generate` / `db:pg:migrate` basics are in **PostgreSQL (primary)** above; these are **manual** (no auto-apply at deploy), and applying by hand has a few traps worth knowing.

`db:pg:migrate` targets whatever `PLANETSCALE_DATABASE_URL_MIGRATIONS` (or the `DB_*` vars) in `.env.local` points at. Always confirm the host before applying; override the env var to target a specific branch.

**Branches & connections (`liveone` PlanetScale db).** Prod is the standalone `sydney` branch (`aws-ap-southeast-2`); the old us-east `main` branch was decommissioned 2026-06-11. PG branches use **`pscale role`**, not `pscale password`. There is no stored Sydney connection string — mint a short-TTL one:

```bash
pscale role create liveone sydney <name> --inherited-roles postgres --ttl 1h --format json
# then: PLANETSCALE_DATABASE_URL_MIGRATIONS="<that database_url>" npm run db:pg:migrate
```

**⚠️ Table-ownership trap (learned the hard way).** A migration applied via a freshly-minted `pscale role` makes that role the **owner** of the tables it creates. Consequences: (a) the app connects as `postgres` and will get _"permission denied"_ on a non-`postgres`-owned table; (b) the temp role **cannot be dropped while it owns objects** (`DROP ROLE` is refused — Postgres does NOT cascade-drop owned tables, so the data is safe, but the role lingers and the TTL delete fails the same way). Every normal table here is owned by `postgres`. So either:

- Apply as the persistent `postgres` role (`pscale role reset-default liveone <branch>` to get its creds), **or**
- After applying with a temp role, reassign + clean up:
  ```bash
  pscale role reassign liveone <branch> <temp-role-id> --successor postgres --force
  pscale role delete   liveone <branch> <temp-role-id> --force
  ```
  (Control-plane `reassign` works even though SQL `ALTER ... OWNER` / `SET ROLE postgres` fail with "must be owner" — `postgres` here is not a superuser.)

**Parallel-agent collisions.** Multiple Conductor workspaces can each `db:pg:generate` and grab the **same `NNNN` number** for different migrations (e.g. two `0004_*`). Before generating/applying, `git fetch origin main` and check `drizzle-planetscale/` + the live `drizzle.__drizzle_migrations`; if main already shipped your number, sync main and regenerate so yours lands as the next free number. Migrations are additive/independent objects, so the only real damage is the drizzle journal/numbering — fix it by renumbering, not by force.

### `liveone-dev` — the shared dev/preview database

`liveone-dev` is a **separate** single-node PlanetScale database (`aws-ap-southeast-2`), the sole datastore for **both local dev and Vercel preview**. It is never prod: the app's `assertDbEnvironmentMatches` guard (armed by `PLANETSCALE_PROD_BRANCH_ID`) refuses, in dev/preview, any connection whose identity carries the prod token (fail-closed), and — in production — alerts if the connection does NOT carry it (drift detection, fail-open: it logs + posts to `OBSERVATIONS_ALERT_WEBHOOK_URL` but never throws, so a stale token can't take prod down). **Note:** PlanetScale puts every branch/database in a region on the **same gateway host** (e.g. `aws-ap-southeast-2-1.pg.psdb.cloud`) and distinguishes them by the role/username (`postgres.<branch-id>`) — so the token is the prod **branch id**, not the hostname, and `liveone-dev` is told apart from prod by its username. The token must be set in **all** scopes (incl. Production, for the drift check). Routing is via env: prod connects through the discrete `DB_*` vars (Production scope); dev + preview set `PLANETSCALE_DATABASE_URL` to `liveone-dev` (it takes precedence over `DB_*` in `getPoolConfig`). Keep prod's `DB_*`/URL out of the Preview/Development scopes.

- **Seed / reset from prod:** restore the latest off-site R2 dump into `liveone-dev` (schema + data in one shot). Reuse the `scripts/utils/restore-drill-pg.sh` flow, but target `liveone-dev` and **run as the persistent `postgres` role** (table-ownership trap above). A restore reverts `liveone-dev` to prod's migration version — re-apply any in-progress test migration afterward.
- **Keep in sync (between restores):** `npm run db:sync-dev-db` (`scripts/utils/sync-prod-to-dev-db.ts`) does an incremental top-up — reads prod with a **SELECT-only** role (`pg_read_all_data`), copies new `point_readings`/agg/session rows + refreshes small config tables into `liveone-dev`. It writes **only** to dev and refuses to run if the write target resolves to the prod host. A second leg, `npm run db:rebuild-dev-kv` (`scripts/utils/rebuild-dev-kv-from-db.ts`), then rebuilds the `dev:` KV cache from that DB (crons are off in dev/preview so KV isn't written organically). Both run every 2h via `.github/workflows/sync-prod-to-dev.yml` (+ `workflow_dispatch`). Needs `PG_PROD_RO_DATABASE_URL` (read-only prod role), `LIVEONE_DEV_DATABASE_URL` (dev write role), and `KV_REST_API_URL`/`KV_REST_API_TOKEN` for the KV leg. See `docs/sync-prod-to-dev.md`.
- **Crons are off in dev/preview** (`CRONS_ENABLED` unset) so they don't double-poll vendors or pollute the mirror — see the env block above.

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

- **PostgreSQL Drizzle ORM (`planetscaleDb`)**: the sole datastore
  - Import: `import { planetscaleDb } from '@/lib/db/planetscale'`
  - Example: `await planetscaleDb.select().from(systems).where(eq(systems.id, systemId))`

## Data Pipeline

1. **Collection**: Cron polls vendor APIs (minutely or per-vendor smart schedule); push vendors (`fusher`) arrive via webhook
2. **Publish**: Poll collector builds `QueueMessage`s → durable tee to the PG `observations_outbox` + direct QStash enqueue; the relay cron drains the outbox to QStash
3. **Materialise**: `/api/observations/receive` (the **single writer** of the serving store, idempotent) → PG `point_readings` + real-time `point_readings_agg_5m` upsert
4. **Daily Aggregation**: Cron at 00:05 local → `point_readings_agg_1d`
5. **Serve**: APIs read pre-aggregated PG data; latest values from the KV cache

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
- **Dates**: UTC everywhere — PG uses native `timestamp` columns
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
3. Batch inserts; PG autovacuums and handles large batches
4. Use prepared statements for repeated queries

- when backing up prod **Postgres**, PITR schedules run automatically and `pscale backup create` makes a one-off base backup; off-site copies ship 2-hourly to R2 via the `pg-backup` GitHub Action — a thin caller of the [the-gitfather](https://github.com/simonhac/the-gitfather) reusable workflows (GFS 2hourly→daily→weekly→monthly + daily durable-verify (hash-check every durable object + restore freshest daily / aged weekly+monthly) + twice-hourly staleness self-heal + a published backup-history dashboard). Project config lives in `pg-backup/liveone.yaml`; secrets/vars in the GitHub repo. `scripts/utils/restore-drill-pg.sh` is retained as the manual restore / `liveone-dev` seed helper (it handles both the new raw `.dump` and legacy `.dump.gz`).
- don't use NPM run to check for typescript errors
