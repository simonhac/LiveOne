# Generator events API rewrite

> **Status:** ✅ resolved 2026-06-13 — replaced by the run-tracking feature.

The old `GET /api/system/[systemId]/generator-events` did an **unbounded full-history fetch**
of `point_readings` plus **N+1 energy queries** (one per event). It has been removed.

Replacement: a generalisable, logical-layer **run-tracking** feature (`lib/run-tracking/`):

- `device_trackers` (per-instance config: a power point + HA-style threshold `lower`/`upper` +
  `hysteresis`, plus `delay_on`/`delay_off` anti-flap) and `device_run_periods` (the persisted
  serving store; NULL `end_time` = the open "running now" period).
- A pure, unit-tested detector (`lib/run-tracking/detect.ts`) + batched energy
  (`lib/run-tracking/energy.ts`, no N+1) + an idempotent, bounded delete-and-reinsert recompute
  (`lib/db/planetscale/run-periods-pg.ts`).
- A minutely cron (`/api/cron/run-periods`, 6h trailing window + backfill/regenerate/delete
  actions) and a **bounded** read API (`GET /api/system/[systemId]/run-periods?role=generator&period=30d`)
  that returns the legacy `{ events, totalEnergyKwh }` shape for `role=generator`.

The generator tracker reproduces the legacy definition (grid import > 50W ⇒ on, 120s coalescing)
via config (`lowerW=-50`, `delayOffSeconds=120`), so the cutover is "same events, now bounded and
persisted". (Was flag-gated by `RUN_TRACKING`; the flag has since been retired — the feature is
permanent.) See the run-tracking modules for detail.
