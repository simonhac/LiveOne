---
name: pg-migrate-prod
description: >-
  Apply a Postgres migration to the LiveOne prod `sydney` branch (or any PlanetScale branch that
  needs a minted role), without leaving tables owned by a temporary role. Use for "apply 0063 to
  prod", "run the migration against sydney", "apply pending migrations to production", and for the
  symptoms of getting it wrong: `pscale role delete` refusing because the role still owns objects,
  a lingering `pscale role` that will not expire, or "permission denied for table X" on a table that
  plainly exists. Also use before deploying any schema-dependent code, since migrations here are
  MANUAL and are never applied at deploy time.
---

# Applying a Postgres migration to prod

## The one command

```bash
npm run pg-migrate                 # report: target, pending migrations, ownership audit
npm run pg-migrate -- --apply      # apply, reassign ownership to postgres, re-sweep to prove it
```

`npm run db:pg:migrate:prod` is the same tool under the name that sits next to `db:pg:migrate` in
`package.json` — because reaching for `db:pg:migrate` on prod is the mistake this exists to prevent.

Dry-run by default. `--audit` sweeps ownership alone (read-only role, applies nothing).
Full help: `npm run pg-migrate -- --help`, or `scripts/ops/pg-migrate.ts`.

**For `liveone-dev`, use plain `npm run db:pg:migrate`.** `.env.local` already points at the
persistent `postgres` role, so nothing is minted and the trap below cannot arise. That asymmetry is
the whole reason prod needs its own command.

## The trap, and why it keeps happening

Prod has **no stored connection string** — you mint a short-TTL `pscale role` each time. Postgres
makes the **creating role the OWNER** of everything it creates. `--inherited-roles postgres` grants
the privileges to create; it does **not** make `postgres` the owner of the result.

So a migration applied with a minted role leaves its new tables, indexes and sequences owned by a
role that is about to be deleted. Both consequences are **later** and **quiet**:

1. The app connects as `postgres` and gets **"permission denied"** on the new table — not at apply
   time, but whenever the dependent code finally ships. The migration said *success*.
2. `pscale role delete` **refuses** while the role owns objects, so the role lingers and its TTL
   delete fails the same way, every time, forever.

The remedy is one command — `pscale role reassign … --successor postgres` — and the entire problem
is that it is a **separate step after a migration that already reported success**. In the tool it is
a `finally`: it runs on success, on a failed migration, on a guard refusal, and on Ctrl-C. That is
the only thing this command guarantees over `drizzle-kit migrate`, and it is enough.

Verified behaviours (measured, not assumed): a fail-closed guard refusal still releases the role;
`reassign` is a no-op when the role owns nothing, so it is always safe to run.

## 🛑 Never use `pscale role reset-default` on prod

It is the other documented route to `postgres` credentials, and on prod it is an **outage**. Its own
help says it: *"Any connections using the `postgres` role will need to be updated with the new
credentials."* It **rotates the password**. Vercel captures env at **build** time, so recovery needs
the Production env updated **and a redeploy** — see the prod DB-env outage runbook.

Minting a temp role costs nothing and breaks nothing. There is no situation here where
`reset-default` is the right tool.

## Order of operations

1. **Rehearse on `liveone-dev` first** (`npm run db:pg:migrate`). Its config tables are a prod
   mirror, so the gates run against realistic data, and it is applied as `postgres` so it is not a
   test of the ownership path — it is a test of the SQL.
2. **Prove the constraints refuse what they claim**, on dev, inside a transaction you `ROLLBACK`.
   Watch for probes that are blocked by a *different* constraint first and therefore prove nothing —
   pick fixtures that make your new constraint the first thing in the way.
3. **Apply to prod**: `npm run pg-migrate -- --apply`.
4. **Then deploy the dependent code.** Migrations are manual and are *not* applied at deploy;
   merging schema-dependent code before the migration lands is a prod 500. Prefer expand/contract.

## What the tool checks, and what it does not

It guarantees **ownership**. It does **not** check that your migration was correct — gates belong in
the migration file, where they run inside the migrator's transaction and roll the whole thing back
on a `RAISE EXCEPTION`. See `docs/migrations.md` and 0055/0063 for the house style.

After `--apply`, still **verify the catalogue by name**: a migration that silently did nothing looks
exactly like one that worked.

## Two things that look like facts and are not

**The target is proved by the CONNECTION USERNAME, not the hostname.** PlanetScale puts every branch
in a region on **one** gateway host and tells them apart by the username suffix
(`postgres.<branch-id>`), so a host check proves nothing. Worse: inside Postgres, `current_user` has
that suffix **stripped**, so a server-side `current_user LIKE '%<branch-id>%'` guard
**false-negatives**. The URL is the only place the branch id is legible — same rule as the app's
`assertDbEnvironmentMatches`. The tool prints the username in its banner; read it before `--apply`.

**Drizzle decides what is pending by TIMESTAMP, not by hash.** Its pg dialect reads only the single
latest applied `created_at` and runs every journal entry whose `when` exceeds it. The recorded hash
is stored and never compared. Two consequences:

- A migration whose `when` is **below** the high-water mark is **silently skipped**, and `migrate`
  still reports success — the journal-drift failure where nothing changes and nothing says so.
  Renumbering or backdating a migration produces exactly this.
- An already-applied file that has since been **edited** is invisible. Do not edit an applied
  migration; write a forward one.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `permission denied for table X` on prod, table exists | X is owned by a deleted/expired minted role | `npm run pg-migrate -- --audit`, then `pscale role reassign liveone sydney <role-id> --successor postgres --force` |
| `pscale role delete` refuses | the role still owns objects | reassign first, then delete — never the other way round |
| A `pscale role` lingers past its TTL | same cause; TTL deletion fails identically | as above |
| `migrate` reports success but nothing changed | journal drift — `when` is below the high-water mark | check the catalogue, not the migrator; renumber so the entry sorts after the last applied one |
| Applied to the wrong branch | you trusted the hostname | the username suffix is the branch; the tool refuses both directions |

`--audit` is safe to run any time and against any branch: it mints a **read-only** role, which
cannot own anything either.

## Related

- `docs/migrations.md` — gates, row-count validation, the migration-0016 and -0056 lessons
- `drizzle-planetscale/README.md` — why never `drizzle-kit push`
- CLAUDE.md § *Applying Postgres (PlanetScale) migrations* — branches, roles, parallel-agent
  numbering collisions
