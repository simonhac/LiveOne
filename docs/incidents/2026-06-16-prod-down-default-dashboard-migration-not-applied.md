# Prod outage — `default_dashboard_id` migration not applied to prod

## Summary

On **2026-06-16**, production (`www.liveone.energy`) returned **"Application error: a
server-side exception has occurred"** (digest `356207801`) on `/dashboard` and every other
authenticated page. Root cause: **PR #101 (Phase 2a/2b-1) was merged to `main` and
auto-deployed to prod, but its database migration `0016` was never applied to the prod
`sydney` branch** — only to the `liveone-dev` database during development. The deployed code
`SELECT`s `users.default_dashboard_id`, a column that did not exist on prod, so every request
that read user preferences threw.

This was an **availability** incident, not data corruption — no rows were lost or changed. The
fix was to apply the (purely additive) `0016` migration to prod.

Outage window: **~15:37–21:25 AEST (~05:37–11:25 UTC), ≈ 5h50m**, affecting authenticated
users. (Anonymous read-only shared links — `?access=…` — resolve before the auth/preferences
path and were likely unaffected.)

## What Went Wrong

### The trigger

PostgreSQL migrations in this project are **manual** — they are NOT applied automatically at
deploy time (see `CLAUDE.md` → "Applying Postgres (PlanetScale) migrations"). PR #101 bundled:

- **code** that reads the new column (`getOrCreateUserPreferences` /
  `getValidDefaultDashboardId` in `lib/user-preferences.ts` select `default_dashboard_id`), and
- **migration `0016`** (`drizzle-planetscale/0016_bizarre_blacklash.sql`) that adds it.

When #101 squash-merged to `main` (`9c66255`, 2026-06-16 15:36 AEST), Vercel auto-deployed the
**code** to prod. The **migration** had been applied only to `liveone-dev` (where 2a was built
and tested); the deliberate "apply to prod `sydney`" step (deferred per the migration runbook)
was missed before the merge. Prod code therefore queried a non-existent column.

### The failing query

`0016` is purely additive:

```sql
ALTER TABLE "users" ADD COLUMN "default_dashboard_id" integer;
ALTER TABLE "users" ADD CONSTRAINT "users_default_dashboard_id_dashboards_id_fk"
  FOREIGN KEY ("default_dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE set null;
CREATE INDEX "users_default_dashboard_idx" ON "users" USING btree ("default_dashboard_id");
```

On prod, `users` had `default_system_id` but not `default_dashboard_id`. `getOrCreateUserPreferences`
selects `default_dashboard_id` on essentially every authenticated page (the `/dashboard` landing
calls it via `getValidDefaultSystemId`), so the missing column produced a 500 across the app.

### Why it wasn't caught

- Migrations are decoupled from deploys, so code can ship to prod ahead of its schema.
- No guard compares the deployed code's expected migration high-water against prod's applied
  migrations (`drizzle.__drizzle_migrations`), so the drift was silent.
- `liveone-dev` and prod `sydney` share the **same PlanetScale gateway host**
  (`aws-ap-southeast-2-1.pg.psdb.cloud`), distinguished only by the role/branch-id. "Applied to
  dev, forgot prod" is therefore an easy and invisible mistake — the migrate target is just
  whatever `.env.local` points at.

## Detection

User reported prod `/dashboard` showing the "Application error" page (screenshot, digest
`356207801`).

## Resolution

1. **Ruled out an accidental prod change from this session.** Confirmed the session's DB
   operations (the `0017` dev migration + a dev test-row delete) targeted `liveone-dev` (role
   branch `8oy9e46p40sr`), not prod (`PLANETSCALE_PROD_BRANCH_ID = 91nbdvyn5o2z`). Prod's
   database had not been altered by the session.
2. **Diagnosed on prod.** Minted a short-TTL `pscale role` on `sydney`; confirmed `users` was
   missing `default_dashboard_id` and that `0016` was the only `main` migration not yet applied
   to prod (prod was exactly one migration behind).
3. **Applied `0016` to prod** via `drizzle-kit migrate`, targeting the minted prod URL through
   `PLANETSCALE_DATABASE_URL_MIGRATIONS`. The local migration journal was **temporarily limited
   to ≤ `0016`** (using `main`'s `_journal.json`) so the in-flight, unmerged `0017` (Phase 2b-2,
   on the feature branch) was **not** applied — avoiding prod schema drift ahead of `main`. The
   journal was restored immediately after.
4. **Verified recovery.** Confirmed `default_dashboard_id` now exists on prod and that
   `www.liveone.energy/dashboard` renders normally for an authenticated admin.
5. **Cleaned up.** Reassigned temp-role-owned objects (the new index) to `postgres` and deleted
   all temporary `pscale` roles (the table-ownership trap in `CLAUDE.md`).

## Timeline (AEST)

- **15:37** — PR #101 squash-merged to `main` (`9c66255`); Vercel auto-deploys 2a/2b-1 code to
  prod. Migration `0016` is live on `liveone-dev` only.
- **15:37 →** — Prod `/dashboard` and all authenticated pages return 500 (missing column).
- **~21:2x** — User reports prod down.
- **~21:2x** — Diagnosed (prod `users` lacks `default_dashboard_id`; `0016` unapplied to prod).
- **~21:25** — `0016` applied to prod `sydney`; column verified; prod `/dashboard` renders again.
- **~21:25** — Temp roles reassigned + deleted; prod clean.

## Lessons Learned

1. **Never deploy schema-dependent code ahead of its migration.** Apply the migration to prod
   **before** (or atomically with) merging the code that needs it.
2. **Expand/contract is the safe shape.** Ship the additive migration in its own PR, confirm it
   on prod, then ship the code that uses the new column.
3. **Shared gateway host makes "forgot prod" invisible** — applying to `liveone-dev` looks
   identical to applying to prod except for the role/branch-id. Always confirm the branch-id
   before AND after applying.

## Action Items

- [ ] **Release checklist gate:** for any schema-dependent PR, "migration applied to `sydney`
      and verified" must be checked before merge. Add to PR template / `docs/migrations.md`.
- [ ] **Schema-drift alarm:** a deploy-time or scheduled check that compares the code's expected
      migration set vs prod `drizzle.__drizzle_migrations`, alerting via
      `OBSERVATIONS_ALERT_WEBHOOK_URL` on mismatch.
- [ ] **Consider auto-applying additive (forward-only) migrations on deploy** to remove the
      manual gap entirely for the common, safe case.
- [ ] **Defensive reads / flagging:** where practical, gate code that depends on a brand-new
      column behind a flag until the migration is confirmed on prod.
- [ ] **Follow-up for Phase 2b-2:** migration `0017` is currently on `liveone-dev` + the feature
      branch only. When 2b-2 merges, apply `0017` to prod `sydney` **before** the merge deploys
      its dependent code.

## Status

- [x] Issue identified
- [x] Root cause determined
- [x] Prod restored (migration `0016` applied to `sydney`)
- [x] Recovery verified (authenticated `/dashboard` renders)
- [x] Temp roles cleaned up
- [ ] Prevention action items implemented
