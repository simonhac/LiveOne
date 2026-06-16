# Operations: monitoring & Slack alerts

> Status: current.
> This doc is the **"I just saw a red alert in Slack — what is it and what do I
> do?"** reference. It explains what each alert _means_ and points at the code for
> exact thresholds; the numbers themselves live in code (per the docs convention)
> and the defaults below are orientation, each tagged with its env override.

The data-collection pipeline is **asynchronous and best-effort**: polls publish to
a queue, a receiver materialises readings into Postgres. When a stage breaks,
readings silently stop landing — nothing crashes, the pipeline just falls behind.
The alerts below are the early-warning layer that catches that within minutes
instead of weeks. **All** of them post to one Slack channel via the same webhook,
`OBSERVATIONS_ALERT_WEBHOOK_URL` (the shell-script alerts read it as
`ALERT_WEBHOOK_URL`). If the webhook is unset, alerts degrade to console logs.

## Observations pipeline health monitor

The centrepiece. **`app/api/cron/monitor-observations/route.ts`** — a Vercel cron
that runs **every 15 minutes** (`vercel.json`, `*/15 * * * *`; `maxDuration = 30s`).

- **Read-only and best-effort**: it never throws and never mutates data. Each check
  block has its own `try/catch`, so a failing source becomes a `warn` issue rather
  than blinding the others.
- **Prod only**: auth is `requireCronOrAdmin`; `cronSkipReason()` short-circuits
  unless `CRONS_ENABLED === "true"`, so it's inert in dev/preview.
- **Doubles as a manual endpoint**: it returns JSON (`status` = `ok`/`warn`/`alert`,
  plus `issues` and `checks`) — hit it (admin / `x-claude`) for a live readout
  without waiting for the next scheduled run.
- It **only posts to Slack on `alert`** (a `warn` is logged, not paged). The message
  is `🚨 LiveOne observations mirror unhealthy:` followed by one bullet per alert.

### Signals

| alert code                                | what it means when it fires                                                                               | default                   | env override                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------- |
| `raw_landing_stale`                       | Nothing has landed in `point_readings` for N min — the pipeline is stalled. **(This is the common one.)** | > 15 min                  | `MONITOR_RAW_STALE_MINUTES`     |
| `no_raw_despite_sessions`                 | Poll sessions succeeded but **0** readings landed in the last hour — the queue is dropping readings.      | ≥ 5 sessions, 0 raw       | `MONITOR_MIN_SESSIONS`          |
| `response_presence_low`                   | < 80% of recent successful CRON sessions carry a `response` — the mirror pipeline is degraded.            | 0.8                       | `MONITOR_RESPONSE_PRESENCE_MIN` |
| `queue_lag_high`                          | QStash queue lag too high — the receiver isn't keeping up.                                                | > 1000                    | `MONITOR_QUEUE_LAG_MAX`         |
| `dlq_high` (alert) / `dlq_present` (warn) | Messages stuck in the dead-letter queue — failed deliveries piling up.                                    | ≥ 50 alert; any > 0 warns | `MONITOR_DLQ_ALERT`             |
| `queue_paused` (warn)                     | The observations queue is paused — ingestion halted.                                                      | —                         | —                               |
| `outbox_backlog_high`                     | Phase-4 relay stalled — too many unpublished `observations_outbox` rows.                                  | > 500 rows                | `MONITOR_OUTBOX_BACKLOG_MAX`    |
| `outbox_stale`                            | Phase-4 relay isn't draining — oldest unpublished row too old.                                            | > 10 min                  | `MONITOR_OUTBOX_STALE_MINUTES`  |

### Reading the alert

- **It measures landing, not sensor time.** `raw_landing_stale` keys off
  `point_readings.created_at` (when a row landed in PG), **not** `measurement_time`
  (the sensor clock). It's a health check on the _pipeline_, not the device.
- **The age climbs across runs.** Because the cron fires every 15 min and the
  threshold is 15 min, a stall re-measures the same stuck `max(created_at)` each
  run and reports a larger age (e.g. `27 min` → `41 min`) until a fresh row lands
  and it drops back to `ok`.
- **Companion signals localise the break.** The normal path is
  `poll-collector → observations_outbox + QStash → /api/observations/receive
(single writer) → point_readings`. If sessions are still succeeding but raw
  stopped, the break is downstream of polling; the `dlq_high` / `queue_lag_high` /
  `outbox_stale` values from that window point at which stage.
- **It detects; it does not heal.** Recovery is QStash retries plus the minutely
  `relay-outbox` cron (`vercel.json`, `* * * * *`) draining the durable outbox once
  the receiver is healthy again. The monitor is the smoke alarm; the relay is what
  actually replays what was buffered.

### Manual tools

- `scripts/qstash-health.ts` — CLI snapshot of queue lag / DLQ without waiting for
  the cron.
- `/api/admin/observations/{dlq,info,messages,stats}` — read-only inspection of
  queue + outbox state.

## The other Slack alerts

Same channel, different sources. These are GitHub Actions / runtime checks, not the
15-minute monitor.

| Slack text                                                                            | source                                                                                                                  | meaning & first triage                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `✅/🔴 PG→R2 backup …`                                                                | `scripts/utils/backup-pg-to-r2.sh` via `.github/workflows/pg-backup.yml` (daily 16:17 UTC ≈ 02:17 Sydney)               | Off-site `pg_dump` → R2, GFS-tiered (1st-of-month → monthly, Sunday → weekly, else daily; lifecycle 21d / 70d / 400d). 🔴 = the dump or upload failed → check the Action log; confirm PITR is still covering the gap.                                                                                                                                                                                                                                           |
| `✅/🔴 PG restore-drill …`                                                            | `scripts/utils/restore-drill-pg.sh` via `.github/workflows/pg-restore-drill.yml` (Mondays 17:37 UTC ≈ Tue 03:37 Sydney) | Restores the latest backup into a throwaway target and asserts `point_readings ≥ MIN_RATIO × live` (default 0.95). 🔴 = backups aren't restoring cleanly → **investigate before trusting the backups**; re-run the drill.                                                                                                                                                                                                                                       |
| `🔴 sync-prod-to-dev FAILED — liveone-dev may be stale`                               | `.github/workflows/sync-prod-to-dev.yml` (every 6h at :20)                                                              | The prod→`liveone-dev` mirror top-up failed; dev/preview data may be stale. **Known failure mode: schema drift** — the sync derives its column list from the dev catalog (`scripts/utils/sync-prod-to-dev.ts`) assuming dev and prod schemas match, so it fails when a migration is applied to dev (or prod) but not the other. Check the Action log for a `column "…" does not exist` error; the fix is to converge the schemas (apply the pending migration). |
| `🔴 [PlanetScale] DRIFT: production is NOT connected to the declared prod database …` | `lib/db/planetscale/index.ts` (`assertDbEnvironmentMatches`, runtime, fail-open)                                        | Prod is connecting to a DB whose identity doesn't carry `PLANETSCALE_PROD_BRANCH_ID`. Fail-open: it alerts but keeps prod running. Check the prod `DB_*` / `PLANETSCALE_DATABASE_URL` env and `PLANETSCALE_PROD_BRANCH_ID`. (The same guard is fail-_closed_ in dev/preview — it refuses a connection that carries the prod token.)                                                                                                                             |

## See also

- [architecture/engine-web-separation.md](architecture/engine-web-separation.md) §6.5 — the SLO rationale (queue lag / DLQ / receiver-success / raw-landing-age) behind these thresholds.
- [turso-pg-migration.md](turso-pg-migration.md) — historical record of when the outbox + monitor were rolled out (Phase 4).
- [architecture/api.md](architecture/api.md) — full cron + admin route inventory.
