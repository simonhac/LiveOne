# Keeping `liveone-dev` in sync (DB + KV)

> **Status:** current — last verified 2026-07-20.

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
**`workflow_dispatch`** (the manual "bring up to date" button). One job, ordered steps:

| Step        | Script                                        | npm                     | Writes                 |
| ----------- | --------------------------------------------- | ----------------------- | ---------------------- |
| DB top-up   | `scripts/utils/sync-prod-to-dev-db.ts`        | `db:sync-dev-db`        | `liveone-dev` Postgres |
| Run periods | `scripts/utils/recompute-dev-runs-from-db.ts` | `db:recompute-dev-runs` | `device_run_periods`   |
| KV rebuild  | `scripts/utils/rebuild-dev-kv-from-db.ts`     | `db:rebuild-dev-kv`     | `dev:` KV namespace    |

Both later steps run **after** the DB sync so they reconstruct from the data that was just loaded —
all three stay consistent. The run-period step exists because dev crons are off (nothing recomputes
runs organically) and `device_run_periods` can't be copied by the DB sync — it has a composite PK
(so no `mirror`) and its rows shift/merge under recompute, which a row-copy would orphan. The
`device_trackers` config table _is_ copied by the DB sync; the runs are then recomputed from the
synced `point_readings` via the same delete-and-reinsert the prod cron uses. Any step failing trips the `Alert on failure` step
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

**Transport:** it holds exactly TWO persistent `pg` connections for the whole run (one read-only
prod, one dev-write) and streams each table `COPY (SELECT …) TO STDOUT` (prod) →
`COPY sync_staging.<t> FROM STDIN` (dev) over them — no `psql`, no temp files. The DB is in Sydney
and CI runs cross-Pacific, so a fresh connection costs ~1s of TCP+TLS+auth; the old
psql-per-operation design paid that ~150× (≈190s of pure handshakes, independent of row count).
Two connections pay it twice. Any query rejection (bad statement, COPY constraint violation, broken
stream) fails the whole run — nothing is swallowed.

**Safety:** it refuses to run if the write target resolves to the prod host/branch (it compares
the username and the `PLANETSCALE_PROD_BRANCH_ID` token), so a mis-pasted URL can't write prod.
Needs `PG_PROD_RO_DATABASE_URL` (read-only prod role) and `LIVEONE_DEV_DATABASE_URL` (dev write
role) as GitHub secrets.

> **The watermark never looks backwards.** For incremental tables the watermark is
> `max(<watermark col>) − overlap` read from **dev**, and live writes push dev's max forward
> continuously. So a row written to prod with an `updated_at` _below_ dev's current high-water mark
> can never be copied — most importantly, **a historical backfill applied to prod is invisible to
> the mirror forever** (and a single failed leg strands everything written during it). This bit us
> on 2026-07-12: the Amber import backfill left `liveone-dev` 12,888 rows short for system 9 while
> prod was complete, and dev had to be reseeded by hand — see
> `docs/incidents/2025-11-26-amber-import-channel-collision.md`. As of 2026-07-25 the whole
> `point_readings_agg_5m` table is ~560k rows (~9%) short on dev for the same reason.
>
> **Corollary: never use the mirror as evidence about prod.** "Is the data there?" must be answered
> against `sydney`. After any prod-side backfill, reseed the affected rows into dev explicitly.

> **Schema drift caveat.** The sync derives its column list from the **dev** schema and selects
> those columns from prod. If `liveone-dev` has columns prod lacks (a migration applied to dev
> but not prod, or out-of-band experimentation), the copy aborts on that table. Fix by realigning
> dev's schema to prod (or applying the missing migration to prod) — see the "full reset" below.

### Connection forensics in the log

Both connections are instrumented (`lib/db/planetscale/connection-forensics.ts`) for the dropout
investigation in
[`docs/incidents/2026-07-25-…`](incidents/2026-07-25-prod-dev-sync-connection-dropouts.md). Two
line shapes show up in the Actions log; both are diagnostic only and can never fail the run.

- `[sync:prod] conn-path {…}` / `[sync:dev] conn-path {…}` — once per connection, at connect.
  `verdict` is deliberately **one-sided**: **`pooled`** (i.e. `portMismatch: true`) is positive proof
  that a PgBouncer re-originated the connection — we dial 6432, the backend reports 5432. Anything
  else is **`inconclusive`**, never "direct", because `inet_server_port()` only sees the last hop and
  a transparent same-port proxy would be invisible. Also snapshots the _server-side_ limits, which
  client config can't show: `statementLimit`, `idleTxnLimit`, `idleSessionLimit`, `keepalivesIdle`
  (PG's `statement_timeout`, `idle_in_transaction_session_timeout`, `idle_session_timeout`,
  `tcp_keepalives_idle` — renamed to keep the word "timeout" out of the log, which would otherwise
  mis-bucket unrelated failures in `classifyWorkflowFailure`).
- `[sync:prod] socket-death {…}` — only on a close we did **not** initiate (judged from pg's own
  `_ending` flag at the moment distress arrives, so a genuine drop is still reported even though the
  `finally` block ends the client straight afterwards). `shape` is the discriminator, one of exactly:
  - `FIN (graceful close by peer — deliberate)` → something closed the session on purpose — a
    pooler, gateway or load balancer. Postgres itself would have sent an ErrorResponse (`57P01`, …)
    first, which `pg` surfaces _with_ a SQLSTATE.
  - `RST (hard reset — network-shaped)` → a transport-level abort.
  - `closed with neither FIN nor error` → the socket vanished without either signal.
  - `phase` says whether the client died mid-table or while **idle** (the prod client idles through
    every dev-side upsert), which separates an idle-reap from a mid-stream failure. It reads
    `(not tracked)` on the pooled paths, which don't set phases.
- `[sync:prod] backend-drift {…}` — emitted on the success path only, if the backend PID or address
  changed mid-run. That would disprove the "two persistent connections" premise (a transaction-mode
  pooler swapping backends, or a failover).

The recompute leg logs the same `conn-path` line under `[recompute]`; the shared app pool logs
`socket-death` under `[PlanetScale]`.

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
