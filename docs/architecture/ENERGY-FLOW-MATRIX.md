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

## Logical systems

The unit a Sankey is computed over is a **logical system** (`lib/aggregation/logical-system.ts`, `resolveLogicalSystem`): the role→point mapping that has both a source and a load role. It is either a single physical system whose own points cover the roles, OR a **composite** (`vendor_type='composite'`) whose points are drawn from CHILD systems via `systems.metadata`. One resolver feeds every path — the engine recompute, the sub‑daily history compute, and the FE — so role classification isn't re‑derived independently. A composite's `flow_1d` rows are written under the composite's id with cross‑system origin collapsed into that view (a composite and its children each get their own rows — never sum both in a rollup).

## Compute (engine)

After the daily `agg_1d` pass, the cron recomputes the matrix **per logical system** from `agg_5m` (`lib/db/planetscale/flow-matrix-pg.ts`, driven by `listCompleteLogicalSystems`), reading each one's (possibly cross‑system) point refs and writing under its logical‑system id. Driving from the logical‑system registry — not the `DISTINCT system_id FROM agg_5m` physical‑system list — is what lets composites materialize at all. The math is the **shared pure core** `computeFlowMatrix` (`lib/aggregation/flow-matrix-core.ts`) — no DB or UI imports — so the engine and the live browser/history paths compute identical values by construction. Late or out‑of‑order `agg_5m` corrections heal on the next recompute of that day. Gated by `FLOW_MATRIX_COMPUTE_IN_PG`.

## Read (web)

Two serving paths, one shared computation:

- **Long‑range (30‑day / month / arbitrary)** — `GET /api/energy-flow-matrix?systemId&start&end` returns summed completed days from `point_readings_flow_1d` plus the live partial day.
- **Sub‑daily (1D/7D)** — bundled with the history payload via `GET /api/history?include=sankey`, computed on the fly from the **same signed 5‑minute rows the history read already loads** (5m and 30m both read `agg_5m`; the matrix is built before 30m bucketing, so 7D stays 5m‑accurate) — no extra query. Refused for `1d` and for filtered requests that don't cover the role set.

Both are presented through the shared `toEnergyFlowMatrix` (`lib/aggregation/flow-node-meta.ts`). Gated by `FLOW_MATRIX_SERVE_FROM_PG`; off → the dashboard computes sub‑daily client‑side and 30D shows the old client path. `FLOW_MATRIX_COMPUTE_IN_PG` (materialization) and `FLOW_MATRIX_SERVE_FROM_PG` (serving) are independent; rollback is a flag flip.

## Invariants

- Split bidirectional points **before** averaging; integrate from ≤ 5‑minute signed data, never `agg_1d.avg`.
- `range_matrix == Σ day_matrices` element‑wise (monthly = Σ daily).
- Allocate at the 5‑minute grain, then sum energy — never re‑derive allocation from coarse totals.
- One day boundary (`dayToUnixRangeForAggregation`), identical to `agg_1d`.
- `Σ(source energy) − Σ(load energy) ≥ 0` (losses are non‑negative, within a plausible efficiency band).

## Key code

- `lib/aggregation/flow-matrix-core.ts` — pure integrator (`computeFlowMatrix`).
- `lib/aggregation/flow-series.ts` — solar leaf/residual resolution and other shared series helpers.
- `lib/aggregation/logical-system.ts` — role→point resolver (`resolveLogicalSystem`, `listCompleteLogicalSystems`).
- `lib/aggregation/flow-node-meta.ts` — node label/color/order + the shared `toEnergyFlowMatrix` presenter.
- `lib/energy-flow-matrix.ts` — browser adapter (`calculateEnergyFlowMatrix`).
- `lib/history/build-flow-matrix.ts` — sub-daily compute from in-hand 5m rows (`buildFlowMatrixFromAggRows`).
- `lib/db/planetscale/schema.ts` — `point_readings_flow_1d`.
- `lib/db/planetscale/flow-matrix-pg.ts` — engine daily recompute (logical-system-driven).
- `app/api/energy-flow-matrix/route.ts` — long-range read endpoint; `app/api/history/route.ts` — sub-daily `?include=sankey`.
