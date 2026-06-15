# Plan: migrate time-series time columns to `timestamptz`

> **Status:** proposed — not started (drafted 2026-06-13). Companion to the read-layer
> bugfix that made the admin readings views coerce the epoch-ms projection correctly
> (`::bigint` + `Number()` in `lib/db/planetscale/readings-read-pg.ts`). That fix is
> defensive; this plan removes the underlying epoch-ms round-trip entirely. **No schema
> change has been made — get explicit approval before generating/applying any migration**
> (see `CLAUDE.md` → Database Migrations).

## Why

Today every instant column is `timestamp without time zone`, storing UTC **by convention**.
The serving reads then convert to epoch-ms in SQL:

```sql
(EXTRACT(EPOCH FROM measurement_time AT TIME ZONE 'UTC') * 1000) AS measurement_time
```

…and the JS side does `new Date(ms)` before formatting. That convention is a holdover from
the Turso era (where rows were epoch-ms integers) and has three problems:

1. **Fragility.** In PostgreSQL 14+ `EXTRACT()` returns `numeric`, which node-postgres
   returns as a **string** — so `new Date("1781314162355.000000")` is an _Invalid Date_.
   This silently broke every admin raw/5m data viewer after the Postgres reads cutover
   (the `NaN-NaN-NaN…` timestamps bug). The `::bigint` + `Number()` fix patches it, but the
   class of bug exists wherever the epoch projection is consumed.
2. **Cost & noise.** An `EXTRACT … * 1000` per row on every read, plus the inverse
   `new Date()`/`Number()` dance scattered across the read layer and routes.
3. **A latent footgun.** Storing a naive `timestamp` means correctness depends on everyone
   agreeing it's UTC. If anything ever lets node-postgres auto-parse a bare `timestamp`, it
   interprets the wall-clock using the **server's** timezone and corrupts the instant.

`timestamptz` stores an unambiguous absolute instant. node-postgres returns it as a correct
JS `Date` **regardless of server timezone**, so:

- `EXTRACT(EPOCH …)*1000` and the epoch-ms intermediary disappear — the read layer selects
  the column directly.
- The server-timezone footgun is gone.
- The browser contract is **unchanged**: the API still emits ISO-8601 in the _monitored
  system's_ timezone (`systems.timezone_offset_min`), formatted by `formatTime_fromJSDate`.
- **ClickHouse migration:** `timestamptz` maps cleanly to `DateTime64` (both are instant
  types) — neutral-to-positive. Storing raw epoch-int instead would be a step _away_ from
  the idiomatic CH type, so this direction is the right one.

## Scope — columns to convert

All currently `timestamp(...)` in `lib/db/planetscale/schema.ts`. The instant columns that
matter for reads:

- `point_readings.measurement_time`, `point_readings.received_time`, `point_readings.created_at`
- `point_readings_agg_5m.interval_end`, `…created_at`
- `point_readings_agg_1d.created_at`
- Lower-traffic: `sessions.created_at`, `polling_status.last_poll_time` / `last_success_time`
  / `last_error_time`, `systems.created_at` / `updated_at`, and other `created_at`/`updated_at`.

Convert these for consistency, but they can be staged (the big time-series tables are what
delivers the read-path win). **Out of scope:** the `day` columns
(`point_readings_agg_1d.day`, `point_readings_agg_1d_flow.day`) stay `text` (`YYYY-MM-DD`,
system-local bucket key — not an instant; converting buys nothing and risks tz reinterpretation).

## Schema change

In `lib/db/planetscale/schema.ts`, change the affected columns to:

```ts
timestamp("measurement_time", { withTimezone: true }).notNull();
```

(Drizzle renders `{ withTimezone: true }` as `timestamp with time zone`.) Update the header
comment block (lines ~14–23) that documents the "timestamp (UTC, no timezone)" convention.

## Migration mechanics & risks

The correct, value-preserving conversion (stored naive values are already UTC wall-clock):

```sql
ALTER TABLE point_readings
  ALTER COLUMN measurement_time TYPE timestamptz USING measurement_time AT TIME ZONE 'UTC';
```

`x AT TIME ZONE 'UTC'` reads the naive timestamp **as UTC** and yields the right instant.

> ⚠️ **Critical gotcha.** `drizzle-kit generate` will emit a bare
> `ALTER COLUMN … SET DATA TYPE timestamp with time zone` **without** the
> `USING … AT TIME ZONE 'UTC'` clause. Postgres would then convert using the _session_
> `TimeZone`, which is **wrong** unless the session happens to be UTC. **Hand-edit the
> generated migration** to add the explicit `USING … AT TIME ZONE 'UTC'` for every column.

**Cost / locking.** `ALTER COLUMN … TYPE` **rewrites the whole table** and rebuilds its
indexes under an `ACCESS EXCLUSIVE` lock. On `point_readings` (~13M rows) and
`point_readings_agg_5m` (~3M) that is minutes of blocked reads **and** writes. The serving
store has a single continuous writer (`/api/observations/receive`), so a naive in-place
ALTER stalls ingestion for the duration.

Two ways to manage that — pick per measured rewrite time (test on a branch first):

- **A — brief ingestion pause (simplest here).** The pipeline already has a durable
  transactional outbox (`observations_outbox`) + QStash retries/DLQ, so a short pause is
  safe: messages queue and drain after. Pause the relay/receive, run the ALTERs, resume.
  Backlog clears via the relay. Good if the rewrite is a few minutes.
- **B — online add-column + backfill + swap.** Add `measurement_time_tz timestamptz`,
  backfill in batches (`UPDATE … WHERE id BETWEEN …`), keep it in sync, then swap names +
  rebuild indexes in a short transaction. More steps, minimal lock, and gives instant
  rollback (old column retained until verified). Use if the rewrite is too long to pause.

**Safety playbook** (from `CLAUDE.md` / `docs/migrations.md`, mandatory for destructive DDL):

- [ ] PITR window confirmed + one-off base backup (`pscale backup create`); off-site
      `pg_dump` via the `pg-backup` action.
- [ ] Tested on a throwaway PlanetScale branch restored from a base backup; **measure the
      rewrite time** there to choose strategy A vs B.
- [ ] Row-count validation in the migration (`DO`/`RAISE EXCEPTION`) before/after.
- [ ] Spot-check instants pre/post (`SELECT max(measurement_time)` matches the same wall
      time, now with `+00`).
- [ ] Indexes present after the rewrite (`pr_*_idx`, `pr5m_*_idx`).
- [ ] Generated migration hand-edited for the `USING … AT TIME ZONE 'UTC'` clause.
- [ ] **No `drizzle-kit push`** — generated migration only; apply via `npm run db:pg:migrate`
      (mind the `pscale role` table-ownership trap → reassign to `postgres`).

## Read-layer refactor (after the columns are `timestamptz`)

node-postgres now returns these columns as JS `Date`s. Remove the epoch-ms machinery:

- **`lib/db/planetscale/readings-read-pg.ts`** — drop the `EXTRACT(EPOCH …)*1000::bigint`
  projections (and the `Number()` coercion added by the bugfix); select the column directly.
  Decide the in-process shape:
  - _Minimal:_ keep the existing epoch-ms contract to consumers by doing `date.getTime()` in
    JS (drops the fragile SQL conversion, routes unchanged), **or**
  - _Cleaner:_ hand the `Date`/ISO straight through and adjust consumers.
- **Consumers** — the pivot route's `new Date(row.measurement_time)` already accepts a `Date`
  (clone); the single-point route's centering (`r.intervalEnd === timestamp`) and the
  pagination cursors must align with whichever shape is chosen.
- **`app/api/system/[systemId]/run-periods/route.ts`** + `lib/run-tracking/*` (which replaced the
  removed `generator-events` route) — audit any `Number(row.measurement_time)` projections
  accordingly. `app/labs/kinkora-hws/page.tsx` uses the same projection — update or leave (labs).

The front-end is untouched — it keeps receiving ISO-8601 in the system's timezone.

## Rollout & rollback

- This repo is **forward-only** (no down migrations). Strategy **B** gives the cleanest
  rollback: the original `timestamp` column survives until the `timestamptz` column is
  verified, so reverting is a name-swap. Strategy **A**'s rollback is another `ALTER … TYPE
timestamp USING col AT TIME ZONE 'UTC'` (another rewrite) restored from backup if needed.
- Ship the **schema + migration** first (DB now serves `timestamptz`, read layer still works
  because `new Date(Date)` clones); ship the **read-layer simplification** as a follow-up PR
  so the two are independently revertable.

## Verification

1. On a branch copy: row counts unchanged; `max(measurement_time)` shows the same wall time
   with a `+00` offset; indexes intact.
2. After read-layer change: `npm run build:local && npm run type-check` green.
3. Admin **View Data** (raw/5m/daily) for a Tesla system (e.g. Tez, id 10) and a non-Tesla
   system shows correct ISO timestamps in the system TZ; Older/Newer paging works; the
   single-point inspector centers correctly.
4. Confirm correctness is **server-timezone-independent** (e.g. run a read under `TZ=` set to
   a non-UTC zone and confirm identical instants).
