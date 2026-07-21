# Dashboard fetch-waterfall benchmark

> Status: current — reusable harness; the recorded run below is a PROD baseline for the
> `simonhac/dashboard-fetch-slim-handoff` branch's fetch-slimming work
> (`.context/plans/slim-the-dashboard-s-fetch-fan-out-db-round-trips.md`). Re-run and diff after
> that branch merges — see "Re-run after merge" below.

## What this measures

Every `/api/` request a dashboard page fires while loading, with start/end times relative to
navigation — request **count**, waterfall **shape** (which requests overlap vs. serialize), and
overall **settle time** (when the last request finishes). Run in a real signed-in browser tab
against a real dashboard, not synthetic — this is the actual fetch fan-out a user experiences.

Two things matter, and they're not the same:
- **Settle time** (ms) — sensitive to the environment's DB round-trip latency (dev sandbox: 330ms+
  cold per round trip; prod, co-located Vercel `syd1` + PlanetScale Sydney: ~1-5ms). A given
  structural fix can look dramatic in dev and modest in prod, or vice versa — see the 2026-07-20
  session notes below for a concrete example.
- **Request count / waterfall shape** — environment-independent. "7 requests in 3 sequential
  stages" vs. "6 requests in 2 stages (chrome, then everything else concurrently)" is true
  regardless of how fast any individual round trip is. This is the more durable thing to compare.

## The harness

Paste into the browser DevTools console (or run via `mcp__claude-in-chrome__javascript_tool`)
**after** navigating to the target dashboard URL — it polls `performance.getEntriesByType
('resource')` until no new `/api/` request has started or finished for `quietMs`, then returns
every request's path/timing as JSON.

```js
const maxWaitMs = 60000, quietMs = 5000, pollMs = 500;
const t0 = performance.now();
let lastCount = -1, lastMaxEnd = -1, stableSince = null;
while (performance.now() - t0 < maxWaitMs) {
  const entries = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/'));
  const count = entries.length;
  const maxEnd = entries.reduce((m,e) => Math.max(m, e.startTime + e.duration), 0);
  if (count === lastCount && maxEnd === lastMaxEnd && count > 0) {
    if (stableSince === null) stableSince = performance.now();
    if (performance.now() - stableSince >= quietMs) break;
  } else {
    stableSince = null;
    lastCount = count; lastMaxEnd = maxEnd;
  }
  await new Promise(r => setTimeout(r, pollMs));
}
const entries2 = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/'));
JSON.stringify({ waitedMs: Math.round(performance.now()-t0), count: entries2.length, entries: entries2.map(e => {
  const u = new URL(e.name);
  return { path: u.pathname, systemId: u.searchParams.get('systemId'), sankey: e.name.includes('include=sankey'), hws: e.name.includes('temperature'), start: Math.round(e.startTime), end: Math.round(e.startTime + e.duration), dur: Math.round(e.duration) };
}).sort((a,b) => a.start - b.start) })
```

**Gotcha — the quiet window matters.** An early version of this harness used `quietMs = 2500` and
occasionally declared "settled" during a real gap between the chrome stage and the
tiles/history stage (seen on a cold Vercel preview function), capturing only 3/7 requests. Use
`quietMs >= 5000` and sanity-check the returned `count` against what you expect (7 pre-fix, 6
post-fix on this branch) before trusting a result.

**Per-run protocol:**
1. Full navigation (`location.href = url` or a hard reload) — not a client-side route change, so
   `performance`'s resource timeline and React Query's cache both start fresh.
2. Run the harness snippet above; capture its JSON output.
3. Append `{"env": "<prod|preview|dev>", "run": <n>, ...harness output}` as one line to a `.jsonl`
   log file.
4. Repeat ≥10× per environment; a single sample is noisy (this session saw ±800ms run-to-run
   variance on prod alone). Take the median, not the mean, for the headline number — min/max are
   worth reporting too since they bound the range a real user might see.

## Analysis

```python
import json, statistics
runs = [json.loads(l) for l in open('path/to/results.jsonl')]
settles = [max(e['end'] for e in r['entries']) for r in runs]
print(f"n={len(runs)} min={min(settles)} median={statistics.median(settles):.0f} "
      f"mean={statistics.mean(settles):.0f} max={max(settles)} stdev={statistics.stdev(settles):.0f}")
print("request counts seen:", sorted(set(r['count'] for r in runs)))
```

## Recorded baseline — PROD, pre-merge, 2026-07-20

Target: `https://liveone.energy/dashboard/id/5` (Kinkora), signed in as the account owner.
10 runs, raw data in
[`dashboard-fetch-waterfall-baseline-prod-2026-07-20.jsonl`](./dashboard-fetch-waterfall-baseline-prod-2026-07-20.jsonl).

| Metric | Value |
|---|---|
| Requests (every run) | 7 |
| Settle time — min | 2575 ms |
| Settle time — median | **3150 ms** |
| Settle time — mean | 3276 ms |
| Settle time — max | 4353 ms |
| Settle time — stdev | 462 ms |

Waterfall shape observed (unpatched code): 3 chrome requests (`/api/dashboards`,
`/api/user/preferences`, `/api/areas/readable`) run concurrently and finish around ~600-1300ms in;
`/api/data` (×2, one per system on this dashboard) and the two `/api/history` calls (hot-water
sparkline + sankey/site-chart) then fire — largely overlapping at prod's low latency, but
structurally still gated behind the chrome stage completing, and still 2 separate `/api/history`
requests (not yet merged).

**Important caveat vs. the dev-sandbox numbers from the same work session:** the same page on the
local dev sandbox measured ~44.5s pre-fix / ~31.8s post-fix (7→6 requests, 3→2 stages) — a dramatic
difference driven by the dev DB connection's much higher per-round-trip latency (cold connects,
non-co-located). On PROD, at ~3.2s median pre-fix, the *sequential-stage* penalty this branch
removes is inherently much smaller in absolute terms (each stage is already fast), so expect the
prod delta to show up mostly as **request count** (7→6, once the hot-water fetch merges into the
main site fetch) and low-hundreds-of-ms, not multiple seconds. That's still a real, worthwhile
win — just don't expect the dev numbers to reproduce at prod scale.

## Re-run after merge

Once `simonhac/dashboard-fetch-slim-handoff` (or its PR) merges to `main` and deploys to prod:

1. Sign in to `https://liveone.energy` as the account owner, navigate to `/dashboard/id/5`.
2. Run the harness above **10 times** (fresh navigation each run), logging each result as a line
   in `docs/performance/dashboard-fetch-waterfall-after-prod-<date>.jsonl`.
3. Run the analysis snippet against both the `-baseline-prod-2026-07-20.jsonl` file and the new
   `-after-prod-<date>.jsonl` file; compare median/min/max settle time and request count.
4. Append a "Recorded after — PROD, post-merge, `<date>`" section to this doc (mirroring the
   baseline section's table) with the comparison, and commit the new `.jsonl` alongside it.
5. Sanity-check the request count dropped from 7 to 6 (hot-water merged into the main site fetch)
   and that the two `/api/data` calls + the single `/api/history` call now start concurrently with
   (not after) the chrome stage finishing — confirms the structural fixes (not just noise) landed.

## Recorded after — PROD, post-merge, 2026-07-21

Target: `https://liveone.energy/dashboard/id/5` (Kinkora), signed in as the account owner.
10 runs, raw data in
[`dashboard-fetch-waterfall-after-prod-2026-07-21.jsonl`](./dashboard-fetch-waterfall-after-prod-2026-07-21.jsonl).
Merged code live on prod since 2026-07-20T23:19Z (PR #195, commit `32ded88`).

| Metric | Baseline (pre-merge, 7 req) | After (post-merge, 6 req) | Δ |
|---|---|---|---|
| Requests (every run) | 7 | **6** | **−1** |
| Settle — min | 2575 ms | 1802 ms | −773 ms |
| Settle — median | 3150 ms | **2362 ms** | **−788 ms (−25%)** |
| Settle — mean | 3276 ms | 2279 ms | −997 ms |
| Settle — max | 4353 ms | 2685 ms | −1668 ms |
| Settle — stdev | 462 ms | 323 ms | −139 ms |

Waterfall shape observed (patched code): stage 1 is the 3 chrome requests (`/api/dashboards`,
`/api/user/preferences`, `/api/areas/readable`) running concurrently (finishing ~900–1800 ms in);
stage 2 is `/api/data` (×2, systemId 8 + 12) plus a **single** `/api/history` — now carrying both
`include=sankey` **and** the hot-water `temperature` series — all three firing together (< ~10 ms
apart) as stage 1 completes. That's **6 requests** vs. the baseline's **7**: the hot-water tile's
separate 1D sparkline fetch is gone (merged into the main site fetch), so the two prior `/api/history`
calls collapse to one. `/api/history` is no longer gated behind `/api/data`'s response (server-side
`chartCapable` removed that client-side dependency).

**Result vs. the baseline section's caveat:** the prod win landed larger than the predicted
"low-hundreds-of-ms" — median settle dropped **3150 → 2362 ms (−788 ms / −25%)**, and the range
tightened at both ends (min −773 ms, max −1668 ms, stdev 462 → 323 ms). The request-count drop
(7 → 6) is the environment-independent confirmation the structural fix landed; the settle-time
improvement is the prod-scale bonus. (The doc's larger dev-sandbox delta — ~44.5 s → ~31.8 s, driven
by the 3 → 2 sequential-stage collapse under high per-round-trip latency — remains the high-latency
manifestation of the same change.)

## Function CPU experiment — Standard vs Performance, PROD, 2026-07-21

Hypothesis: with Fluid Compute enabled (it is, on this project), the dashboard's bursts of 3
concurrent requests share a warm instance — and on the **Standard** tier (1 vCPU) their CPU-bound
work (Next.js routing, Clerk verify, JSON serialization) contends for a single core. Flipped the
project's Function CPU to **Performance (2 vCPU / 4 GB)**, redeployed, re-ran the same 10-run
protocol (same target, same signed-in session, one warm-up navigation first). Raw data in
[`dashboard-fetch-waterfall-after-prod-2026-07-21-perf-cpu.jsonl`](./dashboard-fetch-waterfall-after-prod-2026-07-21-perf-cpu.jsonl).
Confound note: prod had also picked up PR #196 (Sankey tooltip cosmetics — no API/fetch-path code),
so the CPU tier is the only meaningful delta vs. the post-merge run above.

| Metric | Standard (1 vCPU) | Performance (2 vCPU) | Δ |
|---|---|---|---|
| Requests (every run) | 6 | 6 | — |
| Settle — min | 1802 ms | 1654 ms | −148 ms |
| Settle — median | 2362 ms | **1962 ms** | **−401 ms (−17%)** |
| Settle — mean | 2279 ms | 2037 ms | −242 ms |
| Settle — max | 2685 ms | 2598 ms | −87 ms |
| Settle — stdev | 323 ms | 289 ms | −34 ms |

Where the −401 ms came from (median per-request duration, Standard → Performance):
`/api/areas/readable` **750 → 464 ms (−286)** — and since this is the request that *gates* the data
stage (the stage fires as soon as areas resolve, not when all three chrome calls finish), its win
propagates: the data stage starts at 1446 → 1260 ms median. `/api/data?sys=12` −153 ms,
`/api/history` −115 ms. But `/api/dashboards` (−5), `/api/user/preferences` (−6) and
`/api/data?sys=8` (−19) barely moved — so CPU contention was real but only part of the story; those
endpoints have a ~600 ms floor dominated by something other than CPU (profile with `Server-Timing`
before optimizing further). Client boot (~730–770 ms to first request) is unchanged, as expected.

Cumulative vs. the pre-merge baseline: **3150 → 1962 ms median (−1188 ms / −38%)** from the
fetch-slimming PR + the Performance CPU tier together.

## Server-side phase decomposition (Server-Timing)

The six dashboard endpoints (+ `/api/health` as a public control) decompose each request into named
phases — always on, durations only (`lib/server-timing.ts`; the middleware self-reports its elapsed
via an `x-middleware-dur` request header that the routes fold in as the `mw` entry).

**⚠️ Vercel strips `Server-Timing` in production — read the `x-server-timing` mirror instead.** The
routes emit the phases under **two** headers with the same value (`serverTimingHeaders()`): the
standard `Server-Timing` **and** a custom `x-server-timing`. This is load-bearing: Vercel's edge
removes the reserved `Server-Timing` response header on prod/preview deployments
([vercel/next.js#62353](https://github.com/vercel/next.js/discussions/62353),
[#12382](https://github.com/vercel/next.js/issues/12382)), so the standard header — and therefore the
passive `performance.getEntriesByType('resource')[].serverTiming` field — is **empty on prod**. It is
only populated where there is no Vercel edge in front (local `next dev`/`next start`). The
`x-server-timing` mirror passes through untouched everywhere.

Because the Resource Timing API only parses the standard header, capture the mirror with an explicit
**post-settle re-fetch** of each request the run recorded (same-origin, so the signed-in tab reads
the header directly; these are idempotent GET reads). Append this after the harness's settle loop and
merge `st` back onto each entry by path:

```js
// after the settle loop, before building the JSON result — `entries2` is the settled resource list
const stByUrl = {};
for (const url of [...new Set(entries2.map(e => e.name))]) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    const h = r.headers.get('x-server-timing');
    if (h) stByUrl[url] = h.split(', ').map(s => s.replace(/;dur=/, ':').replace(/(\.\d)\d*$/, '$1'));
  } catch {}
}
// …then in the per-entry mapper add:  st: stByUrl[e.name] || []
```

(Off-Vercel — local dev — you can instead read it passively without the re-fetch via
`st: (e.serverTiming || []).map(s => \`${s.name}:${Math.round(s.duration)}\`)`, since the standard
header survives there.)

Span names: `mw` (the **whole** edge middleware invocation — Clerk's `authenticateRequest`
session/JWT verification + JWKS fetch on cold instances + `auth.protect()`; timed by wrapping
`clerkMiddleware` itself, since Clerk does its expensive work *before* the app callback runs and
protect() is only an in-memory check), `clerk` (handler-side session resolution), `admin`
(isUserAdmin — falls back to a Clerk **API network call** when the isPlatformAdmin session claim
isn't configured), `auth` (the whole access check, containing clerk/admin), then per-route work:
`polling`/`kv`/`build` (/api/data), `list`/`prefs`/`areas` (the chrome routes),
`logical`/`fetch`/`attr`/`serialize` (/api/history), `db` (/api/health), and `total` (handler
elapsed). Spans measure their own elapsed (not deltas), so concurrent spans overlap and may sum past
`total`; duplicate names mean repeated work (e.g. a second `getAuthContext` in an auth fallback
branch) — that repetition is itself signal.

How to read a result: **client-observed `dur` − `mw` − `total` = function invocation + network.**
`mw` runs identically on every matched route — public ones included (only protect() is conditional)
— so the Clerk edge cost is read DIRECTLY off any route's `mw` entry, and `/api/health`'s residual
(same formula, signed-in cookies present) is a clean invocation+network floor to compare the authed
routes' residuals against. Within `total`, a fat `admin` span = the Clerk-API fallback round trip
(fix: configure the isPlatformAdmin session claim); a fat `kv` span = the Vercel KV REST hop (check
the KV store's region vs `syd1`); `auth` − `clerk` − `admin` ≈ DB-side access checks.

## Recorded — Server-Timing phase decomposition, PROD, 2026-07-21 (post-#199)

Target: `https://liveone.energy/dashboard/id/5` (Kinkora), signed in as the account owner. 10 runs
with the harness **augmented by the `x-server-timing` re-fetch block above**, plus a single extra run
capturing each request's full `PerformanceResourceTiming` (connection vs TTFB vs download). Raw data in
[`dashboard-fetch-waterfall-serverTiming-prod-2026-07-21.jsonl`](./dashboard-fetch-waterfall-serverTiming-prod-2026-07-21.jsonl).
This is the **first prod capture of the per-phase decomposition** — it became readable on prod only
after PR #199 (`54ef2b1`) mirrored `Server-Timing` to `x-server-timing` (Vercel strips the standard
header; confirmed here — every route returned a populated `x-server-timing`, all 10 runs `count == 6`).

Settle sanity (no regression vs. the recorded post-#195 runs): min 1975 / **median 2310** / mean 2352 /
max 2933 / stdev 285 ms; client boot (first request start) median ~768 ms. (The 2310 ms median sits
between the recorded Standard-CPU 2362 ms and Performance-CPU 1962 ms medians; the live Function-CPU
tier was not determined, and — see the geography finding below — the settle comparison is confounded by
measuring-client location anyway. `tier` is logged as `"unknown"` in the `.jsonl`.)

### Per-endpoint phase medians (10 runs)

`dur` = client-observed; `mw` (Clerk edge middleware) and `total` (handler) + route spans come from the
warm `x-server-timing` re-fetch. `residual = dur − mw − total`.

| Endpoint | client `dur` | `mw` | `total` | **residual** | fattest server span(s) |
|---|---|---|---|---|---|
| `/api/dashboards` | 614 | 2.8 | 7.5 | **604** | list 5.8 |
| `/api/user/preferences` | 608 | 2.8 | 4.2 | **600** | prefs 3.0 |
| `/api/areas/readable` | 672 | 3.0 | 84.8 | **584** | areas 83.3 (DB, varies 44–140) |
| `/api/data?sys=8` | 642 | 3.3 | 25.9 | **613** | auth 14.9, build 11.2, kv 11.1 |
| `/api/data?sys=12` | 610 | 2.8 | 12.1 | **596** | auth 8.2 |
| `/api/history` (sankey+hws) | 818 | 3.1 | 198.4 | **617** | fetch 82.2, attr 66.3, logical 23.1 |

### The ~600 ms floor is network transport (fra1→syd1), not compute — mystery solved

The CPU experiment above flagged a "~600 ms floor dominated by something other than CPU — profile with
Server-Timing before optimizing further." The instrumentation answers it: **the residual is a nearly
constant ~585–617 ms on every endpoint, regardless of how much server work it does** (handler `total`
ranges 4 → 198 ms; the residual barely moves). The single-run `PerformanceResourceTiming` breakdown
pins down what that residual *is*:

| Request | dns | conn | tls | **ttfb** | download |
|---|---|---|---|---|---|
| dashboards | 0 | 0 | 0 | 705 | 1 |
| user/preferences | 0 | 0 | 0 | 689 | 1 |
| areas/readable | 0 | 0 | 0 | 752 | 1 |
| data?sys=8 | 0 | 0 | 0 | 612 | 9 |
| data?sys=12 | 0 | 0 | 0 | 597 | 1 |
| history | 0 | 0 | 0 | 880 | 4 |

DNS/connection/TLS are **0** (HTTP/2 connection reused) and downloads are ~1 ms (tiny payloads) — the
**entire ~600 ms is TTFB**. And the request's edge id was **`x-vercel-id: fra1::syd1::…`**: the client
reached Vercel at the **Frankfurt** edge (`fra1`), while the function executes in **Sydney** (`syd1`).
So each request pays the **fra1↔syd1 round trip** (~585 ms) on top of its server time:
`TTFB ≈ 585 ms network floor + server total` (history 880 ≈ 585 + ~198; data8 612 ≈ 585 + ~26;
data12 597 ≈ 585 + ~12). The floor is **geography**, not application code — and it is *not* cold-start
(zero connection time; residual is identical on the warm data-stage requests as on the first chrome
request).

**Consequences.**
- This measuring client is far from `syd1` (ingress via `fra1` — traveling / VPN / anycast routing).
  A real user in Australia hits the `syd1` edge, where the edge→function hop is ~0, so their per-request
  TTFB collapses to ~server time (5–200 ms) and settle time is far lower than the 2.3 s recorded here.
  **The environment-independent metric (6 requests, 2 stages) is the trustworthy one** (as this doc's
  intro warns); the absolute settle numbers throughout this doc carry whatever fra1↔syd1 tax the
  measuring client incurred.
- **Handler micro-optimization won't move the chrome routes** — `/api/dashboards` and
  `/api/user/preferences` already return in 4–8 ms server-side. The settle-time levers are structural:
  request **count** (7→6 done) and the **2-stage waterfall** (chrome stage median start ~768 ms → data
  stage ~1460 ms, a ~690 ms gap ≈ one fra1↔syd1 round trip, because the data stage still waits
  client-side for the chrome/areas response).

### Confirmed non-issues (the instrumentation clears them)

- **Clerk admin fallback is NOT firing** — `admin` ≈ 0.5 ms on every route (the doc warned a fat `admin`
  = a Clerk-API round trip from a missing `isPlatformAdmin` claim; it isn't happening).
- **KV hop is healthy** — `kv` ≈ 4–11 ms (same-region REST; `sys=8` heavier than `sys=12`, ~11 vs ~4,
  tracking Kinkora's larger payload). Not a region problem.
- **Clerk edge + handler auth are cheap warm** — `mw` ≈ 3 ms, `clerk` ≈ 0.7 ms.

### The one real server-side target: `/api/history`

`/api/history` (the sankey + hot-water request) is the only route where server work is a meaningful
slice of its latency: `total` ≈ **198 ms**, dominated by `fetch` ≈ 82 ms (series DB read) + `attr` ≈
66 ms (battery-provenance attribution) + `logical` ≈ 23 ms. It is also the **last request to settle**,
so it gates the page's settle time — for an Australian user (no network floor) this ~198 ms *is* the
tail. If a server-side optimization is wanted, `history`'s `fetch` + `attr` is where it pays off;
`/api/areas/readable` (`areas` ≈ 85 ms, DB-bound, high variance) is a distant second.

**Methodology caveat.** The `mw`/`total`/route spans are from a **post-settle warm re-fetch**, so they
measure server phases on a warm instance; the residual (`dur − mw − total`) is what carries network +
any cold penalty. Here the residual is provably network (zero connection time; constant across the
warm data stage), so no cold-start is hiding in it — but on a genuinely cold first hit that would not
hold, and the residual, not `st`, is where it would show.

### Inside `/api/history`: three server-side levers

The `/api/history` total above (~198 ms: `fetch` 82 + `attr` 66) is the **sub-daily sankey path** — the
profiled request carries a `logical` span, which the route emits only for `includeSankey && interval !==
"1d"` (`app/api/history/route.ts:614`). That path computes the attributed flow matrix **live**
(`route.ts:682` → `buildAttributedFlowMatrix`); the **1d** path instead reads the precomputed
`flow_attr_1d` rollup in a single indexed lookup (`route.ts:654-682`, `readAttributedDailyMatrices`). So
the tail measured here is the *un-materialized* variant, and that sets how hard each lever below is. All
three are code fixes in the **existing PostgreSQL path — none needs a new datastore.** (A columnar/OLAP
engine like ClickHouse would not move them: the DB-read slice they touch is already a bounded, indexed
range scan of *pre-aggregated* `agg_5m` rows — no scan/aggregation for a column store to accelerate — and
the bulk of the 148 ms is in-Node CPU, which a faster database does not reduce. Fuller ClickHouse
assessment: it helps ~nothing at current scale, since the page's latency is network geography + client
waterfall shape + in-Node CPU, not DB scan/aggregation.)

Ordered cheapest → hardest:

1. **Redundant `agg_5m` double-read (`fetch` ↔ `attr`).** The `fetch` phase reads the role-point `agg_5m`
   rows via `fetchAggRowsPg` (`lib/history/readings-pg.ts:111-130`) and densifies them onto the 5-min grid
   in JS (`:132-158`). The `attr` phase then **re-reads the same table for the same role points** via
   `loadFlowSeriesFromAgg5m` (`lib/aggregation/flow-series-pg.ts:67-82`), reached through
   `buildAttributedFlowMatrix` → `loadProvenanceInputs`. That is two separate `agg_5m` queries over
   overlapping rows in one request. **Lever:** hand the already-fetched rows to the attribution path (or a
   per-request cache) instead of re-querying. Smallest change, no new storage.

2. **Warm-up over-read in `attr`.** The battery-provenance fold is *stateful*, so `attr` loads **more**
   `agg_5m` history than the displayed window: seeded from a checkpoint anchor capped at `MAX_SEED_SPAN_MS
   = 3.5 days` (`lib/db/planetscale/battery-provenance-pg.ts:516`), or — when seeding fails — from `startMs
   − WARMUP_MS` with `WARMUP_MS = 7 days` (`battery-provenance-pg.ts:71`, applied at
   `lib/history/build-attributed-flow-matrix.ts:155`). So a 1-day sankey can pull up to a week of rows.
   **Lever:** keep the seeded (≤ 3.5-day) path the norm and avoid the 7-day fallback; tighten the seed span.

3. **Densify + fold CPU (not DB).** A large share of the 82 + 66 ms is **in-Node CPU** that no faster read
   reduces: on the `fetch` side the JS densify / 30-min bucketing / series build + the Sankey trapezoidal
   integration (`readings-pg.ts:132-158`, `lib/aggregation/flow-matrix-core.ts`); on the `attr` side the
   stateful `foldBatteryProvenance` + `computeFlowAccounting` (`lib/battery-provenance/compute.ts`,
   `flow-matrix-core.ts:117-248`). **Lever:** materialize the sub-daily sankey + attributed series so the
   request serves a stored result. Note there is **no sub-daily counterpart to `flow_attr_1d` today** (only
   the 1d rollup exists), so this is a genuinely *new* materialization, not a cache of an existing table —
   the biggest lift, worth doing last and only if levers 1–2 don't bring the tail down enough.

These three are the concrete unpacking of `live-dashboard-roadmap.md` §1.3 (1.3a / 1.3b / 1.3c).

## Cross-region confirmation — Sydney (AWS `ap-southeast-2`) vs Italy, 2026-07-21

The runs above were captured from a browser in **Italy**, which ingresses Vercel at the Frankfurt edge
(`x-vercel-id: fra1::syd1`) — so every request paid the ~585 ms `fra1↔syd1` round trip. To measure what
an **Australian** user actually sees, the same harness was run from inside `ap-southeast-2`: a throwaway
**Lambda** (`puppeteer-core` + `@sparticuz/chromium`, non-VPC so it has direct egress) driving headless
Chromium against the **shared** URL `…/dashboard/id/5?access=…` (no auth needed — the share token
bypasses Clerk), plus a node-level `/api/health` probe for a clean network floor. All resources were
deleted after the run. Raw result:
[`dashboard-fetch-waterfall-sydney-lambda-prod-2026-07-21.json`](./dashboard-fetch-waterfall-sydney-lambda-prod-2026-07-21.json).

**The origin flipped as intended:** every request returned **`x-vercel-id: syd1::syd1`** (ingress *and*
function both in Sydney), vs Italy's `fra1::syd1`. That collapses the network floor:

| Metric | Italy (fra1 edge) | Sydney (`ap-southeast-2`) | Δ |
|---|---|---|---|
| `/api/health` warm TTFB (network floor; server ~2.7 ms) | ~610 ms | **~46–50 ms** | **~13× / −93%** |
| Shared-view settle (3 req, 1 stage) | ~1850 ms (1 run) | **496 ms** (median of 10) | ~3.7× |
| `/api/data?sys=8` client `dur` | ~740 ms | **86 ms** (server 34 ms) | — |
| `/api/history` client `dur` | ~1015 ms | **250 ms** (server 176 ms) | — |

Server-side `total` per route was **unchanged** across regions (history ~176–198 ms, data ~26–34 ms) —
exactly as predicted, since the function always runs in `syd1`; only the network leg moved. This is the
direct confirmation that the ~585 ms floor in the Italy runs was **geography, not application code**.

**Implications, now measured rather than modelled:**
- A real Australian user pays a **~46 ms** per-request network floor, not ~585 ms. Reconstructing the
  authed 6-req / 2-stage page for an AU user (network ~46 ms + the known location-independent server
  phases): settle ≈ boot (~700 ms) + stage-1 (~46 + areas 85) + stage-2 (~46 + history 198) ≈
  **~1.0–1.1 s**, vs the 2.3 s measured from Italy. The absolute settle numbers elsewhere in this doc
  are inflated by the measuring client's distance from `syd1`; **request count + waterfall shape remain
  the trustworthy cross-environment metrics.**
- With the network tax gone, **`/api/history`'s ~198 ms server time is the dominant remaining tail** for
  an AU user — reinforcing it as the one worthwhile server-side optimization target (`fetch` 82 ms +
  `attr` 66 ms).

**Method caveats.** (1) The shared view is 3 requests / 1 stage, not the authed 6/2 (it skips the
server-resolved chrome routes) — so its settle isn't the authed settle, but its per-route TTFB and the
`/api/health` floor are what an AU browser sees, which is what we needed. (2) In headless Chromium the
`PerformanceResourceTiming` `responseStart` came back 0, so the browser rows use client `dur` (network +
server) and the clean network floor comes from the node-level `/api/health` probe; the two agree.

### Re-running this (turnkey)

The Sydney harness is captured as reusable code at
[`scripts/perf/sydney-lambda/`](../../scripts/perf/sydney-lambda/): `./run.sh` builds a headless-Chromium
Lambda, deploys it to `ap-southeast-2`, invokes the same 10-run harness + `/api/health` floor probe, saves
the JSON, and **tears everything down** (cost: a few cents); `python3 analyse.py <result.json>` prints the
Sydney-vs-Italy comparison. **Re-run after Superphase 1 lands** (see
[`../architecture/live-dashboard-roadmap.md`](../architecture/live-dashboard-roadmap.md)) and add a dated
`-sydney-lambda-prod-<date>.json` + a comparison row here. Expect the shared-view **settle** to drop (the
`/api/history` precompute + SSR prefetch touch this render path); the **~46 ms network floor won't move**.
