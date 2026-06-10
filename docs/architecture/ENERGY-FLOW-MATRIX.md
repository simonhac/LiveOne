# Energy Flow Matrix (Sankey) — daily materialization, monthly by summation

How the dashboard's energy‑flow **Sankey** stays correct over multi‑day ranges (weekly, 30‑day, calendar month).

## The problem it solves

The Sankey shows source→load energy flows (`lib/energy-flow-matrix.ts`): it integrates each load's energy per interval and allocates it across sources by their instantaneous share of generation. It needs **signed power at fine resolution**. Daily‑averaged power (`point_readings_agg_1d.avg`) cancels bidirectional flows — a battery that charges 20 kWh and discharges 20 kWh averages to ~0 kW → 0 kWh each way — so a Sankey built from `agg_1d` reports zero battery/grid energy.

Direction survives in `point_readings_agg_5m` (a single **signed** `avg` per point per interval) but is destroyed in `agg_1d`. The matrix is therefore built from **5‑minute** data, never from `agg_1d`.

## Approach

Per‑interval energy is **additive**, so a range's matrix is the element‑wise **sum** of per‑interval matrices — and therefore the sum of per‑day matrices:

1. The **engine** computes a directional energy‑flow matrix for each completed **local day** from that day's `agg_5m`, and stores it in `point_readings_flow_1d`.
2. A range read is `SUM(energy_kwh) GROUP BY (source_path, load_path)` over the days in range.
3. The **current (partial) day** is not materialized; it is integrated on the fly from `agg_5m` and added to the summed completed days, so "today so far" stays live.

The day grain matches the only unit the product cares about — **midnight‑to‑midnight local time** — and reuses the same day boundary (`dayToUnixRangeForAggregation`) that `agg_1d` uses, so the days tile perfectly.

## Directional model

Energy is **always ≥ 0**; direction is encoded by **which slot** a flow lands in. Splitting happens on signed 5‑minute values _before_ any averaging:

- **Battery**: negative = charge → `load.battery`; positive = discharge → `source.battery`.
- **Grid**: negative = export → `load.grid`; positive = import → `source.grid`.
- **Solar**: vendors expose a bare total `source.solar` and/or per‑array leaves (`source.solar.local`, `source.solar.remote`). The bare total equals the sum of the leaves, so the **leaves are used** and a synthetic `source.solar.residual = max(0, total − Σleaves)` captures any unmetered remainder (sub‑20 W dropped as noise). With no leaves, the bare total is the single solar node. (`resolveSolarSources` in `lib/aggregation/flow-series.ts`.)
- **Loads**: real load points (`load`, `load.hws`, …) plus the synthetic **`load.rest-of-house`** (remainder = master − children, or generation − charge − export − children).

Nodes are keyed by **canonical path string**, not point id — so aggregated solar and the synthetic rest‑of‑house have a stable identity, and labels/colors resolve at read time. Synthetic and aggregated nodes simply have no backing point.

## Storage

`point_readings_flow_1d` (Postgres; `lib/db/planetscale/schema.ts`):

| column                                         | notes                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `system_id`, `day`, `source_path`, `load_path` | composite primary key; `day` = `YYYY-MM-DD` system‑local          |
| `energy_kwh`                                   | always ≥ 0                                                        |
| `sample_count`                                 | # of 5‑min intervals that contributed (coverage)                  |
| `version`                                      | algorithm version — lets a backfill detect and replace stale rows |
| `created_at`, `updated_at`                     |                                                                   |

No foreign keys (consistent with the rest of the PG schema); writes are idempotent `onConflictDoUpdate` on the primary key.

## Compute (engine)

The daily cron recomputes each system/day's matrix from `agg_5m` immediately after the `agg_1d` recompute, sharing the same per‑day loop and idempotency (`lib/db/planetscale/flow-matrix-pg.ts`). The math is the **shared pure core** `computeFlowMatrix` (`lib/aggregation/flow-matrix-core.ts`) — no DB or UI imports — so the engine and the live browser path compute identical values by construction. Late or out‑of‑order `agg_5m` corrections heal on the next recompute of that day. Gated by `FLOW_MATRIX_COMPUTE_IN_PG`.

## Read (web)

`GET /api/energy-flow-matrix?systemId&start&end` returns the `EnergyFlowMatrix` for the range: summed completed days from `point_readings_flow_1d` plus the live partial day. The dashboard uses it for 30‑day, calendar‑month, and arbitrary ranges; 1D/7D are computed client‑side from 5‑minute data. Gated by `FLOW_MATRIX_SERVE_FROM_PG`.

Both gates default off, in which case behaviour is identical to the pre‑materialization path; rollback is a flag flip.

## Invariants

- Split bidirectional points **before** averaging; integrate from ≤ 5‑minute signed data, never `agg_1d.avg`.
- `range_matrix == Σ day_matrices` element‑wise (monthly = Σ daily).
- Allocate at the 5‑minute grain, then sum energy — never re‑derive allocation from coarse totals.
- One day boundary (`dayToUnixRangeForAggregation`), identical to `agg_1d`.
- `Σ(source energy) − Σ(load energy) ≥ 0` (losses are non‑negative, within a plausible efficiency band).

## Key code

- `lib/aggregation/flow-matrix-core.ts` — pure integrator (`computeFlowMatrix`).
- `lib/aggregation/flow-series.ts` — solar leaf/residual resolution and other shared series helpers.
- `lib/energy-flow-matrix.ts` — browser adapter (`calculateEnergyFlowMatrix`).
- `lib/db/planetscale/schema.ts` — `point_readings_flow_1d`.
- `lib/db/planetscale/flow-matrix-pg.ts` — engine daily recompute.
- `app/api/energy-flow-matrix/route.ts` — read endpoint.
