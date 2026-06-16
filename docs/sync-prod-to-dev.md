# Keeping `liveone-dev` in sync (DB + KV)

> **Status:** current — last verified 2026-06-16.

`liveone-dev` is the single datastore shared by **local dev and Vercel preview** (see
`CLAUDE.md` → "`liveone-dev` — the shared dev/preview database"). It is never prod. Because
**crons are off in dev/preview** (`CRONS_ENABLED` unset), nothing polls vendors there, so dev
data does not advance on its own — it has to be topped up from prod. Two stores need topping up:

1. **Postgres** (`point_readings`, aggregates, sessions, config tables) — the source of truth.
2. **Vercel KV** (latest-value cache, system summaries, subscription registry) — the fast read
   path the dashboards use for "live" cards.

Both are refreshed together by one scheduled job. This doc is the _why_ and the runbook; the
mechanics live in code (linked below).

## What runs, and when

`.github/workflows/sync-prod-to-dev.yml` runs **every 2 hours** (`cron: "20 */2 * * *"`) and on
**`workflow_dispatch`** (the manual "bring up to date" button). One job, two ordered steps:

| Step       | Script                                    | npm                 | Writes                 |
| ---------- | ----------------------------------------- | ------------------- | ---------------------- |
| DB top-up  | `scripts/utils/sync-prod-to-dev-db.ts`    | `db:sync-dev-db`    | `liveone-dev` Postgres |
| KV rebuild | `scripts/utils/rebuild-dev-kv-from-db.ts` | `db:rebuild-dev-kv` | `dev:` KV namespace    |

The KV rebuild runs **after** the DB sync so it reconstructs KV from the data that was just
loaded — the two stay consistent. Any step failing trips the `Alert on failure` step
(`OBSERVATIONS_ALERT_WEBHOOK_URL`).

> The schedule runs from the workflow file on the **default branch** — changing the cron only
> takes effect once merged to `main`.

### Trigger it manually

```bash
gh workflow run sync-prod-to-dev.yml         # CLI
# or: GitHub → Actions → "Sync prod → liveone-dev" → Run workflow
```

No local credentials needed — the runner holds the GitHub Actions secrets.

## DB sync — incremental top-up

`sync-prod-to-dev-db.ts` reads prod with a **SELECT-only** role and writes **only** to
`liveone-dev`. Per the manifest in that file:

- **Large, time-keyed tables** (`point_readings`, aggregates, sessions): incremental — copy rows
  newer than the dev watermark minus a re-pull overlap, into UNLOGGED staging, then
  `INSERT … ON CONFLICT`. Cost ≈ _O(rows since last run)_, not table size.
- **Small config tables** (`systems`, `point_info`, `areas`, `area_bindings`, …): full refresh
  - upsert (no deletes).

**Safety:** it refuses to run if the write target resolves to the prod host/branch (it compares
the username and the `PLANETSCALE_PROD_BRANCH_ID` token), so a mis-pasted URL can't write prod.
Needs `PG_PROD_RO_DATABASE_URL` (read-only prod role) and `LIVEONE_DEV_DATABASE_URL` (dev write
role) as GitHub secrets.

> **Schema drift caveat.** The sync derives its column list from the **dev** schema and selects
> those columns from prod. If `liveone-dev` has columns prod lacks (a migration applied to dev
> but not prod, or out-of-band experimentation), the copy aborts on that table. Fix by realigning
> dev's schema to prod (or applying the missing migration to prod) — see the "full reset" below.

## KV rebuild — reconstructed from the DB

KV is **shared across environments** and separated by an env key prefix (`kvKey()` in `lib/kv.ts`
→ `prod:` / `dev:` / `test:`, driven by `getEnvironment()`). So there is nothing to "replicate
between instances" — it's one Redis, two namespaces. The `dev:` namespace simply isn't written
organically (crons off), so it goes stale.

`rebuild-dev-kv-from-db.ts` reconstructs the `dev:` namespace **purely from the dev Postgres DB**
— no prod KV access. It mirrors what live ingest (`lib/point/point-manager.ts`) does:

1. `buildSubscriptionRegistry()` — source-point → composite-subscriber reverse map, from
   `area_bindings`. Built **first** so step 2 can propagate to composite systems.
2. One latest reading per active, typed point (a LATERAL `LIMIT 1` per point, one index probe —
   never a scan) → `updateLatestPointValue()` for each (which also fans out to composite
   subscribers via the registry). It reads from **both** `point_readings` and
   `point_readings_agg_5m`, preferring raw and falling back to the 5-minute aggregate — 5m-native
   sources (OpenElectricity, etc.) only ever write `agg_5m`, so a `point_readings`-only query would
   silently drop those whole systems (e.g. the grid-signal cards).
3. `updateSystemSummary()` + `updateSubscriberSummaries()` per source system → the
   `dev:system-summaries` rollup hash.

**Safety:** refuses to run unless `getEnvironment() === "dev"` (so it can only write the `dev:`
namespace, never prod's live values), and inherits the app DB-layer prod guard
(`assertDbEnvironmentMatches` via `PLANETSCALE_PROD_BRANCH_ID`). Read-only against the DB; writes
only KV. Aborts loudly if `KV_REST_API_URL` / `KV_REST_API_TOKEN` are unset (otherwise the KV
client silently no-ops). Run locally with:

```bash
npx tsx --env-file=.env.local scripts/utils/rebuild-dev-kv-from-db.ts
```

### Why rebuild from the DB (not copy prod KV)?

KV is just "latest value per point", fully derivable from the readings tables. Rebuilding from the
dev DB needs no prod KV credentials, stays consistent with the data the DB sync just loaded, and
reflects dev's own config (e.g. composites that only exist in dev) — none of which a raw copy of
the `prod:` namespace would give you. The same script also warms a freshly-seeded Vercel preview
branch (see the `bind-preview` skill), so there's a single KV-rebuild path for every dev/preview
scenario.

## Full reset (when incremental isn't enough)

For schema realignment or a from-scratch refresh, restore the latest off-site R2 dump into
`liveone-dev` (schema + data in one shot) as the persistent `postgres` role — reuse the
`scripts/utils/restore-drill-pg.sh` flow targeting `liveone-dev` (see `CLAUDE.md` → "Seed / reset
from prod"). Then run the KV rebuild to repopulate `dev:` KV from the restored DB.

## Required secrets / env

| Name                                    | DB sync |            KV rebuild             | Notes                |
| --------------------------------------- | :-----: | :-------------------------------: | -------------------- |
| `PG_PROD_RO_DATABASE_URL`               |    ✓    |                                   | read-only prod role  |
| `LIVEONE_DEV_DATABASE_URL`              |    ✓    | ✓ (as `PLANETSCALE_DATABASE_URL`) | dev write role       |
| `PLANETSCALE_PROD_BRANCH_ID`            |    ✓    |                 ✓                 | arms the prod guards |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` |         |                 ✓                 | the shared KV store  |
| `OBSERVATIONS_ALERT_WEBHOOK_URL`        | (alert) |              (alert)              | failure notification |

## Related

- `docs/architecture/kv-store.md` — KV key layout, subscription registry, env namespacing
- `docs/architecture/data-model.md` — data semantics & invariants
- `CLAUDE.md` → "`liveone-dev` — the shared dev/preview database"
