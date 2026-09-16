# Reading production logs

> **Status:** current. Written 2026-09-16. How to find out **why something is (or is not) happening**
> in prod from the app's own runtime output. It does not cover BetterStack *checks and heartbeats* —
> those are OpenTofu in the `infra` repo ([infra-ownership.md](infra-ownership.md)) — nor gousher's
> OTel **metrics** ([production-telemetry.md](../packages/gousher/docs/production-telemetry.md)).

## Which source

| I am debugging | Source | Tool |
| --- | --- | --- |
| the app: API routes, crons, the receiver | **`liveone-vercel`** (id `2761006`, HTTP drain) | `vercel logs`, or BetterStack SQL |
| usher / the Fly hub | **`liveone-usher`** (id `2754099`, OTel) | BetterStack SQL |
| gousher metrics (rates, durations) | see [production-telemetry.md](../packages/gousher/docs/production-telemetry.md) | BetterStack SQL |

The rest (`liveone-production`, `-observer`, `-telemetry-*`) are OTel/verification sources. Querying
the wrong one returns **nothing rather than an error**, which reads exactly like "it never ran".

`vercel logs` is the fast path for the app while you are actively debugging. BetterStack is for
anything you need to **count, group, or reach back through** — and for usher, which has no CLI.

## The `[Prefix]` convention — the key to searching this codebase

Almost every log line starts with a bracketed subsystem tag, and that is the most effective filter
there is. The live inventory, by volume over a typical 6 hours:

```
Cron  ObservationsReceiver  Selectronic  PG-Agg5m  PollCollector  RunTracking  PointManager
Amber  gush  Mondo  HWS  collectors  v4  Sigenergy  Tesla  BatProv  VendorRegistry
MonitorObservations  SessionId  RepairCoverage  RepairAttr  HealStale  Daily Points  Site Processor
```

Regenerate it rather than trusting this list — prefixes come and go:

```sql
SELECT extract(JSONExtract(raw, 'message', 'Nullable(String)'), '^\[([A-Za-z0-9 _-]+)\]') AS prefix,
       count() AS n
FROM s3Cluster(primary, t515553_liveone_vercel_s3)
WHERE _row_type = 1 /* logs */ AND dt > now() - INTERVAL 6 HOUR AND prefix != ''
GROUP BY prefix ORDER BY n DESC
```

## Recipes

### "What is broken right now?" — start here

One query, 24 hours, every distinct error and warning collapsed by shape with an example and a
recency. This is the highest-value query in this document: it is what would have surfaced the #462
`42803` regression on day one instead of day five.

```sql
SELECT count() AS n,
       max(dt) AS last_seen,
       substring(any(JSONExtract(raw, 'message', 'Nullable(String)')), 1, 160) AS example
FROM s3Cluster(primary, t515553_liveone_vercel_s3)
WHERE _row_type = 1 /* logs */
  AND dt > now() - INTERVAL 24 HOUR
  AND JSONExtract(raw, 'level', 'Nullable(String)') IN ('error', 'warning')
GROUP BY _pattern
ORDER BY n DESC
```

`_pattern` groups messages that differ only in their variable parts (ids, numbers), so one recurring
failure is one row instead of 170. It is an opaque hash, so **always carry `any(message)` as the
exemplar** — grouping by it alone tells you nothing. For scale: a healthy day is ~146k `info`,
~290 `warning`, ~60 `error`.

### "Is this cron running at all?"

```sql
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') AS message
FROM s3Cluster(primary, t515553_liveone_vercel_s3)
WHERE _row_type = 1 /* logs */ AND dt > now() - INTERVAL 24 HOUR
  AND JSONExtract(raw, 'proxy', 'path', 'Nullable(String)') LIKE '%repair-attr%'
ORDER BY dt DESC
```

`proxy.path` is how you scope to a route; the message prefix is how you scope to a subsystem. An
empty result means it did not run — check `CRONS_ENABLED`, then `vercel.json`.

### "Why did X not happen?"

Absence of a log line is weak evidence. Work down this ladder:

1. **Did the invocation run?** Filter on `proxy.path` (above). No rows ⇒ it never started.
2. **Did it get past its guards?** Most crons log a skip reason (`cronSkipReason`) or return
   `{skipped: …}` rather than logging loudly.
3. **Did it finish?** See the timing trap below — a long function's last lines do not exist yet.
4. **Did it throw somewhere that swallows?** Several backstops catch by design
   (`healStaleAgg1dForDevice`), so the only evidence is a `console.error` and nothing downstream
   changes. Search the subsystem prefix, not the symptom.

### "Trace one request end to end"

```sql
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') AS message
FROM remote(t515553_liveone_vercel_logs)
WHERE dt > now() - INTERVAL 30 MINUTE
  AND JSONExtract(raw, 'requestId', 'Nullable(String)') = '<request id>'
ORDER BY dt ASC
```

Take the `requestId` off any line you already have. **This is the default technique for "how did that
run go"**, not a fallback: a substring search scatters one invocation among unrelated results and
silently omits whatever has not landed.

### "Is the pipeline behind?"

```sql
SELECT dateDiff('second', max(dt), now()) AS lag_seconds
FROM remote(t515553_liveone_vercel_logs) WHERE dt > now() - INTERVAL 10 MINUTE
```

Measured 2026-09-16: **~10 s** for BetterStack, **~5–15 s** for `vercel logs`. If a line seems
missing, the pipeline is almost never why.

## 🛑 The timing trap

**A long-running function's final lines do not exist until it returns.** No tool fixes this and it is
not lag.

Worked example: the `repair-attr` cron streamed its per-chunk `[BatProv]` lines the whole way through
(each visible ~2 s after it was written), but wrote its summary **130 seconds in**. Three searches at
the 60–120 s mark concluded "the log is missing". It had simply not been written.

Before deciding a line is absent:

- `[GET] /api/… status=200` is stamped at the invocation's **START**. Its presence does not mean the
  function finished, and the `200` beside it is not evidence of a clean run.
- Vercel's `REPORT … Duration: 130226 ms` is the line that says it ended, and carries wall clock and
  peak memory.
- A function's tail (final `console.log` + `REPORT`) arrives as one batch, sharing a timestamp.

## Why your search returned nothing

Both tools fail **silently and identically** for "no matching rows" and "you asked wrong".

### `vercel logs`

```bash
# the usual: prod, recent, expanded
vercel logs --no-branch --environment production --since 10m --no-follow -x

# live tail while you trigger something
vercel logs --no-branch --environment production --follow

# errors only
vercel logs --no-branch --environment production --since 1h --no-follow --level error

# one invocation
vercel logs --no-branch --request-id <id> --json
```

- 🛑 **Piped output is empty unless `--json`.** The table is TTY-only, so `vercel logs … | grep foo`
  matches nothing, always. Same family as `vercel ls` printing its table to **stderr**.
- 🛑 **`--query` searches the message body, not the path.** A handler that logged nothing has an
  empty message, so `--query "api/health"` will not find its own `/api/health` request.
- 🛑 **`--branch` defaults to the current git branch.** On a feature branch that yields nothing from
  prod. Pass `--no-branch --environment production` unless you mean a preview.

### BetterStack

- 🛑 **`remote(…_logs)` holds the last ~30 MINUTES only.** Older rows are in
  `s3Cluster(primary, …_s3)`, which **requires `_row_type = 1 /* logs */`** because it fans in every
  row type. A window straddling the boundary needs both, `UNION ALL`'d — and an empty result from
  `remote()` alone usually just means the rows aged out of it.
- Fields live in a `raw` JSON column; nested paths are separate arguments
  (`JSONExtract(raw, 'proxy', 'path', 'Nullable(String)')`), and `Nullable()` is required or the
  query fails on any row missing the field.
- A subquery must **project every field the outer `WHERE` uses** — referencing `raw` outside the
  subquery that selected it fails with `Unknown expression or function identifier 'raw'`.
- 🛑 **No history before 2026-09-14**, when the source was created. Absence of a line before that is
  not evidence the event did not happen — date older incidents from git or the database.

## Before reaching for logs at all

Two faster answers, for the cases where they apply:

- **A cron you can trigger returns its own result.** Every `/api/cron/*` route responds with
  structured JSON (`repair-attr` → `{days, selected, remaining, timedOut, elapsedMs}`), and most take
  `?force=true` to bypass the `CRONS_ENABLED` kill-switch. That is synchronous and exact.
- **Ask the database what happened**, not the log describing it. `liveone device coverage`,
  `liveone area flows` and friends read the effect rather than the narration, and a repair that
  logged success but wrote nothing is only visible this way.

Logs remain the right tool for anything you did not trigger, anything that failed before it could
return, and any "why is this recurring" question — which is what the recipes above are for.
