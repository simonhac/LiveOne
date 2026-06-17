# OpenElectricity scripts

Operational and analysis tooling for the `openelectricity` vendor (NEM regional grid signals —
price, emissions intensity, renewable proportion, operational demand). The two `tsx` CLIs read
`.env.local` and talk directly to Postgres (`planetscaleDb`) and never change schema; the Python
script is read-only analysis over already-persisted readings.

For the integration's design, API gotchas, and the online backfill route, see
[`docs/devices/open-electricity.md`](../../docs/devices/open-electricity.md). Point/metric
definitions live in `lib/vendors/openelectricity/point-metadata.ts`.

| Script               | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `seed-systems.ts`    | Create one liveone `system` row per NEM region (idempotent).      |
| `bulk-ingest.ts`     | Offline, direct-to-DB historical loader for large backfills/gaps. |
| `publication-lag.py` | Characterise the vendor's data publication lag from our readings. |

## `seed-systems.ts`

Creates one `openelectricity` system per region. Idempotent — a region that already has a
system is skipped. `point_info` rows are **not** created here; they auto-create on the first
poll via `PointManager.ensurePointInfo()`.

```bash
npx tsx scripts/openelectricity/seed-systems.ts                 # all 5 NEM regions (default)
npx tsx scripts/openelectricity/seed-systems.ts --regions=NSW1,VIC1
```

Targets whatever DB `.env.local` points at (the dev branch by default). To seed prod, point
`PLANETSCALE_DATABASE_URL` at the sydney branch and set `ALLOW_PROD_DB_IN_DEV=true`.

## `bulk-ingest.ts`

Offline historical loader, **deliberately separate** from the live adapter and the bounded
online backfill route (`app/api/cron/openelectricity-backfill`). Use it to seed a new
region's multi-month/year history or repair a large gap, where queue throughput and
serverless limits make the online path impractical. It connects straight to Postgres,
batches `INSERT … ON CONFLICT` into `point_readings_agg_5m` (the same SQL the receiver
uses), and **bypasses QStash** entirely.

It writes **data only** — never schema. The region's system + its four points
(`grid.price`, `grid.emissionsIntensity`, `grid.renewables`, `grid.demand`) must already
exist: seed the system, then run one live poll / online backfill so `ensurePointInfo`
creates the points.

```bash
npx tsx scripts/openelectricity/bulk-ingest.ts \
  --system=42 --region=NSW1 --date-start=2023-01-01 --date-end=2024-01-01 \
  --interval=5m --window=7d --batch-size=2000 --overwrite=false \
  --resume=auto --dry-run=false --aggregate-1d=true --verify=true
```

Key flags:

- `--system` / `--region` — target liveone system id and its NEM region (required).
- `--date-start` / `--date-end` — inclusive range (`YYYY-MM-DD`).
- `--resume=auto|off` — `auto` skips intervals already stored (resumes from
  `MAX(interval_end)`); use **`off`** when topping up a _new_ metric across history that the
  live cron is already extending, otherwise resume skips the back-history.
- `--overwrite` — re-write intervals that already exist.
- `--aggregate-1d=true` — rebuild `point_readings_agg_1d` for the range afterwards.
- `--dry-run` — **defaults `true`**; pass `--dry-run=false` to actually write.

### Prod loads (two-key safety)

`--dry-run` defaults true and the script targets whatever `.env.local` points at (dev). For a
real prod load, point `PLANETSCALE_DATABASE_URL` at the sydney branch, set
`ALLOW_PROD_DB_IN_DEV=true`, **and** pass `--i-understand-this-is-prod --dry-run=false`. See
`CLAUDE.md` → "Applying Postgres migrations" for the short-TTL role-minting procedure.

### Verify coverage

Indexed lookup (never `COUNT(*)` the big table):

```sql
SELECT MIN(interval_end), MAX(interval_end)
FROM point_readings_agg_5m
WHERE system_id = <id> AND point_id = <pointIdx>;
```

## `publication-lag.py`

Reconstructs OpenElectricity's data **publication lag** from our own persisted readings — no live
API polling. Lag = `point_readings_agg_5m.created_at − interval_end` (the receiver preserves
`created_at` as the first-write time across heal-UPSERTs). Prints a per-day summary table (emissions
intensity = `data` endpoint, then spot price = `market` endpoint) and renders a "lag by time of day"
chart (one line per AEST day, half-hour buckets) for the laggy `data` series.

```bash
# dev mirror (default; ~2h stale, from .env.local PLANETSCALE_DATABASE_URL)
python3 scripts/openelectricity/publication-lag.py

# prod (sydney) — mint a short-TTL read-only role, run, then delete it
pscale role create liveone sydney oe-lag-ro --inherited-roles pg_read_all_data --ttl 1h --format json
PG_LAG_DB_URL="<database_url from that json>" python3 scripts/openelectricity/publication-lag.py
pscale role delete liveone sydney <role-id> --force
```

Options: `--system` (11=NSW1, 12=VIC1), `--days` (default 10), `--db URL`, `--out PATH`.
Deps: `psql` on PATH, Python 3, Pillow (table prints without it; chart needs it).

Context: built 2026-06-17 to characterise an OE feed stall that 404'd the poller. The `data` endpoint
lags structurally (~one interval) and stalls to tens of minutes, clustering in the AEST evening.
The poller now tolerates the resulting "no data in range" 404 (see `lib/vendors/openelectricity/client.ts`).
Re-run with more days accumulated to confirm whether the evening clustering recurs.
