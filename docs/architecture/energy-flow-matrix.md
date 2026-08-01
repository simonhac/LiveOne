# Energy Flow Matrix (Sankey) — daily materialization, monthly by summation

> **Status:** current — last verified 2026-08-01. The Storage/Compute/Read pass that the previous
> revision deferred is done: `point_readings_flow_1d` and the `FLOW_MATRIX_*` flags are gone, and
> `point_readings_flow_attr_1d` is the sole flow/Sankey matrix.

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

1. The **engine** computes a directional energy‑flow matrix for each completed **local day** from that day's `agg_5m`, and stores it in `point_readings_flow_attr_1d`.
2. A long‑range read sums the per‑day rows, grouped by `(source_path, load_path)`, over the **completed days** in range.
3. **Sub‑daily** views (≤ 1 week) don't read the daily table at all — they integrate the window live from `agg_5m`, so "today so far" stays current at that grain. The long‑range read serves **completed days only**; adding today's partial day to a 30‑day/month total is a deliberate **v1 limitation**, not yet implemented.

The day grain matches the only unit the product cares about — **midnight‑to‑midnight local time** — and reuses the same day boundary (`dayToUnixRangeForAggregation`) that `agg_1d` uses, so the days tile perfectly.

## Directional model

Energy is **always ≥ 0**; direction is encoded by **which slot** a flow lands in. Splitting happens on signed 5‑minute values _before_ any averaging:

- **Battery**: negative = charge → `load.battery`; positive = discharge → `source.battery`.
- **Grid**: negative = export → `load.grid`; positive = import → `source.grid`.
- **Solar**: vendors expose a bare total `source.solar` and/or per‑array leaves (`source.solar.local`, `source.solar.remote`). The bare total equals the sum of the leaves, so the **leaves are used** and a synthetic `source.solar.residual = max(0, total − Σleaves)` captures any unmetered remainder (sub‑20 W dropped as noise). With no leaves, the bare total is the single solar node. (`resolveSolarSources` in `lib/aggregation/flow-series.ts`.)
- **Loads**: `load` is a **hierarchy, exactly like `source.solar` above**. The master `load` is the site TOTAL and each `load.<sub>` (`load.hws`, `load.ev`, …) is a metered subset of it. So the master is a sink only when it has **no** children; with children it becomes a **budget**, and the sinks are the children plus the **complement** `load.rest-of-house` — the load no sub‑meter covers. The complement is always exactly **one** node, either synthesised (remainder = master − children, or generation − charge − export − children) or **measured**, where a vendor publishes that quantity directly (Sigenergy's `loadPower` excludes its AC charger, so it _is_ the complement); a measured complement is sized by the master register's remainder for its exact energy. `ev.charge` is **not** a sink: a charger inside the site meter participates as `load.ev`, and an `ev.charge` register is a vehicle's own view of energy already metered by that circuit or the site meter, so it decorates no node (it remains a point for cards and charts). (`buildFlowSeries` in `lib/aggregation/flow-series.ts`.)

Nodes are keyed by **canonical path string**, not point id — so aggregated solar and the synthetic rest‑of‑house have a stable identity, and labels/colors resolve at read time. Synthetic and aggregated nodes simply have no backing point.

## Storage

`point_readings_flow_attr_1d` (Postgres; `lib/db/planetscale/schema.ts`) is the **sole** daily flow
matrix. It is a strict superset of the `point_readings_flow_1d` it replaced: same `(area, day,
source_path, load_path)` grain and the same non‑negative `energy_kwh`, plus the attributed metric
legs — emissions, renewable, cost, and the `estimated` fraction — so the Sankey's energy view and the
provenance view can never disagree about an allocation. `flow_1d` was retired once nothing read it.

Two properties carried over and still hold:

- **Keyed by Area uuid, not an integer handle.** The old integer key was polymorphic (≥1,000,000 meant
  "synthetic composite"); the uuid is not.
- 🛑 **The `area_id` FK is deliberately `NO ACTION`, never `CASCADE`** — Postgres refuses to delete an
  Area that still has flow rows. That is a data‑loss firewall, and it is why no flow table has ever
  cascaded. See [data-model.md](data-model.md) §Areas.

Each (area, day)'s rows are replaced atomically — delete‑then‑insert in one transaction — so the write
is idempotent and a flow that drops below threshold between runs doesn't linger. It is NOT an upsert;
concurrent recomputes of the same day serialize on row locks, and the best‑effort wrapper swallows a
transient duplicate‑key abort, since both runs compute identical values.

## Logical systems

The unit a Sankey is computed over is a **logical system** (`lib/aggregation/logical-system.ts`,
`resolveLogicalSystem`): an **Area** with a complete role set — both a source and a load role. Its
points may come from one member device or several, resolved through the Area's members with
`area_bindings` as an override; each point carries its physical origin so cross‑device flows keep
their provenance. There is no longer a "composite system": the `composite` vendor and the
`systems.metadata` child mapping it depended on are both gone, and a multi‑device Area is the same
machinery as an area‑of‑one with more members.

One resolver feeds every path — the daily recompute, the sub‑daily history compute, and the FE — so
role classification is never re‑derived independently. `listCompleteLogicalSystems` enumerates the
flow‑eligible Areas; an Area and a member device each get their own rows, so never sum both in a
rollup.

## Compute (engine)

After the daily `agg_1d` pass, the cron recomputes the matrix **per logical system** from `agg_5m`,
driven by `listCompleteLogicalSystems` and written under the Area's uuid. Driving from the
logical‑system registry — rather than a `DISTINCT` scan of whichever devices happen to have rows — is
what lets a multi‑device Area materialize at all.

The math is the **shared pure core** `computeFlowAccounting` (`lib/aggregation/flow-matrix-core.ts`) —
no DB or UI imports — so the engine and the live browser/history paths compute identical values by
construction. The same call produces the energy leg and the metric legs together
(`lib/aggregation/flow-attribution-core.ts` re‑exports it as `computeFlowAttribution`); that is why
the two can't drift. Late or out‑of‑order `agg_5m` corrections heal on the next recompute of that day,
and a long backfill is chunked by `planFlowRecomputeBatch` (`lib/aggregation/flow-recompute-batch.ts`)
so no single invocation blows the function timeout.

There are no `FLOW_MATRIX_*` feature flags any more — materialization and serving are both
unconditional. The rollback story is a re‑run of the recompute, not a flag flip.

## Read (web)

**One endpoint, `GET /api/history?include=sankey`, for every window** — the former standalone
`/api/energy-flow-matrix` route was retired once the history endpoint grew a 1d branch (the 30D card and
the ev-provenance card both moved onto it):

- **1d (30‑day / month / arbitrary)** — reads summed **completed days** from
  `point_readings_flow_attr_1d` via `readAttributedDailyMatrices`
  (`lib/aggregation/flow-attr-read.ts`), serving energy plus the emissions/renewable/cost/estimated
  legs as `attributedFlow`. Today's partial day is not included — the deliberate v1 limitation above.
  The field carries an `attributedFlowOmittedReason` when there is nothing to serve (not‑yet‑materialized,
  or not a logical system).
- **Sub‑daily (1D/7D)** — computed on the fly from the **same signed 5‑minute rows the history read
  already loads** (5m and 30m both read `agg_5m`; the matrix is built before 30m bucketing, so 7D stays
  5m‑accurate) — no extra query for the energy leg, served as `flowMatrix`. The attributed leg
  additionally runs the battery-provenance fold on the fly
  (`lib/history/build-attributed-flow-matrix.ts`, DB-bound, its own bounded query) and degrades
  gracefully (`attributedFlowOmittedReason`) on failure — the energy‑only Sankey never blocks on it.
  Refused for filtered requests that don't cover the role set.

The energy leg is presented through the shared `toEnergyFlowMatrix` (`lib/aggregation/flow-node-meta.ts`).

Note the asymmetry, because it explains the performance shape: the 1d path serves a **stored**
rollup in tens of ms, while the sub‑daily path recomputes everything per request — which is why
`/api/history` is the server tail on a dashboard load. See
[`../plans/live-dashboard-roadmap.md`](../plans/live-dashboard-roadmap.md) §1.3.

## Invariants

- Split bidirectional points **before** averaging; integrate from ≤ 5‑minute signed data, never `agg_1d.avg`.
- `range_matrix == Σ day_matrices` element‑wise (monthly = Σ daily).
- Allocate at the 5‑minute grain, then sum energy — never re‑derive allocation from coarse totals.
- One day boundary (`dayToUnixRangeForAggregation`), identical to `agg_1d`.
- `Σ(source energy) − Σ(load energy) ≥ 0` (losses are non‑negative, within a plausible efficiency band).
- A master `load` and its children are **never both** sinks: sinks are the children plus the one complement. Emitting both double‑counts the metered subsets against the total.

## Key code

- `lib/aggregation/flow-matrix-core.ts` — the pure integrator (`computeFlowAccounting`); energy and metric legs in one pass.
- `lib/aggregation/flow-attribution-core.ts` — the metric-leg view of that same core.
- `lib/aggregation/flow-series.ts` — solar leaf/residual resolution, rest-of-house, and other shared series helpers.
- `lib/aggregation/flow-series-pg.ts` — loads the signed 5m series for a logical system (`loadFlowSeriesFromAgg5m`).
- `lib/aggregation/logical-system.ts` — role→point resolver (`resolveLogicalSystem`, `listCompleteLogicalSystems`).
- `lib/aggregation/flow-node-meta.ts` — node label/color/order + the shared `toEnergyFlowMatrix` presenter.
- `lib/aggregation/flow-recompute-batch.ts` — bounds a backward recompute into timeout-safe batches.
- `lib/aggregation/flow-attr-read.ts` — the 1d read (`readAttributedDailyMatrices`).
- `lib/battery-provenance/recompute.ts`, `lib/db/planetscale/battery-provenance-pg.ts` — the daily writer of `point_readings_flow_attr_1d`.
- `lib/history/build-flow-matrix.ts` — sub-daily energy-only compute from in-hand 5m rows (`buildFlowMatrixFromAggRows`).
- `lib/history/build-attributed-flow-matrix.ts` — sub-daily ATTRIBUTED compute (energy + metric legs, on the fly).
- `lib/energy-flow-matrix.ts` — browser adapter (`calculateEnergyFlowMatrix`).
- `lib/db/planetscale/schema.ts` — `point_readings_flow_attr_1d`.
- `app/api/history/route.ts` — the sole serving route, `?include=sankey` (1d + sub-daily).
