# Sigenergy interval-energy backfill cadence

> **Status: PROPOSED (raised 2026-07-27).** Not started. Small, self-contained, unrelated to config-v4 —
> pick up in its own workspace. Diagnosis below is complete and evidence-backed; the fix is not written.

## The symptom

The Kew dashboard's Kutis section shows Solar and Load daily-energy bars stopping on **14 Jul 2026**,
while the Battery SoC line and the live tiles (Solar 0.0 kW / Load 0.4 kW / Battery 21.7%) keep updating.
Reported as "not showing load and generation data since 14 July".

## It is not data loss, and not the config-v4 cutover

Established on prod, 2026-07-27 (read-only role):

- The Kutis **power** points (`point_rid` 95–100) are healthy — raw readings current to the minute, `agg_5m`
  current, `agg_1d` through the previous local day.
- Only the six **energy** points (101–106: Solar, Load, Import, Export, Battery Charge, Battery Discharge)
  stop, at `agg_5m.interval_end = 2026-07-14 14:00Z` — exactly local midnight (AEST = UTC+10).
- Those energy points have **no raw `point_readings` at all, and never did**: `point_readings_old` (the
  pre-cutover copy) also holds zero rows for them. So the cutover destroyed nothing, and the gap begins
  11 days *before* the cutover. Peer devices (Kinkora Fronius, Kinkora Mondo) have energy points with raw
  readings, so "no raw" is specific to how Sigenergy energy is produced — see below.
- Polling is fine throughout: 285–302 sessions/day across 14 Jul, 288 in the last 24 h. The archived
  vendor payloads are byte-identical in shape either side of the cutoff and still carry `pvDayNrg` today.
- **The Kinkora and Daylesford dashboards are complete at every interval and timespan** (confirmed by
  Simon, 2026-07-27). That is the control case, and it corroborates rather than complicates the
  diagnosis: those devices' energy points arrive on the **live poll** path — Kinkora Fronius/Mondo energy
  points carry raw `point_readings` current to the minute — so they never depend on the backfill.
  **Sigenergy is the only vendor whose interval energy has no live-poll path**, which is exactly why it is
  the only one that visibly lags. A fleet-wide fault would have hit all three.

## Root cause — designed lag, not a fault

Sigenergy interval energy is **not** emitted by the live poll. `SigenergyAdapter` emits PV/battery/grid/
load/EV power + SoC only. Interval energy is derived separately by `backfillEnergyRange`
(`lib/vendors/sigenergy/statistics.ts`), which differences the daily-statistics cumulative counters and
writes 5-minute energy through the normal publish → receiver path. That is why these points legitimately
have no raw readings.

Two things can invoke that backfill:

| Path | Scheduled? | Window |
| --- | --- | --- |
| `/api/cron/sigenergy-backfill` | **NO — absent from `vercel.json`** | `DEFAULT_DAYS = 7`, max 31 |
| `/api/cron/repair-coverage` (weekly, `30 15 * * 1`) | yes | `lookbackDays: 90`, **`graceDays: 7`** |

So the *only* thing filling these points is the weekly safety net, and its 7-day grace means it will not
touch anything newer than a week. `agg_5m.created_at` proves it exactly:

| Local day | Written at |
| --- | --- |
| 6–12 Jul | 2026-07-12 14:04 (manual backfill; matches that day's ADMIN sessions) |
| 13 Jul + partial 14 Jul | **2026-07-20 15:30:48** — the weekly cron slot, window ending 20−7 = 13 Jul |

The cron is working correctly. On Mon 20 Jul its window ended at 13 Jul, which is precisely where the data
stops. The Mon 27 Jul run (window ending 20 Jul) should fill 14–20 Jul unaided.

**The defect is cadence, not correctness:** Sigenergy energy is structurally 7–14 days stale, and a
backstop is doing a primary path's job.

## Proposed fix

1. **Schedule `/api/cron/sigenergy-backfill` daily** in `vercel.json` — shortly after station-local
   midnight (station-local, not UTC; the runner already uses `bucketOffsetMin` = `timezoneOffsetMin ?? 600`).
   Its 7-day default window makes each run self-healing over the last week, so a single missed run costs
   nothing. This keeps the series current to ~yesterday and leaves `repair-coverage` as the backstop it
   was designed to be.
2. **Revisit `graceDays: 7` for Sigenergy specifically.** The grace exists for Amber's late settlement
   (see [[amber-usage-90day-window]] reasoning in `coverage-repair-framework`). Sigenergy energy is
   *differenced cumulative counters*, which plausibly settle immediately — if so, the grace could be
   per-vendor and much shorter, and the weekly repair would then also close gaps promptly. **Verify against
   the vendor before changing**: re-fetch a recent day twice, days apart, and compare — if the values are
   identical, the grace is unnecessary for this vendor.
3. Consider whether `/api/cron/openelectricity-backfill` has the same unscheduled-primary-path problem.

## Verification

- After the daily cron lands: `max(interval_end)` for `point_rid` 101–106 should track to within ~a day,
  and `agg_5m.created_at` should show one write per day rather than weekly clumps.
- The Kew dashboard's Solar/Load bars should extend to yesterday.
- Confirm no double-write/duplication: the backfill goes through the idempotent single-writer receiver, so
  overlapping 7-day windows must upsert, not duplicate — assert `agg_5m` row counts per day stay at 288.

## Watch-outs

- `DEFAULT_DAYS = 7` / `MAX_RANGE_DAYS = 31` bound the route; a daily run must not be widened casually —
  each day costs vendor API calls, and the route's `maxDuration` is 300 s because it also rebuilds `agg_1d`
  for the range.
- The route calls `SystemsManager`, which **config-v4 Phase 12 deletes**. If Phase 12 lands first, this
  route needs porting to `DeviceRegistry` — coordinate, or do this fix first (it is much smaller).
