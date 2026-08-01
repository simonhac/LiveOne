# Sydney-origin dashboard perf benchmark (AWS Lambda, `ap-southeast-2`)

Measures the dashboard's fetch waterfall **from inside Sydney** so time-to-first-byte reflects a real
Australian client, not the operator's location. This is the cross-region companion to the
browser-based harness in [`docs/performance/dashboard-fetch-waterfall.md`](../../../docs/performance/dashboard-fetch-waterfall.md)
— it runs the *same* in-page harness, but from a throwaway headless-Chromium Lambda co-located with
the `syd1` functions + PlanetScale `sydney`.

## Why this exists

The dashboard's ~600 ms/request "floor" measured from Italy is **`fra1↔syd1` network latency, not app
code** (`x-vercel-id: fra1::syd1`). From Sydney the same routes return in ~46 ms (`syd1::syd1`) and the
server-side phase times are identical. This harness makes that measurable and **repeatable**, so we can
re-run it after the SSR work (Superphase 1, see [`docs/plans/live-dashboard-roadmap.md`](../../../docs/plans/live-dashboard-roadmap.md))
lands and see what changed.

## Run it

```bash
cd scripts/perf/sydney-lambda
./run.sh                       # build → deploy to ap-southeast-2 → invoke → save JSON → teardown
python3 analyse.py /tmp/liveone-perf-result.json
```

- Requires the `aws` CLI configured (any region; it forces `ap-southeast-2`), plus `node`, `npm`, `zip`.
- Creates a throwaway IAM role + S3 bucket + Lambda, invokes once, then **tears everything down** (the
  `trap` runs on exit). Cost: a few cents.
- `KEEP=1 ./run.sh` leaves the resources up for iteration; `TARGET_URL='…?access=<token>' ./run.sh`
  points at a fresh share token or a different dashboard.

The Lambda is `puppeteer-core` + `@sparticuz/chromium` (self-contained Chromium; no dependency
wrangling), 2048 MB / 300 s, deployed via S3 (the zip is ~72 MB, over the 50 MB direct-upload limit).

## What it measures & how to read it

`handler` returns:
- **`health[]`** — 5× raw-`https` probe of the public `/api/health` (no auth). The **warm TTFB is the
  clean network floor** (server work ~2.7 ms); `xVercelId` should be `syd1::syd1`, confirming the
  Sydney origin.
- **`browserRuns[]`** — 10× the in-page settle harness against the **shared** URL
  (`/dashboard/id/5?access=…`, no auth needed). Per `/api` request: `dur` (client-observed), `st`
  (`x-server-timing` phases), `vid`.

**Caveats (important for a faithful re-run):**
- **Use `dur`, not `ttfb`, for the browser rows.** Headless Chromium reports `responseStart = 0`, so the
  entry `ttfb` field is 0; the clean network number comes from the node-level `health` probe. `dur` =
  network + server and is reliable.
- **The shared view is 3 requests / 1 stage** (`data×2` + `history`) — it skips the three "chrome" routes
  (`/api/dashboards`, `/api/user/preferences`, `/api/areas/readable`) because the share path resolves
  them server-side. So this measures the shared render, **not** the authed 6-request/2-stage owner page.
  It exercises the same `syd1` function + the two heavy routes over the same network path, which is what
  we need; the authed owner path from Sydney would require a signed-in session (out of scope for the
  no-auth Lambda).

## Recorded baseline (2026-07-21)

Full write-up + raw data: [`docs/performance/dashboard-fetch-waterfall.md`](../../../docs/performance/dashboard-fetch-waterfall.md)
("Cross-region confirmation — Sydney vs Italy") and `docs/performance/dashboard-fetch-waterfall-sydney-lambda-prod-2026-07-21.json`.

| Metric | Italy (fra1) | **Sydney (this harness)** |
|---|---|---|
| `/api/health` warm TTFB (network floor) | ~610 ms | **~46–50 ms** |
| shared-view settle (3 req) | ~1850 ms | **496 ms** (median of 10) |
| `/api/history` client `dur` | ~1015 ms | **250 ms** (server ~176 ms) |
| `/api/data?sys=8` client `dur` | ~740 ms | **86 ms** (server ~34 ms) |

## Recorded — post-SSR re-run (2026-07-22)

SP1 landed (SSR-first load, PR #203). This harness was **augmented** to capture what SSR changed
(`index.mjs` / `analyse.py`): SSR **decoupled time-to-content from time-to-settle**, so `/api`-settle
alone is no longer the story. It now also captures Navigation Timing + Paint (FCP/LCP) in-page and a
**node document-TTFB probe** (the SSR server time). Result (10 runs, `syd1::syd1`), vs the pre-SSR
Sydney baseline:

| Metric | Pre-SSR (07-21) | **Post-SSR (07-22)** |
|---|---|---|
| Network floor (health warm) | ~46 ms | 48 ms (unchanged — physics) |
| **Time-to-content — FCP (tiles SSR'd)** | n/a | **202 ms** |
| Time-to-settle — chart (`/api/history`) | 496 ms | 519 ms (~flat — history still un-seeded) |
| SSR document TTFB (node warm) | n/a | ~95–107 ms → **~40–59 ms SSR server compute** |
| `/api/history` server `total` | 176 ms | ~150–185 ms (flat; Lever 1's DB saving < variance) |
| client requests (shared) | 3 | 2 |

Takeaway: **SSR delivered time-to-content (tiles at ~200 ms); time-to-settle is flat** because the
settle tail is the un-seeded `/api/history` — the next lever is SSR-prefetching it (stream via Suspense
so tile-FCP doesn't regress). Full write-up + raw data:
[`docs/performance/dashboard-fetch-waterfall.md`](../../../docs/performance/dashboard-fetch-waterfall.md)
("Post-SSR re-run — Sydney, 2026-07-22") and the two `…-sydney-lambda-prod-2026-07-22*.json` files.

The **SSR-render decomposition** (PR #205, inline `#__ssr_timing`) splits the ~40–59 ms server compute:
`areas` ~11 + `data` ~11 dominate; `auth`/`token`/`dashboard` are trivial warm (`token` read 108 ms in
a *cold* fra1 sample but 3.7 ms warm — cold-instance artifact, not a real cost). The render is cheap
and balanced; the tail is client-side `/api/history`, not the SSR render. The authed owner-path win
(SP1.1) is **not** visible here (no auth) — measure that with a signed-in browser per the main
waterfall doc.

## Recorded — post-config-v4 (2026-08-01)

First re-run after the config-v4 epic (`352da181`). Shared view, 10 runs, `syd1::syd1` on every
request. Full write-up + raw data:
[`docs/performance/dashboard-fetch-waterfall.md`](../../../docs/performance/dashboard-fetch-waterfall.md)
("Post-config-v4 re-run — Sydney Lambda + local AU browser") and
`docs/performance/dashboard-fetch-waterfall-sydney-lambda-prod-2026-08-01.json`.

| Metric | 2026-07-22 (#208) | **2026-08-01** |
|---|---|---|
| Network floor (health warm) | 48 ms | 53 ms |
| Client requests (shared) | 1 | **1** |
| FCP (time-to-tiles) | 294 ms (noisy) | **258 ms** |
| Settle (`/api/history` end) | ~606 ms | **600 ms** |
| Node document TTFB (warm) | 104 ms | **104 ms** (unchanged) |
| SSR `total` span | 38.9 ms | **55.3 ms** |
| `/api/history` server `total` | ~150–185 ms | **228.6 ms** |

Config-v4 added ~16 ms of SSR span time but the **document TTFB did not move** — it fits inside the
streaming render. The one real regression is `/api/history`'s `attr` span (battery-provenance
attribution) at 66 → 98 ms.

**Two things changed for future runs:**

1. **Prefer the canonical `db_…` URL.** `TARGET_URL`'s legacy `/dashboard/id/5?access=…` still works
   *only* because the share-token branch short-circuits before config-v4's new legacy-id
   `permanentRedirect` — and that redirect **drops the query string**. On the authed path the
   redirect costs ~85 ms. Safer:
   `TARGET_URL='https://www.liveone.energy/dashboard/id/db_01kyf18trhf5xrchbsv6yt8np0?access=<token>' ./run.sh`
2. **Kinkora is saturated** (1 request, 1 stage — shared *and* authed). For waterfall **shape**, point
   the harness at **Daylesford** (`db_01kyf18tp3e5brm474zf0fzvkm`): 4 client requests, 1546 ms settle,
   an un-seeded `/api/data`, and a 1226 ms `/api/history`. Keep Kinkora for series continuity.

**Harness caveat if you run the in-page harness from a browser-automation tab** (not this Lambda):
assert `document.visibilityState === 'visible'`. A hidden tab throttles hydration and never paints —
a first attempt recorded FCP 131,744 ms and hydration at 6.7 s.
