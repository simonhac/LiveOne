# Observations → Postgres mirror — Phase 1 runbook

**Goal:** turn on the live QStash → PlanetScale Postgres pipeline so new observations
and sessions land in Postgres in real time. **Turso stays the source of truth.**
Historical backfill from Turso is a separate, deferred step.

## What changed in code (this branch)

- **Consumer no longer silently drops** (`app/api/observations/receive/route.ts`):
  returns 500 (→ QStash retry) when `PLANETSCALE_DATABASE_URL` is unset, instead of
  acking and dropping.
- **Full 5-minute fidelity:** the queue payload now carries the whole aggregate
  tuple (`avg/min/max/last/delta/sampleCount/errorCount/valueStr/dataQuality`)
  instead of a single collapsed value. Producer: `lib/observations/types.ts`,
  `lib/observations/publisher.ts`, `lib/point/point-manager.ts`. Consumer writes the
  real columns (and stays backward-compatible with old single-value messages).
- **Session ids preserved:** the consumer inserts Postgres `sessions` with the Turso
  session id as the primary key, so `point_readings.sessionId` joins `sessions.id`.
- **Batched inserts:** one statement per table per message (was per-row).
- New scripts: `scripts/seed-planetscale-refs.ts`, `scripts/purge-observations-queue.ts`.

## Operator steps (need prod credentials / prod access)

### 1. Provision env vars

The Postgres connection is read from EITHER discrete fields (preferred — this is what's
set) OR a single connection string. Set in Vercel (Production; choose Preview
deliberately — sharing a DB means preview deploys write into prod) **and** `.env.local`
(needed for the local `drizzle-kit push` and seed script):

```
DB_HOST=<host>
DB_PORT=<port, e.g. 5432>
DB_DATABASE=<database>
DB_USERNAME=<user>
DB_PASSWORD=<password>
# DB_SSL=disable   # only for a local non-TLS server; default is TLS
```

Alternatively a single URL works for both runtime and migrations:
`PLANETSCALE_DATABASE_URL` (runtime) / `PLANETSCALE_DATABASE_URL_MIGRATIONS` (DDL).
Both the consumer and `drizzle-kit` accept either form.

The QStash vars (`OBSERVATIONS_QSTASH_TOKEN`, `OBSERVATIONS_QSTASH_RECEIVER_URL`,
`OBSERVATIONS_QSTASH_URL`, `OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY`,
`OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY`) are already set.

### 2. Push the schema

```
npx drizzle-kit push --config=drizzle-planetscale.config.ts
```

Verify the unique indexes exist (they back the consumer's `onConflictDoNothing`
dedup): `pr_point_time_unique`, the `point_readings_agg_5m` PK, and
`sessions_system_created_at_unique`.

### 3. Seed reference tables (systems + point_info)

Live readings need metadata to join. Dry-run first, then apply:

```
NODE_ENV=production npx tsx scripts/seed-planetscale-refs.ts            # dry run
NODE_ENV=production npx tsx scripts/seed-planetscale-refs.ts --apply    # write
# add --with-users to also seed users + user_systems
```

(`NODE_ENV=production` makes the Turso client read **prod** Turso. Omit it to seed a
dev Postgres from local `dev.db`.)

### 4. Deploy this branch

Deploy with `PLANETSCALE_DATABASE_URL` live. This ships the hardened consumer **and**
the enriched producer together. Confirm the deployed receiver URL matches
`OBSERVATIONS_QSTASH_RECEIVER_URL` / `getObservationsReceiverUrl()`.

### 5. Resume to drain the backlog into Postgres

Check the depth on `/admin/observations/dashboard` ("Observations queued"). This is the
original goal — pull the queued observations into Postgres.

**Two caveats to know before draining:**

- **Retention:** a paused QStash queue does not keep messages forever, so the backlog
  is whatever _survived retention_ — possibly a partial/arbitrary window, not the full
  history. Turso (dual-write) has the **complete** record; use the deferred Turso
  backfill to fill any gaps.
- **5m fidelity:** raw observations drain at full fidelity. Old 5-minute aggregates were
  published before the fidelity fix, so they arrive with only `last` populated. The
  deferred Turso backfill (**upsert**) corrects them.

Before resuming:

1. Deploy the hardened consumer (no-drop + backward-compatible) so old-shaped messages
   land and nothing is dropped.
2. Bump parallelism for the drain (steady-state default is 1; keep ≤ 8, under the PG
   pool max of 10), if your QStash plan allows:
   ```
   curl -X POST .../api/admin/observations/info \
     -H 'content-type: application/json' \
     -d '{"action":"set-parallelism","parallelism":8}'
   ```
3. **Resume** from `/admin/observations`. The backlog drains through the consumer into
   Postgres — watch the dashboard: "Observations queued" falls, "Observations (24h)"
   rises, the chart fills.
4. When the drain is done, drop parallelism back to 1 for steady state.

**Alternative — start clean instead of draining:** if you'd rather populate Postgres
entirely from Turso (complete + full fidelity) and skip the lossy backlog, purge first:

```
npx tsx scripts/purge-observations-queue.ts --confirm  # purge + recreate paused
```

## Verify

- **Single message:** trigger a poll, watch `lag` decrement on `/admin/observations`,
  and check logs for `[ObservationsReceiver] Processed: {...}` with non-zero
  `rawInserted`/`agg5mInserted`/`sessionInserted`.
- **Reconcile (post-turn-on window only):** for `[t0,t1)` with `t0` ≥ turn-on, compare
  per-system `count(point_readings)` / `count(point_readings_agg_5m)` Turso vs Postgres.
  Spot-check agg_5m rows have real `avg/min/max/delta/sampleCount` (not `last`-only).
- **Join:** `point_readings JOIN sessions ON sessionId` returns rows in Postgres.
- **Metadata:** every `(systemId, pointId)` in Postgres `point_readings` has a
  `point_info` row; every `systemId` has a `systems` row.
- **No-drop guard:** on a preview deploy with `PLANETSCALE_DATABASE_URL` unset, send a
  message and confirm the consumer returns 500 and QStash retries (lag does not fall).

## Rollback

This work only writes Postgres; Turso is untouched. If ingestion misbehaves, **pause
the queue** (`/admin/observations`) — publishing continues, messages accumulate, Turso
keeps serving. Seed script is idempotent; worst case `TRUNCATE` the Postgres tables and
re-run.

## Separate follow-up (env-scripts branch)

`env/env.config.json` (on the `simonhac/env-scripts` WIP, stashed) declares
`QSTASH_TOKEN` (wrong) and omits the Postgres vars. Apply there:
remove `QSTASH_TOKEN`/`QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY`; add
`OBSERVATIONS_QSTASH_TOKEN`, `OBSERVATIONS_QSTASH_RECEIVER_URL`, `OBSERVATIONS_QSTASH_URL`,
`OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY`, `OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY`,
`PLANETSCALE_DATABASE_URL`, `PLANETSCALE_DATABASE_URL_MIGRATIONS`.

## Deferred (not in this phase)

Backfill historical `point_readings` / `point_readings_agg_5m` / `sessions` from Turso
into Postgres. When done, read the real aggregate columns from Turso (full fidelity)
and preserve Turso session ids; **upsert** so it can overwrite any lossy rows.

```

```
