# Postgres migrations (drizzle-kit)

Versioned schema migrations for the PlanetScale Postgres database, generated from
`lib/db/planetscale/schema.ts`. This replaces the earlier `drizzle-kit push` workflow.

## Commands

```bash
npm run db:pg:generate   # diff schema.ts -> new migration SQL in this directory
npm run db:pg:migrate    # apply pending migrations (tracked in drizzle.__drizzle_migrations)
```

`db:pg:generate` runs offline (it diffs the schema against the snapshots in this dir).
`db:pg:migrate` needs DDL credentials: `PLANETSCALE_DATABASE_URL_MIGRATIONS` (or the
discrete `DB_*` vars).

## Do NOT use `drizzle-kit push`

`push` applies a destructive diff with no transaction or row-count validation — the exact
pattern behind the migration-0016 data loss (see root `CLAUDE.md`). Use generate + migrate,
and apply the CLAUDE.md migration checklist (backup/snapshot, validate, transaction) for any
destructive change.

## Baselining the existing (already-pushed) database

The production tables were originally created with `drizzle-kit push`, so `0000_*.sql` (the
baseline) already exists in the live DB. Running `db:pg:migrate` against it would try to
re-CREATE those tables and fail. **One-time, with migration credentials**, mark the baseline
as already applied without executing it:

1. Ensure the tracking table exists (drizzle creates `drizzle.__drizzle_migrations` on first
   `migrate`).
2. Insert the baseline's hash (from `meta/_journal.json`) into `drizzle.__drizzle_migrations`
   so drizzle treats `0000` as applied.

After baselining, every subsequent change is: edit `schema.ts` → `db:pg:generate` →
review the SQL → `db:pg:migrate`.
