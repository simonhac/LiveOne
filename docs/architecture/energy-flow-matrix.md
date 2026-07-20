# Energy Flow Matrix (Sankey) — daily materialization, monthly by summation

How the dashboard's energy‑flow **Sankey** stays correct over multi‑day ranges (weekly, 30‑day, calendar month).

> **See also** [battery-provenance.md](battery-provenance.md): the Sankey is the ENERGY leg of a unified
> `computeFlowAccounting`; provenance adds the METRIC legs (emissions/renewable/cost) on the same allocation,
> materialized to the superset `point_readings_flow_attr_1d` and served alongside the energy leg (as
> `attributedFlow`) by `GET /api/history?include=sankey` — the per-node hover/tap tooltips in the FE
> Sankey (`components/EnergyFlowSankey.tsx` / `NodeTooltip.tsx`) reduce it client-side via
> `reduceLoadProvenance`/`reduceSourceProvenance`.

## The problem it solves

The Sankey shows source→load energy flows (`lib/energy-flow-matrix.ts`): it integrates each load's energy per interval and allocates it across sources by their instantaneous share of generation. It needs **signed power at fine resolution**. Daily‑averaged power (`point_readings_agg_1d.avg`) cancels bidirectional flows — a battery that charges 20 kWh and discharges 20 kWh averages to ~0 kW → 0 kWh each way — so a Sankey built from `agg_1d` reports zero battery/grid energy.

Direction survives in `point_readings_agg_5m` (a single **signed** `avg` per point per interval) but is destroyed in `agg_1d`. The matrix is therefore built from **5‑minute** data, never from `agg_1d`.

## Approach

Per‑interval energy is **additive**, so a range's matrix is the element‑wise **sum** of per‑interval matrices — and therefore the sum of per‑day matrices:

1. The **engine** computes a directional energy‑flow matrix for each completed **local day** from that day's `agg_5m`, and stores it in `point_readings_flow_1d`.
2. A long‑range read is `SUM(energy_kwh) GROUP BY (source_path, load_path)` over the **completed days** in range.
3. **Sub‑daily** views (≤ 1 week) don't read `flow_1d` at all — they integrate the window live from `agg_5m`, so "today so far" stays current at that grain. The long‑range read serves **completed days only**; adding today's partial day to a 30‑day/month total is a deliberate **v1 limitation**, not yet implemented.

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

No foreign keys (consistent with the rest of the PG schema). Each (system, day)'s rows are replaced atomically — delete-then-insert in one transaction — so the write is idempotent and a flow that drops below threshold between runs doesn't linger. (It is NOT an upsert; concurrent recomputes of the same day serialize on row locks, and the best-effort wrapper swallows a transient duplicate-key abort since both runs compute identical values.)

## Logical systems

The unit a Sankey is computed over is a **logical system** (`lib/aggregation/logical-system.ts`, `resolveLogicalSystem`): the role→point mapping that has both a source and a load role. It is either a single physical system whose own points cover the roles, OR a **composite** (`vendor_type='composite'`) whose points are drawn from CHILD systems via `systems.metadata`. One resolver feeds every path — the engine recompute, the sub‑daily history compute, and the FE — so role classification isn't re‑derived independently. A composite's `flow_1d` rows are written under the composite's id with cross‑system origin collapsed into that view (a composite and its children each get their own rows — never sum both in a rollup).

## Compute (engine)

After the daily `agg_1d` pass, the cron recomputes the matrix **per logical system** from `agg_5m` (`lib/db/planetscale/flow-matrix-pg.ts`, driven by `listCompleteLogicalSystems`), reading each one's (possibly cross‑system) point refs and writing under its logical‑system id. Driving from the logical‑system registry — not the `DISTINCT system_id FROM agg_5m` physical‑system list — is what lets composites materialize at all. The math is the **shared pure core** `computeFlowMatrix` (`lib/aggregation/flow-matrix-core.ts`) — no DB or UI imports — so the engine and the live browser/history paths compute identical values by construction. Late or out‑of‑order `agg_5m` corrections heal on the next recompute of that day. Gated by `FLOW_MATRIX_COMPUTE_IN_PG`.

## Read (web)

**One endpoint, `GET /api/history?include=sankey`, for every window** — the former standalone
`/api/energy-flow-matrix` route was retired once the history endpoint grew a 1d branch (the 30D card and
the ev-provenance card both moved onto it):

- **1d (30‑day / month / arbitrary)** — reads summed **completed days** from `point_readings_flow_1d`
  (`flowMatrix`, energy only — today's partial day is not included, a deliberate v1 limitation) and, in
  parallel, from `point_readings_flow_attr_1d` (`attributedFlow`, energy + emissions/renewable/cost/
  estimated legs, via `lib/aggregation/flow-attr-read.ts`'s `readAttributedDailyMatrices`). Either field
  carries a `reason`/`attributedFlowOmittedReason` when there's nothing to serve (e.g. not‑yet‑materialized
  or a non‑logical system).
- **Sub‑daily (1D/7D)** — computed on the fly from the **same signed 5‑minute rows the history read
  already loads** (5m and 30m both read `agg_5m`; the matrix is built before 30m bucketing, so 7D stays
  5m‑accurate) — no extra query for the energy leg. The attributed leg additionally runs the battery-
  provenance fold on the fly (`lib/history/build-attributed-flow-matrix.ts`, DB-bound, its own bounded
  query) and degrades gracefully (`attributedFlowOmittedReason`) on failure — the energy‑only Sankey
  never blocks on it. Refused for filtered requests that don't cover the role set.

Both energy legs are presented through the shared `toEnergyFlowMatrix` (`lib/aggregation/flow-node-meta.ts`).
Gated by `FLOW_MATRIX_SERVE_FROM_PG`; off → the dashboard computes sub‑daily client‑side. `FLOW_MATRIX_COMPUTE_IN_PG`
(materialization) and `FLOW_MATRIX_SERVE_FROM_PG` (serving) are independent; rollback is a flag flip.

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
- `lib/history/build-flow-matrix.ts` — sub-daily energy-only compute from in-hand 5m rows (`buildFlowMatrixFromAggRows`).
- `lib/history/build-attributed-flow-matrix.ts` — sub-daily ATTRIBUTED compute (energy + metric legs, on the fly).
- `lib/aggregation/flow-attr-read.ts` — 1d ATTRIBUTED read (`readAttributedDailyMatrices`, from `point_readings_flow_attr_1d`).
- `lib/db/planetscale/schema.ts` — `point_readings_flow_1d`, `point_readings_flow_attr_1d`.
- `lib/db/planetscale/flow-matrix-pg.ts` — engine daily recompute (logical-system-driven).
- `app/api/history/route.ts` — the sole serving route, `?include=sankey` (1d + sub-daily, energy + attributed).
