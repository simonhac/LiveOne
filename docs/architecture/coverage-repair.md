# Coverage repair — nightly self-heal for re-fetchable vendors

Status: **current** — deployed and running nightly in prod (see [Status](#status--deployment)).

A nightly, two-stage job that finds coverage gaps in the serving store and backfills them from the
vendor API, for every **re-fetchable** external vendor (Amber, OpenElectricity, Sigenergy). It is the
generalization of the one-off Amber usage backfill into standing infrastructure. Push vendors
(Fronius/DeepSea) are **out of scope** — their gaps are device/network downtime, gone for good.

Engine: `lib/coverage/`. Providers: `lib/vendors/<vendor>/coverage-repair.ts`. Cron:
`app/api/cron/repair-coverage/route.ts` (nightly in `vercel.json`; **shallow** most nights, **deep** on
Mondays — see [Window depth](#window-depth-shallow-nightly-deep-weekly)).

## Why

External-API vendors accumulate holes in `point_readings_agg_5m` that live polling never fills:

- **Amber** — settlement lag. The poll fetches `/usage` for "yesterday, 1 day" only and never
  re-fetches (`lib/vendors/amber/adapter.ts`), but Amber settles metered kwh/cost per NEM day with a
  variable lag. Any day not settled at yesterday-poll-time becomes a permanent whole-day hole in the
  energy+cost points. (Distinct from the 2025-11-26 collision _bug_, which was a code fault — see
  `docs/incidents/2025-11-26-amber-import-channel-collision.md`. The settlement-lag holes are a
  _collection_ gap and affect any usage day.)
- **OpenElectricity / Sigenergy** — brief API/outage windows that the live poll's short auto-heal
  lookback misses; they leave a handful of missing intervals on scattered days.
- **Sigenergy's power + SoC are not re-fetchable at all.** Its cloud API has exactly two data
  endpoints: `energyflow` (an instantaneous snapshot, no history) and `statistics/energy` (5-minute
  cumulative ENERGY counters). So energy self-heals perfectly while power and SoC — the series the
  dashboard actually draws — accumulate permanent holes at every slot the 5-minute poll misses, and
  Sigenergy has exactly ONE sample per bucket, so there is no redundancy to absorb one. Measured on
  prod 2026-08-01..30: energy 0/8640 missing, power and SoC 70/8640, always the same intervals.
  Those are RECONSTRUCTED rather than re-fetched — see
  [Sigenergy power recovery](#sigenergy-power--soc-recovery).

The common shape: each vendor already has a **backfill** primitive (re-fetch a range/day and publish),
but only Amber had a **gap-finder** and a scheduler. This framework supplies the missing half —
detection + scheduling — once, generically.

## The two stages

1. **Find gaps** — `lib/coverage/find-gaps.ts::findCoverageGaps`. Generic, READ-ONLY. Scans
   `point_readings_agg_5m` and flags any local trading day where a coverage point has fewer than the
   expected intervals. Parameterized by **cadence** (`expected = 1440 / cadenceMinutes` → 48/day for
   30-min Amber, 288/day for 5-min OE/Sigen) and the **local-day bucket offset**. Dry-run stops here.
2. **Backfill** — the per-vendor `CoverageRepairProvider.backfillDay`. Re-fetches one gap-day from the
   vendor API and publishes it through the shared collector → QStash → receiver → `agg_5m` path.

`lib/coverage/runner.ts::runCoverageRepair` sequences them across every provider × active system:
enumerate → detect → (prepare creds + backfill per gap-day into one session/collector → flush) →
wait for the async writes to land → recompute the scoped derived tables → post an itemised report.

## The provider contract

`lib/coverage/types.ts::CoverageRepairProvider`. Each vendor declares `cadenceMinutes`, the
`expectedPointTails` (the coverage set), `bucketOffsetMin(system)`, `needsCredentials`, and implements
`prepare(system)` (load creds / build a client, or an error) + `backfillDay(...)` (fetch + map the
native result → `repaired | unsettled | error`). Registered in `lib/coverage/providers.ts`.

| vendor          | cadence         | coverage points (detection)                                           | creds                                      | day basis     | backfill primitive                      | recoverable window     |
| --------------- | --------------- | --------------------------------------------------------------------- | ------------------------------------------ | ------------- | --------------------------------------- | ---------------------- |
| Amber           | 30-min (48/day) | `E1/kwh,E1/cost,B1/kwh,B1/cost`                                       | per-owner (Clerk)                          | AEST +10      | `fetchAmberUsage`→`storeRecordsLocally` | ~90 days               |
| OpenElectricity | 5-min (288/day) | `nem/price,nem/renewableProportion,nem/demand,nem/emissionsIntensity` | **ownerless** (`OPEN_ELECTRICITY_API_KEY`) | AEST +10      | `backfillRange` (one day)               | deep (months)          |
| Sigenergy       | 5-min (288/day) | six `*_interval_wh` **+ `solar_w,grid_w,battery_w,load_w,ev_w,battery_soc`** | per-owner (Clerk)                          | station-local | `backfillEnergyRange(day,day)`          | **unknown** (see note) |

## Invariants & gotchas (the non-obvious decisions)

- **Detection excludes only genuinely-sparse points — and OE's `nem/emissionsIntensity` is NOT one.**
  It is computed and skips `emissions ≤ 0` / `power ≤ 0` intervals, which sounds sparse, but those
  never fire for a whole NEM region (aggregate power is always thousands of MW, emissions always
  hundreds of tCO2). Empirically it is ~288/day (NSW1: short on only 6/329 days, comparable to
  price/renewables/demand), and its short days are the SAME recoverable `data`-endpoint publish-lag
  holes we want to heal. So it **is** in OE's coverage set. The runner's progress-based landing keeps
  the one theoretical edge case (a genuinely zero-emissions region interval) harmless — it just stays
  `unsettled`, never a false "repaired" loop. (An earlier version excluded it on the untested
  assumption it was "< 288/day by design"; the data refutes that.)
- **Amber backfill must be UNCONDITIONAL.** Use `fetchAmberUsage → buildRecordsMapFromAmber →
storeRecordsLocally`, **not** `updateUsage`. `updateUsage` is a quality-based _sync_ that early-exits
  when the local present intervals are already billable (`lib/vendors/amber/client.ts`), so it will
  **not** fill missing intervals on a partially-present day. (It happens to work only when the whole
  day is absent.) Coverage repair targets count-gaps, so it always re-fetches. `storeRecordsLocally`
  is idempotent, so re-writing present intervals is harmless.
- **The runner owns ALL recompute, scoped.** After landing it calls
  `recomputeDerivedForDeviceDays` (`lib/aggregation/scoped-recompute.ts`) per repaired device —
  `agg_1d` for each day, plus the per-Area flow matrix and battery provenance where the device
  belongs to an Area. Providers pass `aggregate: null` — the runner **never** calls the all-systems
  `aggregateRange` fleet cascade. (OE region systems have no Area → agg_1d only.)
  That module is SHARED with `/api/cron/sigenergy-backfill`, which used to call `aggregateRange` and
  therefore spent its entire 300 s `maxDuration` in it on every live run — see the note under
  "Relationship to the manual backfill routes".
- **Landing is PROGRESS-based, not `== expected`.** A day is "landed" when its max present-count rises
  above the pre-repair value _or_ reaches `expected`. Strict equality would hang forever on points
  that legitimately can't reach the full count.
- **Credential policy lives in `prepare()`.** A real backfill always gets non-null creds; dry-run
  never calls `prepare()`; OE resolves a global key. Vendor fetch primitives never see nullable creds.
- **Per-vendor budget.** `REPAIR_MAX_DAYS_PER_RUN` caps repairs _per vendor_ so one vendor can't starve
  the others; overflow rolls to next week (reported as `deferred (cap)`).
- **Sigenergy's recoverable window is UNKNOWN — do not assume 90 days.** We could not measure it: the
  only Sigen site available (Kutis, `devices.created_at` 2026-07-06) is younger than ~2 weeks, so a
  fetch for any older day returns empty because the site didn't exist yet — which says nothing about
  the API's retention. Determine the real limit against an older site (or from Sigen's API docs) before
  relying on the uniform 7–90d window for Sigen; if it proves short, give Sigen a shorter `lookbackDays`
  to avoid reporting permanently-unrecoverable old days as `unsettled` each week. The framework already
  handles whatever the true limit is (older-than-available days → `unsettled` → reported, not retried
  destructively).

## Write path, reporting, config

- **Write path** — the same single-writer pipeline as live polling: build readings →
  `PointManager.insertPointReadingsAgg5m(systemId, session, readings, collector)` → flush at session
  close via `sessionManager.updateSessionResult(...)` → QStash → `/api/observations/receive` (idempotent
  UPSERT). See `architecture/engine-web-separation.md` and `observations-qstash-payloads.md`.
- **Reporting** — an itemised summary posts to the monitor channel (`OBSERVATIONS_ALERT_WEBHOOK_URL`),
  🟢 ok / 🟡 warn (unsettled / deferred / not-yet-landed) / 🔴 alert (errors). See `operations.md`.
- **Config (env, all optional)** — `REPAIR_LOOKBACK_DAYS` (10 — the SHALLOW nightly window; a deep
  run uses each provider's own 90), `REPAIR_SETTLEMENT_GRACE_DAYS` (defaults to the provider's, 7),
  `REPAIR_MAX_DAYS_PER_RUN` (120/vendor), `REPAIR_LANDING_WAIT_SECONDS` (120). A deep window is
  uniform **7–90 days** for all vendors.
- **Manual invocation** — `GET /api/cron/repair-coverage` with `?dry=true` (Stage-1 report only),
  `?vendor=<amber|openelectricity|sigenergy>` (target one), `?force=true` (bypass the `CRONS_ENABLED`
  kill-switch). Auth: `Authorization: Bearer $CRON_SECRET` or an admin session.

## Parallelisation & scaling

The runner fans the **vendors out concurrently** (`Promise.all` over providers in
`lib/coverage/runner.ts`) — they hit independent APIs with independent credentials, so there is no
interaction between them. **Systems within a vendor run sequentially** today; with 1–2 systems per
vendor that is immaterial.

When a vendor grows to **many systems**, parallelise across systems too — the safety depends on the
credential model, not on "it's the same vendor":

- **Amber / Sigenergy** — each system is a **different owner with its own API key**, so their rate
  limits are independent. Fan out across systems freely. The only thing that shares a budget is many
  gap-days _within a single system_ (they use that one owner's key), so keep per-system fetch
  concurrency modest.
- **OpenElectricity** — a **single global key** (`OPEN_ELECTRICITY_API_KEY`) shared by all regions, so
  cross-system concurrency shares one budget; bound it. (`backfillRange` already has retry/backoff and
  a `rateLimited` counter, so it degrades gracefully rather than failing.)

**Runtime budget** — `maxDuration = 300s`. Detection is milliseconds; each gap-day fetch is ~1–2s; the
landing wait polls up to `REPAIR_LANDING_WAIT_SECONDS` (usually resolves in one poll); recompute is
fast. Steady-state (a handful of fresh gaps) runs comfortably. `REPAIR_MAX_DAYS_PER_RUN` (per vendor)
bounds a first-run/backlog and rolls the remainder to next week.

**The scaling invariant — and why batching is easy.** The only real requirement is **"every eligible
system is repaired at least once a week"** — _when_ within the week does not matter. So as the fleet
grows we do **not** need to process everything in one deep request: do a **slice
per run** (round-robin systems, or a cursor/queue that drains over the week — the same shape as
`recompute-provenance`'s `nextCursor` loop). That scales indefinitely while keeping every invocation
well inside the time budget. When that day comes, also take the **landing-wait + recompute off the
critical path**: recompute on the _next_ run, keyed on "`agg_5m` present but `agg_1d` stale"
(race-free, no blocking). Neither is needed yet.

## Window depth: shallow nightly, deep weekly

The cron runs nightly, but a nightly pass over the full 7–90 day window would re-fetch every
permanently-unrecoverable day in it every night: nothing records that a gap has been *accepted*
(see [Status](#status--deployment)), so the same days recur forever against a per-vendor budget
inside a 300 s function.

So the route picks its own depth: **shallow** (`REPAIR_LOOKBACK_DAYS`, default 10 days — enough for
Amber settlement and the week's fresh holes) on most nights, and **deep** (each provider's own
`lookbackDays`, 90) on Mondays UTC — the slot this cron occupied when it ran weekly. A shallow
window is always a subset of the deep one, never a different window.

`?deep=true` and `?lookback=N` override, for manual runs. The depth is decided in the route rather
than by a second cron entry with a query string, so it is testable without deploying.

## Sigenergy power & SoC recovery

`lib/vendors/sigenergy/derive-power.ts`, invoked from the energy backfill. For any 5-minute interval
that has energy but NO power row, it writes:

- `calculated` — exact, by identity, from the same interval's energy (Wh × 12 = mean W): solar,
  grid (`import − export`), battery (`discharge − charge`), and TOTAL load.
- `interpolated` — linear between bracketing **measured** samples, holes ≤ 3 intervals only: SoC,
  and the EV / rest-of-house split of that total load.

Three things worth knowing before touching it:

- **`load_interval_wh` is TOTAL load — it includes the EV.** Verified on prod 2026-08-20: on
  intervals where the EV draws > 2 kW, median |`powerUse`×12 − rest-of-house| is 7060 W against
  290 W for |`powerUse`×12 − (rest-of-house + ev)|. The energy counters cannot separate the two, and
  the vendor's balance identity is pure conservation so it adds nothing — hence an interpolated
  split, with the exact total preserved.
- **The counters drop out.** They occasionally read ~0 for a sample and repay the difference later,
  which `computeDayEnergyReadings` deliberately keeps as signed diffs so the day still telescopes to
  the vendor total. Correct for a total, useless for one interval: ×12 would paint a 300 kW spike.
  The guard tracks an unrepaid deficit per counter (negatives within one 0.01 kWh ULP are rounding
  flicker, not a dropout). Over 2026-08-01..30 that took the worst |derived − measured| from
  323.6 kW to 5.6 kW (solar), 33.2 → 5.5 kW (grid), 203.9 → 6.4 kW (battery), keeping 98–99 % of
  intervals. Leave-one-out, SoC interpolation is accurate to 0.85 % worst case.
  **Whether the vendor SENDS those zeros or we coerce them is not established** — `pullEnergyDay`
  discards the raw payload, so the session archive cannot answer it. See
  [plans/sigenergy-counter-dropout-forensics.md](../plans/sigenergy-counter-dropout-forensics.md).
- **Nothing measured is ever overwritten.** The write path upserts at the receiver, so the
  protection is that rows are only emitted for intervals that had none — plus a 30-minute settle
  margin for the read-then-write window. If a real sample later lands on a derived interval, the
  raw→5m recompute clears the marker (`clearDerivedQuality` in `lib/readings/dao.ts`), so a
  measurement is never left labelled as invented.

## Relationship to the manual backfill routes

`app/api/cron/openelectricity-backfill` is a **manual, range-based** tool (you POST an explicit date
range; no detection). `app/api/cron/sigenergy-backfill` has the same shape but **is scheduled**
(nightly, `20 14 * * *`) and is the PRIMARY writer of Sigenergy interval energy — coverage repair is
only its backstop.

⚠️ **`aggregateRange` is the wrong recompute for a backfill, and was silently costing the whole
budget.** It rebuilds `agg_1d` for every device over the range, then re-runs HWS, battery learning,
provenance, run periods and two backlog reheal passes — most from the range start to *now*, none
scoped to a device. Measured on prod 2026-08-31: a ONE-DAY Sigenergy backfill spent all 300 s of
`maxDuration` there and returned an empty response, so every nightly run was timing out, burning a
full invocation and reporting nothing. It looked healthy only because the queue flush happens
*before* the recompute, so the data always landed, and `cron/daily` rebuilt `agg_1d` overnight.
Both callers now use the scoped recompute, and the fleet backlog stays `cron/daily`'s job.

One consequence worth knowing: the old pass was slow enough to incidentally mask the
publish→recompute race (the 5m rows land asynchronously via the queue). A fast recompute exposes it,
so the route now waits for the landing watermark — `MAX(updated_at)` over the device's 5m rows,
compared against a baseline taken *before* the flush, so app/DB clock skew cannot make a stale read
look fresh. The coverage-repair cron is the **automated, self-detecting** counterpart,
wrapping the same underlying re-fetch primitives.

## Adding a vendor

Implement `CoverageRepairProvider` in `lib/vendors/<vendor>/coverage-repair.ts` (declare cadence +
coverage tails + creds policy + `bucketOffsetMin`; wire `backfillDay` to the vendor's re-fetch
primitive with the shared collector) and add it to `lib/coverage/providers.ts`. The generic finder,
runner, landing wait, recompute, and reporting are reused as-is. A vendor is only eligible if its API
lets you **re-fetch history** — push/webhook vendors cannot self-heal.

## Testing

- **Dry-run (any env)** — `?dry=true` runs Stage-1 only: lists gaps per vendor, no writes, no creds.
- **Provider fetch (dev, read-only)** — call `prepare()` + `backfillDay()` for a settled gap-day and
  inspect the returned status + `collector.observations.length` **without flushing** (no writes). This
  exercises the per-owner credential path (Amber/Sigen creds live in **prod** Clerk, so a dev run needs
  the prod `CLERK_SECRET_KEY`; OE uses the global key).
- **End-to-end (prod)** — `?force=true&vendor=<v>` against one system: verify a session row, `agg_5m`
  fills, the landing wait resolves, `agg_1d` recomputes only that system/day (no fleet cascade), and the
  monitor report itemises `repaired`.
- **Dev limitation** — the write→land→recompute step **cannot** be exercised on dev: the dev receiver
  (`/api/observations/receive-dev`) is **log-only** (no DB write). Wiring a dev-DB-connected receiver
  ("QStash in dev") is the enabler for full end-to-end dev testing and is tracked as future work.

## Status / deployment

**Live.** The cron is scheduled in `vercel.json` (`45 14 * * *` UTC — nightly, deep on Mondays) and
`CRONS_ENABLED=true` in prod, so it runs unattended. It was built and validated in 2026-07
(Stage-1 detection + provider `prepare`/`backfillDay` proven on dev for all three vendors; full
write→land→recompute proven on prod for OpenElectricity, healing 12 real gaps) and has since healed
gaps in normal operation.

Two things are still open, and both are about *interpreting* the report rather than about the
machinery:

- **Sigenergy's recoverable window is still unmeasured** — see the gotcha above. Until it is known,
  old Sigen days may be reported `unsettled` every week without ever being recoverable.
- **A source-confirmed permanent hole is reported forever.** There is no way to mark a gap
  "accepted — the vendor genuinely has no data here", so a known-unrecoverable day recurs in every
  report as noise. A commission-date floor already suppresses pre-commissioning days (and
  note the trap that a vendor's commission date can *predate* all its data and manufacture a phantom
  gap — investigated and fixed for Kutis, 2026-07-28), but that only covers the before-the-start
  case.
