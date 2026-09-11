# Record that a rebuild is owed

> **Status:** OPEN, not started. Fallout from the publish→recompute race fix (2026-09-11), which
> replaced a silent corruption with a bounded, best-effort recovery. The bound is honest slack, not a
> proof, and this is what a proof would take.
>
> Nothing here is urgent. The live defect is fixed; what remains is that the *backstop* is
> probabilistic and, more importantly, that nothing in the system can answer "is any daily aggregate
> owed a rebuild?" — which is the question whose absence made 2026-09-09 expensive.

## Why

`point_readings_agg_1d` is a pure function of `point_readings_agg_5m`, but **nothing recomputes a past
day on its own**: the observations receiver rebuilds 5m only (1d is a deliberate no-op), `cron/daily`
visits yesterday and never returns, and coverage repair re-detects work from *missing* 5-minute rows.
So a day whose rebuild does not happen stays wrong, stays self-consistent, and is invisible.

That is not hypothetical. Kutis' 2026-09-09 daily totals read solar 0 Wh and load 1,860 Wh against
5-minute rows summing to 35,330 and 20,210 — wrong for two days, through two nightly runs, found only
by summing the two by hand. The cause (a landing wait that stopped on the first row of the first
message) is fixed. The consequence — that being wrong is undetectable — is not.

The fix made this sharper rather than softer. A run that cannot confirm its rows landed now **skips**
the recompute instead of writing a partial day. That is the right call, and it means a rebuild is
routinely *owed* and never recorded.

## What is actually open

`healStaleAgg1dForDevice` (`lib/aggregation/heal-stale-agg1d.ts`) rediscovers owed days by comparing
`MAX(agg_5m.updated_at)` against `agg_1d.updated_at` per (point, day). It works, and it is the only
thing in the system that can notice a wrong past day. It is bounded three ways, and each bound is a
way a day can still be lost:

1. **Time.** It looks back the deepest provider window (90d) plus a 30-day margin. A day repaired at
   the edge of the repair window whose rebuild is skipped has ~30 nights of attempts; if it survives
   them it ages out, and with its 5-minute coverage complete nothing re-detects it. Ever.
2. **Budget.** The sweep yields to `HEAL_BUDGET_MS` and rotates its device order daily, so on a
   degraded fleet a given device gets materially fewer than 30 attempts — precisely when it needs
   more.
3. **Vendor.** Only devices reached by the coverage runner or the Sigenergy backfill are swept.
   **Enphase is reached by neither**: it repairs yesterday during 01:00–05:59 local (after the
   daily rollup) and publishes 5-minute data without rebuilding daily aggregates
   (`lib/vendors/enphase/adapter.ts`). Latent today — there are no active Enphase devices — but it is
   the same missing primitive, not a separate bug.

None of these is likely. All of them fail the same way: silently, permanently, and in a number a
dashboard will happily render.

## Options

### A. Persist the debt — a `recompute_debt` table

`(device_rid, day, reason, created_at, attempts)`. Written when a recompute is skipped, or by any
publisher that lands 5m rows for a past day. Deleted on successful rebuild. The sweep drains the
table instead of scanning for staleness.

- **Closes all three bounds.** No time window, no vendor set, and a budget deferral leaves the row in
  place rather than losing the day.
- **It is a monitoring primitive, and that is the real argument.** "How many rebuilds are owed" is a
  number that can be alerted on. Today there is nothing — the 9 Sep damage was recoverable in one
  command; what cost two days was that nothing said it was wrong. A staleness *scan* can only answer
  the question when asked, and only within its window; a debt *table* answers it always.
- Costs a schema change, which is a manual prod migration and needs approval (see CLAUDE.md). Adds a
  row that can itself be written and never drained — but visibly, which is the point.

### B. Unbounded staleness scan, weekly

Keep the scan; drop its lookback on the deep (Monday) run only, keeping the bounded nightly one.

- No schema change, no approval. Removes bound 1 outright.
- Costs a near-full pass of `point_readings_agg_5m` (~3M rows) once a week. CLAUDE.md warns against
  full scans of that table; weekly and per-device-range makes it defensible, but it is not free and
  it grows with history while the debt table does not.
- Does nothing for bounds 2 or 3.

### C. Make the recompute durable instead of inline

Publish the recompute as its own delayed QStash message rather than doing it at the end of the run;
let QStash's retries carry it.

- No schema change, and it takes the landing wait off the critical path entirely — the delayed job
  can check landing itself and re-enqueue.
- QStash retries are finite, so a job that exhausts them is lost unless recorded — which lands back
  at A. Best read as a *complement* to A, not an alternative.

### D. Leave it

The margin plus rotation covers realistic outages, the fleet is one user's, and the failure is now at
least discoverable by comparing Σ5m against `agg_1d`. Defensible; it just leaves the system unable to
tell you it happened.

## Recommendation

**A, when a schema change is being made anyway** — and cheaply, **extend the sweep to every active
device** rather than only coverage-vendor devices, which closes bound 3 (Enphase) for free and needs
no migration.

Do **B** only if A is being deferred a long time; it buys the time bound and nothing else.

The order matters less than the reason: build A for the observable, not for the durability. The
durability is a nice consequence of a table that exists to answer a question nobody can currently ask.

## Prior art in this repo

- `docs/architecture/coverage-repair.md` § "Relationship to the manual backfill routes" — the race,
  the two wrong wait implementations, and the bounds on the current sweep.
- `lib/observations/landing.ts` — why completion is keyed on `session_id` rather than a timestamp.
- The same "nothing records that this is accepted/owed" shape appears in coverage repair's own open
  gap: nothing records that a *data* hole has been accepted, so the same days are re-fetched forever.
  One table could plausibly answer both questions; worth checking before designing this one alone.
