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
re-run it after the SSR work (Superphase 1, see [`docs/architecture/live-dashboard-roadmap.md`](../../../docs/architecture/live-dashboard-roadmap.md))
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

## What a re-run after Superphase 1 should move

Superphase 1's **`/api/history` precompute (1.3)** and **SSR data-prefetch (1.2)** touch the render path
this harness exercises, so expect the shared-view **settle** (dominated by the ~176 ms `history` server
tail) to drop. The **network floor (~46 ms) will not change** — it's physics, not code. The authed
owner-path win (structure server-resolution, 1.1) is **not** visible here (no auth); measure that with a
signed-in browser per the main waterfall doc. Record the new run as a dated `-sydney-lambda-prod-<date>.json`
and add a comparison row to the waterfall doc.
