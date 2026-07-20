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
