# Migrations

> **Status:** current — last verified 2026-08-02. Covers both kinds: **schema** migrations (DDL) and
> **config-document** migrations (rewriting JSON we persist, e.g. `dashboards.doc`). PostgreSQL
> (PlanetScale) is the only store; schema migrations are versioned Drizzle migrations in
> `/drizzle-planetscale/`. The old plain-SQL SQLite migration system (`/migrations/`, tracked in a
> `migrations` table) was retired and removed when the legacy SQLite store was decommissioned — this
> doc documents the Postgres path only. See also `CLAUDE.md` for the migration checklist and the
> PlanetScale-specific traps (branches, `pscale role`, table-ownership), and
> `drizzle-planetscale/README.md`.

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

## Deploy ordering — additive vs. drop

PG migrations are **manual**, not applied at deploy (see `docs/incidents/2026-06-16-…`), so the order
of "apply the migration" vs. "merge the code" matters — and it **inverts** between the two kinds:

- **Additive** (new table/column): apply to prod `sydney` **before** merging the code, or the deployed
  build queries something that isn't there yet and prod 500s.
- **Drop**: merge and deploy the code **first**, so nothing live still reads the table, then drop on
  prod and finally on `liveone-dev`.

(Rehomed here from `architecture/areas-and-dashboards.md`, whose v3 roadmap section was retired in the
config-v4 rewrite. The rule is general, not specific to that doc's phases.)

## Data & config-document migrations

Not every migration is DDL. We persist **JSON documents** — principally `dashboards.doc`, the v4 node
tree — and those documents embed identifiers that also exist in code: card `type` strings, tile ids.

> 🛑 **A rename is only half a change when documents persist the old name.** Renaming a card type in
> code without rewriting the stored documents leaves prod rendering `Unknown card type …`. Sweep, then
> ship the rewrite in the same PR as the rename.

**Why this is visible rather than silent, and why that is deliberate.** A card `type` is an
[open string, warn-not-reject](architecture/data-model.md#the-v4-dashboard-document): an unknown type
persists with its `config` intact and renders a labelled placeholder, so an older validator can never
destroy a newer client's config. The cost of that choice is that a missed rename degrades a card to a
grey box instead of failing a build. Nothing detects it for you — so sweep before merging.

**Sweep** — every card type present in every stored document (run against prod, and against dev):

```sql
with nodes as (
  select d.name, jsonb_path_query(d.doc, '$.** ? (@.kind == "card")') as node from dashboards d
)
select name, node->>'type' as card_type, count(*) from nodes group by 1,2 order by 1,2;
```

Anything in that list that is not in `V4_CARD_TYPES` (`lib/dashboard/card-types.ts`) is currently a
grey box on somebody's dashboard.

**Rewrite** — `scripts/utils/migrate-card-type.ts`, dry-run by default:

```bash
pscale role create liveone sydney cardtype-migrate --inherited-roles postgres --ttl 1h --format json
MIGRATE_DATABASE_URL="<that url>" npx tsx scripts/utils/migrate-card-type.ts <old> <new>
MIGRATE_DATABASE_URL="<that url>" npx tsx scripts/utils/migrate-card-type.ts <old> <new> --apply
pscale role delete liveone sydney <role-id> --force
```

The connection is taken **only** from `MIGRATE_DATABASE_URL`, never the ambient
`PLANETSCALE_DATABASE_URL`: the usual target is prod, and "which database am I pointed at" must not be
answered by whatever is in `.env.local`. The rewrite itself is `rewriteCardType`
(`lib/dashboard/migrate-card-type.ts`) — pure, idempotent, and unit-tested; each write is a
transaction that locks the row and bumps `revision`, mirroring `updateDashboardDoc`, so a concurrent
editor's `If-Match` conflicts instead of being clobbered.

Ordering and scope:

- **Apply to prod, not to dev.** `dashboards` is a config table the 2-hourly prod→dev sync refreshes,
  so a dev-only edit reverts within the hour. Dry-run against dev freely; apply to prod and let the
  sync carry it down.
- **It renames the `type` and nothing else.** `config` passes through verbatim, so this is the right
  tool only when the new type accepts the old type's config — either both are bare, or every added key
  has a schema default. (`generator-runs` → `runs`: `runsConfigSchema.role` defaults to `"generator"`,
  which is exactly what a pre-rename document meant.) A rename that reshapes `config` needs a bespoke
  transform.
- **Prefer it in the same PR as the rename**, so the code and the data never disagree across a deploy.
  There is no read-time upgrade ladder and no legacy-alias map — by design, so the two never drift.

**Ad-hoc document edits** — `npm run dashboard` (`scripts/ops/dashboard/cli.ts`) is the general-purpose
editor for `dashboards.doc` and dashboard metadata: `list` / `show` (prints the `n_…` node ids edits
address) / `validate` / `rename` / `add-card` / `add-group` / `remove-node` / `move-node` / `set-prop`.
Every subcommand takes `--help` and `--format human|json`. Same safety model as the rewrite script: connection from `MIGRATE_DATABASE_URL` only, printed
`target:` identity, dry-run by default with `--apply`, every result doc gated on `validateDocV4`, and
CAS writes that bump `revision`. Use it for one-off edits; a rename that must sweep every document
still wants `migrate-card-type.ts`.

**Precedent.** `generator-runs` → `runs` (PR #338, Aug 2026) shipped the code, catalog, seed strategy
and fixtures, but no document rewrite: one prod dashboard (Daylesford) rendered `Unknown card type
generator-runs` until it was swept and migrated. Earlier renames got away with it by luck —
`battery-blend` → `battery-contents` was verified safe only because no persisted document happened to
contain either name.

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
    "applied": 32, // rows in drizzle.__drizzle_migrations (DB truth)
    "expected": 32, // migrations this build ships (meta/_journal.json — code truth)
    "latestTag": "0031_bright_ben_parker",
    "latestHash": "ac081f16…", // sha256 of the newest APPLIED migration
    "inSync": true // applied >= expected
  }
}
```

- **Compare two environments** (are prod and dev on the same migrations?): compare **`applied` +
  `latestHash`**. `latestHash` is the `sha256` of the migration `.sql` file — drizzle stores exactly
  that in `drizzle.__drizzle_migrations`, so it is content-addressed and identical across envs when the
  same migration is the newest applied.
- **Is one env's DB behind its deployed code?** check **`inSync`** (`applied >= expected`).
  `expected`/`latestTag` come from the bundled `meta/_journal.json` — the _code_ that env is running
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
