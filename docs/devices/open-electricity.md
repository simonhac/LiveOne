# OpenElectricity (NEM)

> **Status:** current — built 2026-06-13. Code complete (`build:local` + `type-check` + unit
> tests green); live API contract confirmed via a 30-day dry-run download (NSW1/VIC1) on
> 2026-06-13. **Not yet seeded or deployed.** See [Status / remaining](#status--remaining).
> Structure follows [README.md](README.md) (anatomy of a device integration).

Imports three regional NEM market/network signals at 5-minute resolution from the
**OpenElectricity** API (`https://api.openelectricity.org.au/v4`, the successor to OpenNEM):
**emissions intensity** (tCO₂e/MWh), **spot price** ($/MWh), and **renewable proportion** (%).
One device (system) per NEM region. Modelled on Amber (the existing 5m-native market-data vendor).

## Anatomy

| Block              | This device                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter            | `lib/vendors/openelectricity/adapter.ts` — `vendorType: "openelectricity"`, `dataSource: "poll"`, `supportsAddSystem: false`, no `credentialFields`                                       |
| Client             | `lib/vendors/openelectricity/client.ts` — `fetchNetworkData` (/data), `fetchMarketData` (/market), `fetchMe`, `getBasisMetric`; `OpenElectricityApiError` (typed, `retryable` on 429/5xx) |
| Types              | `lib/vendors/openelectricity/types.ts` — `NemRegion`, `OeMetric`, response shapes                                                                                                         |
| Point metadata     | `lib/vendors/openelectricity/point-metadata.ts` — 3 points + `buildReadingsFromResponses()` mapper                                                                                        |
| Registration       | `registry.ts` → `"openelectricity"`                                                                                                                                                       |
| Interval class     | **5m-native** (`native-intervals.ts`) → receiver UPSERTs, so late revisions heal                                                                                                          |
| Credentials        | app-wide env var **`OPEN_ELECTRICITY_API_KEY`** (Vercel prod/preview/dev; **not** per-user Clerk). The cron credential gate in `app/api/cron/minutely/route.ts` exempts `openelectricity` |
| Provisioning       | seed script `scripts/openelectricity/seed-systems.ts` (one `systems` row per region) — not user-addable                                                                                   |
| Scheduling         | custom dynamic `shouldPoll` via `scheduler.ts` (learned arrival window)                                                                                                                   |
| Ingest             | `fetchData` → `insertPointReadingsAgg5m` → poll-collector → QStash → receiver UPSERT; latest → KV                                                                                         |
| Backfill / history | online: `app/api/cron/openelectricity-backfill/route.ts` (`backfill.ts`); offline: `scripts/openelectricity/bulk-ingest.ts`                                                               |
| Tests              | `lib/vendors/openelectricity/__tests__/` (scheduler + mapper)                                                                                                                             |

### System model

`vendorType="openelectricity"`, `vendorSiteId=<region>` (e.g. `"NSW1"`), `metadata={ network: "NEM" }`,
`ownerClerkUserId=null` → **public** (readable by any authenticated user; polled without an owner
because the vendor uses an app-wide env key — see `lib/vendors/ownership.ts`).
**`timezoneOffsetMin=600`** (AEST, UTC+10, **no DST** —
NEM dispatch boundaries are fixed AEST year-round; never use `Australia/Sydney`).

## Data model

Three points, all under the **`grid`** subsystem (`transform: null`). Defined once in
`point-metadata.ts` and shared by the live adapter, the backfill route, and the bulk ingestor.

| logicalPathStem           | metricType   | metricUnit  | source                                           |
| ------------------------- | ------------ | ----------- | ------------------------------------------------ |
| `grid.emissionsIntensity` | `intensity`  | `tCO2e/MWh` | **computed** `emissions ÷ energy`                |
| `grid.price`              | `rate`       | `$/MWh`     | direct (`price`, market endpoint)                |
| `grid.renewables`         | `proportion` | `%`         | direct (`renewable_proportion`, market endpoint) |

### Emissions intensity is computed, not fetched

`emissions_intensity` is **not** a queryable API metric (the public docs example is wrong —
verified against the OpenAPI spec, both official clients, and the backend router). Like the OE
frontend, we compute it: `intensity = emissions ÷ energy`. At the `5m` interval there is no native
`energy`, so the basis is the `power` metric and `energy(MWh) = power(MW) × intervalHours`. We fetch
`power` + `emissions` and divide in `buildReadingsFromResponses`; intervals with `power ≤ 0` are
skipped (intensity undefined). Stored as delivered tCO₂e/MWh (the OE frontend scales ×1000 to
kgCO₂e/MWh for display — a presentation concern).

### Two endpoints, two calls per poll

No single endpoint serves all four metrics, so each poll makes **two parallel calls**:

| Metrics                         | Endpoint                           |
| ------------------------------- | ---------------------------------- |
| `power`, `emissions`            | `GET /v4/data/network/{network}`   |
| `price`, `renewable_proportion` | `GET /v4/market/network/{network}` |

### Timestamps: interval START → END

OE labels buckets by interval **START** (ClickHouse `toStartOfFiveMinute`, `[start, end)` window).
LiveOne stores by interval **END**, so the mapper converts: `intervalEnd = startTs + interval`.
Because `END(N) == START(N+1)`, using a stored interval-END as a request `date_start` begins
exactly at the first missing interval (no off-by-one).

## Polling & scheduling

Cadence is **dynamic**, not fixed — it learns when each region actually publishes and polls in that
window, instead of blindly every 5 min. Logic in `scheduler.ts` (`decidePoll`/`applyObservation`
are pure and unit-tested); the minutely cron drives it.

- Per region we track an EWMA **publish delay** `D` and the **last interval captured**. After an
  interval ends at `T`, data lands at ~`T + D` (typically 1–3 min, sometimes late). We stay quiet
  until `T + D − margin`, then poll each minute until captured (capped per window to avoid hammering
  the API when data is late), nudging `D` up/down from the observed delay.
- **State lives in KV** under `oe:sched:system:<id>` (env-namespaced): `{ delaySec,
lastSeenIntervalEndMs, windowIntervalEndMs, pollsThisWindow }`. `lastSeenIntervalEndMs` is an
  **interval END** (epoch ms). On a KV miss it is seeded from the DB
  (`MAX(point_readings_agg_5m.interval_end)` for the system) — KV is the hot cache, the agg table is
  the durable fallback.
- Worst-case latency ≈ one cron tick (≤ ~1 min). A bounded in-invocation retry for sub-minute
  latency was rejected (it would starve the shared minutely cron's 60 s budget).

## Gap handling & backfill

Tiered, so any gap is filled by the cheapest mechanism that covers it:

| Gap                       | Filled by                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ≤ ~15 min                 | normal rolling lookback — each poll re-requests the last **15 min** (`DEFAULT_LOOKBACK_MS`), so a just-published interval lands and recent revisions heal                                                                            |
| 15 min – **24 h**         | **adaptive lookback** — when behind (we/OE were down), the poll extends its window back to `lastSeenIntervalEndMs`, capped at `MAX_AUTOHEAL_MS` (24 h ≈ 288 intervals, one fetch). The next successful poll auto-fills the whole gap |
| > 24 h, bounded           | `console.warn` fires; run the **backfill route** (`/api/cron/openelectricity-backfill`, ≤ 31 days)                                                                                                                                   |
| months/years / new region | the **bulk ingestor** (`scripts/openelectricity/bulk-ingest.ts`)                                                                                                                                                                     |

The window-start computation is `adaptiveLookbackStartMs` (pure, unit-tested). The two backfill
paths reuse the same client + mapper as the live adapter, so all three produce identical readings.

### Backfill route (online, bounded)

`POST /api/cron/openelectricity-backfill` — under `/api/cron/*` (Clerk-public) so a
`Authorization: Bearer $CRON_SECRET` curl reaches it (`/api/admin/*` is blocked at the edge).
Reuses the live ingest path (queue → receiver UPSERT) and rebuilds 1d aggregates for the range.

```bash
curl -X POST "$BASE/api/cron/openelectricity-backfill" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -d '{"region":"NSW1","start":"2026-06-01","end":"2026-06-10","dryRun":true}'
```

### Bulk ingestor (offline, unbounded)

`scripts/openelectricity/bulk-ingest.ts` — a standalone `tsx` CLI that connects directly to
Postgres and batches `INSERT … ON CONFLICT` into `point_readings_agg_5m` (the same SQL the receiver
uses), **bypassing QStash** for throughput. Dry-run defaults **true**; chunks the range; honours
rate limits with backoff; resumes from the already-stored `MAX(interval_end)`. The region's system +
its 4 points must already exist (it writes data, never schema).

```bash
npx tsx scripts/openelectricity/bulk-ingest.ts \
  --system=42 --region=NSW1 --date-start=2023-01-01 --date-end=2024-01-01 \
  --interval=5m --dry-run=false --aggregate-1d=true
```

## Operations

1. **Env:** `OPEN_ELECTRICITY_API_KEY` (already in Vercel prod/preview/dev; add to `.env.local` for
   local runs).
2. **Seed the region systems:** `npx tsx scripts/openelectricity/seed-systems.ts` (default NSW1, VIC1;
   idempotent). Points auto-create on the first poll via `ensurePointInfo`.
3. **Force a poll (dev):** `GET /api/cron/minutely?systemId=<id>&force=true` — confirm 4
   `point_readings_agg_5m` rows UPSERT and KV latest values populate.
4. **Verify coverage** (indexed, never `COUNT(*)`): `SELECT MIN(interval_end), MAX(interval_end)
FROM point_readings_agg_5m WHERE system_id=<id> AND point_id=<idx>`.

### Prod bulk loads

Target the sydney branch deliberately: mint a short-TTL role, point `PLANETSCALE_DATABASE_URL` at it,
set `ALLOW_PROD_DB_IN_DEV=true`, and pass `--i-understand-this-is-prod --dry-run=false` (two-key
action). See `CLAUDE.md` → "Applying Postgres migrations" for the role-minting procedure.

## API gotchas (source-verified — the public docs were wrong)

- `emissions_intensity` is **not** an API metric — compute `emissions ÷ energy` (energy from `power`
  at 5m).
- Metrics are split across **two endpoints** (`/data` vs `/market`) → two calls per poll.
- Timestamps are the interval **START**, not END.
- **Request** `date_start`/`date_end` must be **timezone-naive network time** (AEST,
  `YYYY-MM-DDTHH:mm:ss`); a tz-aware `…Z` value 400s (`"Date start must be timezone naive and
in network time"`). The **response**, confusingly, _is_ tz-aware (`…+10:00`). Confirmed live
  2026-06-13.
- `renewable_proportion` is a first-class metric (backend-derived `generation_renewable ÷
demand_gross × 100`) on the **market** endpoint; `price` is market-only.
- Rate limit: HTTP 429 + `GET /v4/me` → `rate_limit { limit, remaining, reset }`.

## Status / remaining

Code complete and green (`build:local`, `type-check`, 18 unit tests). **Not committed, seeded, or
deployed.** Before relying on it, do the live checks that need the key (or a deploy):

1. Confirm the real response JSON matches the parser — that `results[].data` rows are `[ts, value]`
   tuples and `series.metric` echoes the requested name; confirm the exact `unit` strings; sanity-check
   computed intensity ≈ 0.5–0.9 tCO₂e/MWh for the NEM.
2. Seed NSW1/VIC1; force one dev poll; confirm rows + KV + `polling_status`.
3. Watch a few cron ticks: SKIP between intervals, one POLL just after each interval's expected
   landing, `delaySec` converging.
