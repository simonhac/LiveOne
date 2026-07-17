# Coverage repair — weekly self-heal for re-fetchable vendors

Status: **current** (framework built + validated; not yet deployed — see [Status](#status--deployment)).

A weekly, two-stage job that finds coverage gaps in the serving store and backfills them from the
vendor API, for every **re-fetchable** external vendor (Amber, OpenElectricity, Sigenergy). It is the
generalization of the one-off Amber usage backfill into standing infrastructure. Push vendors
(Fronius/DeepSea) are **out of scope** — their gaps are device/network downtime, gone for good.

Engine: `lib/coverage/`. Providers: `lib/vendors/<vendor>/coverage-repair.ts`. Cron:
`app/api/cron/repair-coverage/route.ts` (weekly, in `vercel.json`).

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
| Sigenergy       | 5-min (288/day) | six `*_interval_wh`                                                   | per-owner (Clerk)                          | station-local | `backfillEnergyRange(day,day)`          | **unknown** (see note) |

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
- **The runner owns ALL recompute, scoped.** After landing, it calls `recomputeAgg1dForDay(db, system,
day)` per repaired system-day, plus per-area `recomputeFlowMatrixForDay` + battery provenance where
  the system belongs to an Area. Providers pass `aggregate: null` — the runner **never** calls the
  all-systems `aggregateRange` fleet cascade. (OE region systems have no Area → agg_1d only.)
- **Landing is PROGRESS-based, not `== expected`.** A day is "landed" when its max present-count rises
  above the pre-repair value _or_ reaches `expected`. Strict equality would hang forever on points
  that legitimately can't reach the full count.
- **Credential policy lives in `prepare()`.** A real backfill always gets non-null creds; dry-run
  never calls `prepare()`; OE resolves a global key. Vendor fetch primitives never see nullable creds.
- **Per-vendor budget.** `REPAIR_MAX_DAYS_PER_RUN` caps repairs _per vendor_ so one vendor can't starve
  the others; overflow rolls to next week (reported as `deferred (cap)`).
- **Sigenergy's recoverable window is UNKNOWN — do not assume 90 days.** We could not measure it: the
  only Sigen site available (Kutis, `systems.created_at` 2026-07-06) is younger than ~2 weeks, so a
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
- **Config (env, all optional)** — `REPAIR_LOOKBACK_DAYS` (90), `REPAIR_SETTLEMENT_GRACE_DAYS` (7),
  `REPAIR_MAX_DAYS_PER_RUN` (120/vendor), `REPAIR_LANDING_WAIT_SECONDS` (120). The window is uniform
  **7–90 days** for all vendors.
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
grows we do **not** need to process everything in one weekly request: run more often and do a **slice
per run** (round-robin systems, or a cursor/queue that drains over the week — the same shape as
`recompute-provenance`'s `nextCursor` loop). That scales indefinitely while keeping every invocation
well inside the time budget. When that day comes, also take the **landing-wait + recompute off the
critical path**: recompute on the _next_ run, keyed on "`agg_5m` present but `agg_1d` stale"
(race-free, no blocking). Neither is needed yet.

## Relationship to the manual backfill routes

`app/api/cron/openelectricity-backfill` and `app/api/cron/sigenergy-backfill` remain as **manual,
range-based** tools (you POST an explicit date range; no detection). The weekly coverage-repair cron is
the **automated, self-detecting** counterpart, wrapping the same underlying re-fetch primitives.

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

Built + validated on branch `simonhac/rebase-env-fix` (2026-07-16); **not yet deployed**. Validation:
typecheck clean; Stage-1 detection + provider `prepare`/`backfillDay` proven on dev for all three
vendors; full write→land→recompute proven on prod for OpenElectricity (healed 12 real gaps). Deploying
requires the merge + `CRONS_ENABLED=true` (already set in prod).
