# Observations → Postgres mirror — status & next steps

Consolidates the (now-removed) Phase 1 and Phase 2 runbooks. **Turso stays the source of
truth; Postgres is a secondary mirror.**

## Done

- **Phase 1 — live pipeline:** QStash → Postgres ingestion is live. The consumer is
  hardened (returns 500 → retry instead of silently dropping when Postgres is unset), 5-min
  aggregates carry the full tuple, session ids are preserved, inserts are batched. The
  receiver-URL bug (it used `VERCEL_URL`, which Vercel Deployment Protection 401s) is fixed
  to resolve to the public domain. The Postgres mirror is provisioned (tables, indexes,
  `systems` + `point_info` seeded).
- **Phase 2 — historical backfill:** the full history of `sessions` / `point_readings` /
  `point_readings_agg_5m` / `point_readings_agg_1d` has been copied from Turso into Postgres
  via `scripts/backfill-turso-to-postgres.ts` and **verified with `--verify` — zero
  historical records dropped**. See `docs/backfill-turso-to-postgres.md`.
- **Decisions locked:** backfilled `point_readings.created_at = received_time` (keeps them
  off the live ingest chart); historical session `response` blobs dropped (`null`) for speed;
  daily (1d) aggregates flow through the live queue (this PR).

## Next steps

1. **Merge + deploy this PR.** It adds "publish 1d aggregates through the queue" (widened
   `interval` to `"raw"|"5m"|"1d"`; the daily cron publishes a 1d batch per system/day; the
   consumer writes `point_readings_agg_1d`). Until deployed, the daily cron does **not**
   keep the mirror's `agg_1d` current. The change only takes effect on the next deploy.
2. **Verify live 1d after the first post-deploy daily run** (`/api/cron/daily`, ~00:05 AEST):
   confirm new `point_readings_agg_1d` rows land in Postgres, then
   `NODE_ENV=production npx tsx scripts/backfill-turso-to-postgres.ts --verify --table=agg_1d`
   should stay clean.
3. **Re-run `--verify` once the live queue has drained** (optional): the only diffs at
   backfill time were today's in-flight tail (Turso rows whose queue message Postgres hadn't
   consumed yet). They should shrink toward 0 as the pipeline catches up.
4. **`env-scripts` branch follow-up** (carried over from Phase 1): `env/env.config.json` on
   the `simonhac/env-scripts` WIP declares the wrong `QSTASH_TOKEN*` vars and omits the
   Postgres vars. Remove `QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` /
   `QSTASH_NEXT_SIGNING_KEY`; add `OBSERVATIONS_QSTASH_TOKEN`,
   `OBSERVATIONS_QSTASH_RECEIVER_URL`, `OBSERVATIONS_QSTASH_URL`,
   `OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY`, `OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY`,
   `PLANETSCALE_DATABASE_URL`, `PLANETSCALE_DATABASE_URL_MIGRATIONS`.

## Later (not scheduled)

- Promote Postgres from mirror toward a primary/serving role (read paths, then cutover) —
  only after the mirror has run in lock-step with Turso long enough to trust it.

## Tools

- `scripts/backfill-turso-to-postgres.ts` — historical backfill + `--verify` (see its doc).
- `scripts/seed-planetscale-refs.ts` — re-seed `systems` + `point_info` if metadata changes.
- `scripts/purge-observations-queue.ts` — purge + recreate the QStash queue (paused).
- `/admin/observations/dashboard` — live pipeline depth, ingestion rate, queue controls.

## Rollback

Everything here only writes Postgres; Turso is untouched. If ingestion misbehaves, **pause
the queue** from `/admin/observations` — publishing continues, messages accumulate, Turso
keeps serving. Backfill writes are idempotent; worst case `TRUNCATE` the Postgres mirror
table(s) and re-run.
