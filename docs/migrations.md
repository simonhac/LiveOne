# Database Migrations

> **Status:** current — last verified 2026-06-11. PostgreSQL (PlanetScale) is the only store;
> migrations are versioned Drizzle migrations in `/drizzle-planetscale/`. The old plain-SQL
> SQLite migration system (`/migrations/`, tracked in a `migrations` table) was retired and
> removed when the legacy SQLite store was decommissioned — this doc documents the Postgres
> path only. See also `CLAUDE.md` for the migration checklist and the PlanetScale-specific
> traps (branches, `pscale role`, table-ownership), and `drizzle-planetscale/README.md`.

## How migrations work

PG schema changes are **generated from the Drizzle schema**, not hand-written:

- **Schema source of truth:** `lib/db/planetscale/schema.ts`
- **Migration files:** `/drizzle-planetscale/` (`NNNN_*.sql` + the `meta/` journal)
- **Generate:** `npm run db:pg:generate` — diffs `schema.ts` against the recorded state and
  writes a new migration SQL file.
- **Apply:** `npm run db:pg:migrate` — applies pending migrations, tracked in the
  `drizzle.__drizzle_migrations` table so each runs once per branch.

> **Never use `drizzle-kit push`** — it does a destructive diff with no transaction or
> validation (the migration-0016 failure mode). Always generate a migration file and apply it.

```bash
npm run db:pg:generate   # diff schema.ts -> new migration SQL in /drizzle-planetscale/
npm run db:pg:migrate    # apply pending migrations (needs PLANETSCALE_DATABASE_URL_MIGRATIONS)
```

`db:pg:migrate` targets whatever `PLANETSCALE_DATABASE_URL_MIGRATIONS` (or the discrete `DB_*`
vars) points at — **confirm the host/branch before applying**. Applying to a specific branch
(`main` vs `sydney`), `pscale role` connections, and the table-ownership pitfall are covered in
`CLAUDE.md` under "Applying Postgres (PlanetScale) migrations".

## Writing safe migrations

For destructive changes (recreate a table, change a primary key), use the
CREATE-new → copy → **validate** → DROP-old → RENAME pattern, wrapped in a transaction:

```sql
BEGIN;

CREATE TABLE example_new ( ... );

INSERT INTO example_new SELECT ... FROM example;

-- Validate before dropping. In PostgreSQL, RAISE EXCEPTION inside a DO block works:
DO $$
BEGIN
  IF (SELECT count(*) FROM example) <> (SELECT count(*) FROM example_new) THEN
    RAISE EXCEPTION 'Row count mismatch - aborting migration';
  END IF;
END $$;

DROP TABLE example;
ALTER TABLE example_new RENAME TO example;

-- Recreate any indexes
CREATE INDEX idx_example_column ON example(column);

COMMIT;
```

PostgreSQL has **transactional DDL**, so a failed migration inside `BEGIN`/`COMMIT` rolls back
cleanly. Still verify row counts after applying.

## Pre-Migration Checklist

1. **Back up production first** — PITR schedules run automatically; `pscale backup create`
   makes a one-off base backup.
2. **Test on a copy / non-prod branch** first.
3. **Verify row counts** before and after (`SELECT relname, n_live_tup FROM pg_stat_user_tables`
   for instant approximate counts; never `COUNT(*)` the big time-series tables).
4. **Check indexes** are recreated if a table was rebuilt.
5. **Sync `main` and re-check the migration number** before generating — parallel workspaces can
   grab the same `NNNN`. If `main` already shipped your number, regenerate so yours lands as the
   next free number.

## Deployment Verification

(Folded in from the retired `DEPLOYMENT.md`, 2026-06-10.)

- **Diff schemas before deploying schema changes** — dump dev and prod schemas and diff them;
  don't assume they match.
- **Verify env vars are set** before relying on them: `vercel env ls production`.
- **Verify incrementally after deploy** — don't assume success. Start with
  `curl -s https://liveone.vercel.app/api/health | jq '.status'` (expect `"ok"`), then
  spot-check the affected endpoints/pages. After a **migration** deploy, add `?migrations=1` and
  check `.migrations.inSync` (see [Checking applied migrations](#checking-applied-migrations) below).
- **Document any manual steps** a deploy requires, and write them down _before_ starting.

## Checking applied migrations

`GET /api/health?migrations=1` returns a cheap snapshot of migration state for a fast prod↔dev drift
check. The field is **opt-in** (the `?migrations=1` query param) — the default liveness response omits
it so that path stays a single `SELECT 1` and its `db` Server-Timing stays a clean latency control:

```json
{
  "status": "ok",
  "database": "postgres",
  "migrations": {
    "applied": 32,                 // rows in drizzle.__drizzle_migrations (DB truth)
    "expected": 32,                // migrations this build ships (meta/_journal.json — code truth)
    "latestTag": "0031_bright_ben_parker",
    "latestHash": "ac081f16…",     // sha256 of the newest APPLIED migration
    "inSync": true                 // applied >= expected
  }
}
```

- **Compare two environments** (are prod and dev on the same migrations?): compare **`applied` +
  `latestHash`**. `latestHash` is the `sha256` of the migration `.sql` file — drizzle stores exactly
  that in `drizzle.__drizzle_migrations`, so it is content-addressed and identical across envs when the
  same migration is the newest applied.
- **Is one env's DB behind its deployed code?** check **`inSync`** (`applied >= expected`).
  `expected`/`latestTag` come from the bundled `meta/_journal.json` — the *code* that env is running
  (prod runs `main`; dev/preview run the branch), so this catches "deployed a migration-dependent build
  but forgot to apply the migration".
- **Why `count(*)`, not `max(id)`:** the `drizzle.__drizzle_migrations` PK is a serial that gaps on any
  row delete/re-apply, so `max(id)` can differ across envs (dev has read 33 while prod read 32) even
  when the schemas are identical. `count(*)` is the stable count; the file hashes are the definitive
  per-migration identity.

To compare the **full** applied set (not just the newest), diff the hashes directly against the repo's
migration files (empty diff ⇒ every repo migration is applied and nothing extra is):

```bash
diff <(shasum -a 256 drizzle-planetscale/*.sql | awk '{print $1}' | sort) \
     <(npm run db:psql -- -tA -c 'SELECT hash FROM drizzle."__drizzle_migrations"' \
        | grep -E '^[0-9a-f]{64}$' | sort)
```

## Lessons Learned

### Migration 0016: Lost 345K records

- INSERT...SELECT without validation before DROP
- No explicit transaction
- Foreign key constraints silently rejected rows

### Migration 0056: validation must abort correctly

- An earlier attempt used `RAISE(ABORT, ...)` in a bare SELECT — that only works inside trigger
  programs, so the validation silently did nothing. In PostgreSQL, do the row-count check in a
  `DO` block with `RAISE EXCEPTION` (as in the pattern above), which aborts the transaction.
