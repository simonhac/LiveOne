# Applying non-destructive migrations at deploy time

> **Status: DEFERRED, not rejected** — drafted 2026-09-14 out of the question "are our migrations
> applied idiomatically?", and parked the same day by Simon: *"I'm less sure about doing the
> deploy-time migrations. Let's just start with the alerting if we don't apply a migration that was
> required."*
>
> So the only part being built is [§ Prerequisites](#prerequisites) item 1 — the BetterStack monitor
> on the drift probe that already exists (`betteruptime_monitor.liveone_migrations_in_sync` in
> `simonhac/infra`). **That is deliberately the right order**: the monitor closes the 2026-06-16 hole
> on its own, needs no new credential, and is the backstop this plan's R6 depends on anyway. Nothing
> below has been built, and none of it should be started without a fresh decision.
>
> If you come back to this: the cheapest useful next step is **stage 3** in
> [§ Rollout](#rollout) — CI *classifies and blocks* without applying anything, which catches the
> outage shape with no production DDL credential in CI at all. Stage 4 is the part carrying the real
> risk surface.
>
> **The measured headline, before the design:** under a fail-closed classifier, **35 of the 75
> migrations in `drizzle-planetscale/` would have auto-applied; 40 would not.** This automates a bit
> under half of what we actually write. An earlier estimate of "56 of 75" used *"contains no `DROP`"*
> as the test, which is not the same question — see [§ What counts as non-destructive](#what-counts-as-non-destructive).

## Why change anything

Migrations here are manual, and that is a defensible choice: Vercel has **no release phase**. Railway
has `preDeployCommand`, Heroku and Fly have a release step — one process, once per deploy, after the
build and before traffic shifts. Vercel has no equivalent hook, and Vercel's own guidance is to run
migrations "from CI before the deploy" rather than at app startup. So the options are not
manual-vs-automatic; they are **which place you bolt a release phase onto**.

What is *not* defensible is the current cost/benefit. We pay the full price of manual —
remember the step, for every schema change, forever — and collect none of the safety it is meant to
buy:

- `docs/incidents/2026-06-16-prod-down-default-dashboard-migration-not-applied.md` is a **5h50m prod
  outage** caused by exactly this gap, and its own action items still carry the unchecked box
  *"Consider auto-applying additive (forward-only) migrations on deploy."*
- `/api/health?migrations=1` already computes `applied` / `expected` / `inSync`. **Nothing watches
  it.** No monitor, no cron, no alert — only two mentions in docs.

So: alarm the thing we already compute, then automate the half of migrations that is genuinely
mechanical, and keep a human on the half that is not.

## The mechanism

### Vercel stops owning the production deploy

```json
// vercel.json
{ "git": { "deploymentEnabled": { "main": false } } }
```

Per-branch, and unspecified branches default to `true` — so **preview deploys and
`preview-alias.yml` are untouched**. Only `main` stops auto-deploying, because only `main` needs an
ordered "migrate, then deploy".

This is the load-bearing decision, and the alternative is worse. Putting `drizzle-kit migrate` in
the Vercel **build command** looks simpler and is not: preview builds resolve
`PLANETSCALE_DATABASE_URL` to the **shared `liveone-dev`**, so every branch's in-progress migration
would land on the shared dev database — including migrations that never merge — and then fight the
2-hourly prod→dev sync. You would gate it to `VERCEL_ENV=production`, at which point you have CI's
complexity without CI's concurrency control.

### The pipeline

A new `.github/workflows/deploy-prod.yml`, `on: push: branches: [main]`:

```yaml
concurrency:
  group: deploy-prod
  cancel-in-progress: false   # 🛑 see R7 — a cancel mid-apply resurrects the ownership trap
```

1. **Read pending.** Compute journal-minus-applied using the **existing** `PG_PROD_RO_DATABASE_URL`
   secret. Deciding what to do needs no DDL credential at all.
2. **Classify, and verify the declaration.** Every pending migration is `AUTO`, `DEFER` or `BLOCK`
   (below). Assert each file's `sha256` matches the journal entry, so the SQL classified is the SQL
   drizzle will run.
3. **Gate.**
   - all pending are `AUTO` → continue.
   - any `DEFER` (a pure contract migration, code-first by design) → continue **without applying
     it**, and say so loudly in the run summary and in Slack. `0074` is this case: it *must* wait
     until after the deploy.
   - any `BLOCK` → **stop. Do not deploy.** The code may depend on a schema change a human has not
     made yet; deploying it is the 2026-06-16 outage.
4. **Apply** the `AUTO` set: mint a short-TTL `pscale role`, run the existing
   `scripts/ops/pg-migrate.ts` with a new `--auto-only`, reassign ownership to `postgres` in the
   `finally` it already has, release the role.
5. **Assert `applied == expected`** afterwards. Not `>=`: this is what catches drizzle's silent skip
   (R6).
6. **Build and deploy:** `vercel pull --environment=production` → `vercel build --prod` →
   `vercel deploy --prebuilt --prod`. `VERCEL_TOKEN` is already a repo secret (`preview-alias.yml`
   uses it).
7. **Verify:** `scripts/utils/wait-for-deploy.sh --sha $GITHUB_SHA`, then assert
   `/api/health?migrations=1` reports `inSync: true`.
8. **Record:** one Slack row naming every migration applied (`SLACK_BOT_TOKEN` is already a secret;
   this mirrors `pg-backup`'s daily row). See R10 — without this the only record is a 90-day Actions
   log.

## What counts as non-destructive

**Fail closed: an allowlist of statement forms, not a denylist of dangerous ones.** A denylist is
wrong here because the dangerous set is open-ended — it is not just `DROP`; it is `RENAME` (breaks
running code while destroying no data), `SET NOT NULL` (fails or locks), `ALTER COLUMN … TYPE` (table
rewrite), and arbitrary `DO $$ … EXECUTE format(…)` dynamic SQL that no matcher can read.

Permitted, and nothing else:

| Allowed | Notes |
| --- | --- |
| `CREATE TABLE` / `CREATE SCHEMA` / `CREATE TYPE` | new objects, invisible to old code |
| `ALTER TABLE … ADD COLUMN` | must be nullable, and no volatile `DEFAULT` |
| `ALTER TABLE … ADD CONSTRAINT` | FK validation scans the table — subject to the size guard (R3) |
| `CREATE [UNIQUE] INDEX` | non-concurrent, so **subject to the size guard** (R3) |
| `ALTER TABLE … ALTER COLUMN … DROP NOT NULL` | relaxing only |
| `COMMENT ON` | — |

Classified `DEFER` (deploy first, apply by hand after): a migration whose every statement is
`DROP TABLE` / `DROP COLUMN` / `DROP CONSTRAINT` / `DROP INDEX`, optionally with `DO $$` gate blocks
that only `RAISE`. Everything else is `BLOCK`.

**Better than inferring: let the migration declare itself.** A header comment
`-- liveone:apply=auto|defer|manual` states intent, and the classifier's job becomes *verifying the
declaration* rather than guessing it — a file declaring `auto` while containing a `DROP` is refused.
Absent declaration ⇒ `BLOCK`. This also means the author decides at write time, when they know, not
CI at merge time, when it can only pattern-match.

### Measured against the real corpus

Running the allowlist over all 75 migrations (statements split on drizzle's own
`--> statement-breakpoint`, comments stripped):

```
AUTO-APPLY: 35    MANUAL: 40

why manual (files overlap):
  27  DO $$ block
  24  unrecognized statement form
  24  drop
   7  DML (INSERT/UPDATE/DELETE)
   5  SET NOT NULL
   5  rename
   2  ALTER COLUMN … TYPE
```

So roughly **half**, and the `DO $$` count is the interesting one: 27 files carry hand-written
validation gates, which is this repo's strongest migration habit (post-0016, post-0056). Those
migrations *should* stop for a human — the gate exists because someone thought hard about what could
go wrong.

## The new risk surface

Ordered by how likely I think each is to actually happen, not by blast radius.

### R3 — lock contention from a migration the classifier called safe **(most likely)**

`CREATE INDEX` without `CONCURRENTLY` and `ADD COLUMN … NOT NULL DEFAULT <volatile>` take
`ACCESS EXCLUSIVE`. This is not hypothetical for the allowlist above: the `AUTO` set of the existing
corpus contains `CREATE INDEX` on **`point_readings` (~15.6M rows)** and **`point_readings_agg_5m`
(~3M)**. And drizzle runs **every pending migration in ONE transaction**, so the lock is held for the
whole batch, not per statement.

Effect: `/api/observations/receive` — the single writer — blocks, the minutely poll times out, an
ingest gap opens, and the `liveone-poll-collector` heartbeat goes red. A "safe, additive" migration
takes production ingest down.

Mitigations, all three needed:

- A **runtime** size guard in the applier: for every `CREATE INDEX … ON <table>`, read
  `pg_class.reltuples` and refuse above ~100k rows, naming the `CONCURRENTLY`-by-hand path. Runtime,
  not a static table list, so it can't rot.
- `SET lock_timeout = '3s'` on the migration session. Without it a DDL statement that *waits* for a
  lock queues ahead of every subsequent reader — the classic "one migration froze the whole
  database" shape.
- `SET statement_timeout` as a backstop.

`CREATE INDEX CONCURRENTLY` can never go through this path anyway: it cannot run inside a
transaction, and drizzle's migrator always opens one. One migration in the corpus already needed the
hand route for exactly this reason.

### R6 — drizzle's silent skip now goes unattended

`drizzle-orm`'s migrator decides what is pending with `select … order by created_at desc limit 1`
and then applies anything whose `folderMillis` is **greater** than that. It is a **timestamp
high-water mark, not a set difference**. A migration that arrives later with an *older* timestamp —
precisely the parallel-Conductor-workspace `NNNN` collision that `CLAUDE.md` warns about — is
**skipped forever, reporting success**.

Today a human reads the output. Under automation nobody does, which makes the `inSync` monitor
**load-bearing infrastructure rather than a nicety**, and is why step 5 asserts `applied == expected`
rather than `>=`.

### R1 — a production DDL capability now lives in CI

Today, prod DDL requires Simon's laptop and a PlanetScale login: `vercel env ls` confirms
`PLANETSCALE_DATABASE_URL_MIGRATIONS` exists **only in the `Development` scope**, the runtime role
inherits just `pg_read_all_data,pg_write_all_data`, and CI holds only read-only prod URLs. After this
change, anything that can push to `main`, edit a workflow, or fire a `workflow_dispatch` can execute
DDL on production. Blast radius: total. Likelihood: low (sole committer, and fork PRs never receive
secrets).

- **Never `pull_request_target`** in this workflow. That is the one mistake that turns a public repo
  into an open DDL endpoint.
- Prefer minting per run over a standing credential: a `PLANETSCALE_SERVICE_TOKEN` + `pscale role
  create --ttl` (what `pg-migrate` already does locally) over a permanent DDL connection string in
  GitHub. The minted role inherits `postgres`, so this is not *less* power — the gain is no
  long-lived DDL string sitting in a second place, and the ownership reassign already being handled.
- Scope the trigger with `paths:` and keep branch protection on `main`.

### R2 — the classifier is the whole safety boundary, and it is a text matcher

Evasions to design against explicitly: dynamic SQL in a `DO $$ … EXECUTE format(…)` block (hence
`DO $$` ⇒ never `AUTO`); a destructive tail after an allowlisted head (hence split on drizzle's own
breakpoint, strip comments, and match **every** statement); a file edited after generation (hence the
`sha256`-matches-journal assertion). Anything unrecognized is `BLOCK`, never "probably fine".

### R7 — no advisory lock, and cancellation is the sharp edge

drizzle takes no advisory lock, so two pushes in quick succession would mean two appliers racing.
GitHub's `concurrency` group serializes them — but **`cancel-in-progress` must be `false`**. A cancel
between `apply` and the ownership `reassign` leaves tables owned by a role that is about to expire,
which is the table-ownership trap: `DROP ROLE` refuses, and prod gets "permission denied for table
X" whenever the dependent code finally ships. Add a weekly scheduled `pg-migrate --audit` sweep to
catch a leaked owner, since a SIGKILL can always beat a `finally`.

### R4 — CI becomes a single point of failure for deploys

With `deploymentEnabled: {main: false}`, a broken workflow, an expired `VERCEL_TOKEN` or a GitHub
Actions outage means **no production deploys at all**. Recovery is to flip the flag back or run
`vercel --prod` from a laptop — worth writing into the doc that fixes it, because the failure mode
looks like "the merge did nothing".

### R5 — rollback stops restoring schema

Vercel's instant rollback reverts code only. Forward-only + additive-first keeps that safe (old code
ignores a new nullable column), but this remains the reason contract migrations stay manual: nothing
about auto-apply makes a `DROP` reversible.

### R9 — dev and preview now lag prod

Prod becomes the most-current environment, inverting today's habit. `liveone-dev` still needs a
hand-applied migration, a restore from R2 reverts its journal, and a preview of a branch carrying a
new migration 500s until dev is migrated. All true today — but today's pain is the thing that keeps
them in step, and automation removes it. Either extend the same applier to the sync workflow, or
accept and document.

### R10 — the audit trail thins out

Schema changes stop passing through a human. The only record becomes a 90-day Actions log, which is
why step 8 posts a Slack row. Related, and already true: `pg-migrate` swallows Postgres `NOTICE`s, so
`0074`'s "dropping N frozen rows" count went unrecorded. Fix that in the same pass.

### R11 — PR authoring changes

The pipeline enforces expand/contract **by refusal**: a PR shipping a `SET NOT NULL` migration
together with the code that needs it gets `BLOCK`ed and must be split. That is the correct shape, and
it is a behaviour change, not just a tool.

## Prerequisites

1. **A BetterStack `keyword` monitor on `/api/health?migrations=1`, required keyword `"inSync":true`,
   with a 1800 s confirmation period** (so an intended contract window like `0074`'s ~20 minutes does
   not page). This is the backstop for R6 and the fix for the 2026-06-16 gap, and it is worth having
   on its own — it needs no code in this repo.
   🛑 **It is declared in the `simonhac/infra` repo, not by hand** — `iac/project_liveone.tf`,
   OpenTofu, applied through `scripts/tofu.sh`. Creating a BetterStack monitor on `liveone.energy`
   outside that state is actively harmful, not merely untidy: `ssl_expiration` / `domain_expiration`
   are per-DOMAIN in BetterStack, so a monitor created with default expiry settings silently rewrites
   them for **every** existing liveone monitor.
2. `pg-migrate`: relay Postgres `NOTICE`s to stderr, and add `--classify` / `--auto-only`.
3. Correct `docs/migrations.md`, which currently cites the 2026-06-16 incident as the *reason*
   migrations are manual when that incident argues the opposite.

## Rollout

| Stage | What | Reversible by |
| --- | --- | --- |
| 1 | the monitor + `NOTICE` relay | deleting a monitor |
| 2 | `--classify` in `pg-migrate`, reporting only; run it on a few merges by hand to see what it says | it changes nothing |
| 3 | CI **classifies and blocks** but still lets Vercel deploy — catches the 2026-06-16 shape with no DDL credential in CI at all | deleting a workflow |
| 4 | CI owns the prod deploy and applies the `AUTO` set | `deploymentEnabled: true` |

Stage 3 is where most of the safety lands, and it needs **no** new credential — only the read-only
prod URL already in CI. Stage 4 is the convenience.

## Open decisions

1. **Credential:** standing DDL secret, or `PLANETSCALE_SERVICE_TOKEN` + mint per run? (recommend the
   latter)
2. **Do we take over prod deploys** for correct ordering, or keep Vercel's git deploy and accept a
   ~1-minute race where code can go live before its additive migration? (recommend taking over —
   otherwise stage 4 buys ordering it cannot guarantee)
3. **Declaration header required** on every new migration, or inference only? (recommend required;
   absent ⇒ `BLOCK`)
4. **Does a `BLOCK` stop the deploy** or merely warn? (recommend stop)
