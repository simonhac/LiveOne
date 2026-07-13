# Battery provenance — metric-attributed energy flows

> **Status:** engine + data core LIVE on `main` (PR #160), validated on `liveone-dev`. A second wave —
> reproducible learned η (a persisted `round-trip-efficiency` point), off-grid **generator** support, and the
> reconcile cadence/watermark + reserve-floor caching — is built + dev-validated, pending deploy. Prod
> (`sydney`) cutover: see [Operations](#operations). Companion to
> [energy-flow-matrix.md](energy-flow-matrix.md): provenance is the **metric legs** of that same flow.

## What it does

Attach three **intensive metrics** onto energy flows and trace them through the battery:

- **emissions intensity** — OpenElectricity `grid.emissionsIntensity/intensity` (tCO₂e/MWh ≡ gCO₂/kWh), on the NEM-region system, 5-min.
- **renewable proportion** — OpenElectricity `grid.renewables/proportion` (%), same region system, 5-min.
- **cost / price** — Amber `bidi.grid.import/rate` (c/kWh), on the household's own system, 30-min step.

The battery is a **weighted-average inventory**: as it charges it accumulates the blended
emissions/renewable/cost of whatever fed it (solar = clean/free; grid import = the grid intensities at that
5-minute interval); as it discharges it vends the current blend; when it hits a **reserve floor** the
accumulators reset. So a load served by the battery inherits the battery's blend, and the user can ask
**"what did it cost / how green / what emissions to charge the EV over July"** — for the EV specifically, or
any load — as one query.

## One flow accounting; provenance is its metric legs

The Sankey energy matrix and provenance are **the same allocation**. `computeFlowAccounting`
(`lib/aggregation/flow-matrix-core.ts`) is the single allocation loop: it integrates each load's energy and
splits it across sources by generation share, and — when given per-source **intensity** series — decorates
every contribution with that source's emissions/renewable/cost. `computeFlowMatrix` is the **energy
projection** of it (the Sankey), so the metric legs can never drift from energy (guarded by the existing
flow-matrix byte-identical tests). Per source: solar = {0 gCO₂, 100 % renewable, `solarCost`}; grid = the
OE/Amber series (or, off-grid, a configured **generator** intensity — see [Off-grid + generator](#off-grid-sites--generator));
**battery = the provenance fold's per-interval blend** (below); other = unknown.

## The battery model (the fold)

`lib/battery-provenance/fold.ts` — a pure, deterministic, DB-free fold (the analogue of
`lib/run-tracking/detect.ts`). The battery is a **reset-relative inventory** `E` = (Σ deliverable charge −
Σ discharge) since the last reset, floored at 0, with parallel blended stocks `Qc` (gCO₂), `Qr` (renewable
kWh), `Qm` (cost). Intensities are always derived (`Qc/E`, …), never stored.

- **Charge mixing** — weighted-average accumulate at each source's intensity (solar contributes 0 g / 100 %
  renewable / `solarCost`; grid at the interval's OE/Amber values). The solar-vs-grid split of a charge
  interval comes from the flow allocation (`lib/battery-provenance/battery-flows.ts`), so it stays
  consistent with `flow_1d`'s `load.battery` cells.
- **Discharge** — draws down proportionally, so the vended intensity is unchanged by discharge; the vended
  blend is written to the 3 derived points AND fed to the attribution as `source.battery`'s intensity.
- **Reset** — at the reserve floor (a bottom-out): `empty` (E → ≈0, SoC-free — primary), `soc-floor`
  (SoC ≤ `reserveFloorPct`, drift correction), or `backstop` (a segment ran too long without a reset).
  Each reset segments the history → bounds how far a late-data repair must re-fold.

### Why these choices

- **No capacity knob.** `E` is integrated from charge/discharge _power_, never `SoC × capacity` — so a
  mid-life battery-capacity change is absorbed automatically (observed: the inferred capacity stepping from
  ~20 kWh to ~40 kWh when the site's battery doubled, with zero reconfiguration).
- **SoC is optional.** It is used _only_ to detect the reserve floor, never to size `E`. With no SoC the
  fold relies on full-discharge auto-resets + the drift backstop; ablation shows SoC changes the EV number
  by <10 %. (The site's Fronius SoC had a ~7-month gap; the model ran through it.)
- **Round-trip efficiency (η).** A battery returns less than you put in. With η < 1, charge adds `η·charge`
  to `E` but the FULL footprint to `Q` — so delivered energy carries the whole footprint (loss priced into
  the loads it serves) and `E` reaches 0 at the physical bottom-out. The `(1−η)` overhead is tallied in the
  **loss buckets** (kWh / $ / gCO₂) as a decomposition. η is a per-interval **input** to the fold — learned
  once in the shell and read back, never re-learned per window (see
  [Learned η](#learned-η-learn-in-shell--read-in-fold)). **Renewable is the exception**: it is a bounded
  _proportion_ (loss-invariant), so renewable content scales with `E` by η — keeping `Qr/E ∈ [0,1]`; only the
  unbounded intensities inflate by 1/η.
- **Conservation invariant** (property-tested): for every metric, `Σ charged = Σ vended to loads +
Σ unattributed + stored`. Holds to 0.00 % over 81k real intervals.

## Learned η (learn-in-shell / read-in-fold)

η is learned from raw Σout/Σin **once, over a stable window — never re-learned per recompute window**. That
is what keeps the blend **reproducible**: if the fold re-learned η from its own (bounded) window, the same
day would get a different η depending on which cron last touched it, breaking `fold(complete) ==
fold(partial) + heal` (repair-convergence). So the learning is externalised:

- `lib/battery-provenance/eta.ts` — a pure **causal daily-EWMA** estimator (`learnEwmaEta`): per local day
  `η_d = Σdischarge_d / Σcharge_d` (clamped to a physical band, thin days ignored), smoothed with a causal
  EWMA. Fold-independent (raw throughput → η → fold; no circularity).
- The **daily heal** learns η from a FIXED anchor with a FIXED datasheet seed (`learnAndPersistEta`) and
  persists it as a **4th derived helper point** `bidi.battery/round-trip-efficiency` (per-local-day step;
  stored as %; `agg_5m` + KV). Because the anchor + seed are fixed, η(day D) is byte-identical on every run
  and only the newest day updates.
- The **loader** reads that point (forward-filled ≤ 48 h) into `inputs.etaSeries`; `computeBatteryProvenance`
  stamps it per interval (`FoldInterval.efficiency`) and does NOT re-learn. Precedence: a numeric
  `config.efficiency` (tests / manual pin) → persisted `etaSeries` (canonical) → an in-window learn (bootstrap
  only, before the shell has run + the offline harness).
- The persisted point doubles as the **degradation-trend** diagnostic (slow decline = ageing; a step = a
  hardware/capacity change). Kinkora learns η ≈ 0.88–0.92.

## Off-grid sites + generator

An off-grid site has no grid but a **generator**, whose electrical output the inverter (the micro-grid
master) measures on its AC-input port — carried as `bidi.grid`, so it flows as `source.grid` through the
allocation (the point's `i` transform flips the inverter's raw sign so generator supply reads as positive
import). Its intensity is **config, not telemetry** — most off-grid sites have no queryable engine
controller, and the generator's _power_ isn't separately metered. So the battery system carries
`config.batteryProvenance.generatorSource = { emissionsIntensity, pricePerKwh, renewableFraction }`, and the
loader — for an area with **no NEM region** — feeds those constants into the grid intensity series. The fold
then prices generator charge and direct use exactly like grid; **no fold change**. Opt-in: absent config →
generator energy stays `estimated` (no regression).

## Inputs, tolerance & confidence (`estimatedKwh`)

Inputs arrive from several devices asynchronously (OE ~5-min with small lag; Amber 30-min, `estimated`→
`billable`; battery power/soc from Fronius/Mondo, can gap). The engine is **tolerant + self-healing**:

- Best-effort estimators per missing input: carry-forward last OE within a segment; hold Amber's 30-min
  step; integrate power when energy is missing; **freeze** (don't reset) the accumulator on a battery
  blackout and replay on catch-up.
- **`estimatedKwh` is the confidence denominator** — energy whose attribution used an _estimated or missing_
  input (Amber still `estimated`, a forward-filled OE reading, a null, or battery energy inheriting a taint;
  provenance is _sticky within a cycle_). Surfaced as `pctEstimated = 100·Σestimated_kwh / Σenergy_kwh`.
- **Repair** = idempotent bounded recompute: when late/revised data lands (via the normal receiver upsert),
  the trailing reconcile / daily heal re-fold the affected window and `estimated → good` upgrades for free.
  Anything unresolved past a cutoff is finalised-but-flagged (`finalized_at`), never silently promoted.

## The "helper" device — where the blend lives

The blend is **Area-derived** (it depends on the Area's whole solar/grid/battery mix), so it must not be
shoehorned onto a physical child device. It lives on a **HELPER** — a derived, non-physical device that
lives in an Area and owns the Area's computed points (the Home-Assistant "derived device in an area"
pattern; see [home-assistant-comparison.md](home-assistant-comparison.md)):

- A real `systems` row, `vendor_type = 'helper'`, **owned by the Area's owner** (the blend is private
  household data — NOT ownerless), `status = 'active'`, never polled (a no-op push adapter,
  `lib/vendors/helper/adapter.ts`, so the minutely poll loop skips it). Created lazily + idempotently by
  `ensureHelperDevice(areaId)` (`lib/areas/helper.ts`), added as an `area_devices` member.
- It owns the 3 derived **blend points** (`bidi.battery/carbon-intensity` gCO₂/kWh, `/renewable-fraction` %,
  `/price` c/kWh) **plus** `bidi.battery/round-trip-efficiency` (η — a device parameter, not a vended blend;
  see [Learned η](#learned-η-learn-in-shell--read-in-fold)) — ordinary `point_info` rows (the HWS/run-tracking
  derived-point pattern: written to their own `agg_5m` + KV latest; the 5m aggregator's `hasCurrent` guard
  skips them). They are **bound into the Area** (`area_bindings`, under `role='battery'`) so they fan out to
  the Area's KV latest and appear in its resolved point set — INERT to the compute/Sankey paths (the loader
  reads only power/soc/rate/energy + η explicitly; the flow resolver is power-only), so there is no feedback
  loop. **No schema change** for the helper.

## Storage

- **Live blend** — the 3 derived points on the helper (`agg_5m` + KV latest). Serve on the Area dashboard
  via the generic point stack.
- **Attribution rollup** — `point_readings_flow_attr_1d` (`lib/db/planetscale/schema.ts`; migration
  `0023`). Keyed exactly like `point_readings_flow_1d` `(area_id, day, source_path, load_path)` and carrying
  **energy too**, plus `emissions_g` / `renewable_kwh` / `cost_c` (nullable — null = intensity unknown),
  `estimated_kwh`, `finalized_at`. So `flow_1d` is a strict **subset** of this — the design intent is a
  later cutover (repoint the Sankey read, drop `flow_1d`).

## Compute pipeline

The engine is **two shared functions** used identically by the prod driver and the offline harness (they
differ only at the edges: which window, and write-vs-print):

1. `loadProvenanceInputs(handle, window)` (`lib/battery-provenance/load.ts`) — resolve curated points via
   `area_bindings` (dedupes a site that double-measures on two devices), read `agg_5m`, resample. Battery
   charge/discharge prefer an **energy register** (exact interval energy) over trapezoidal power when the
   Area binds one.
2. `computeBatteryProvenance(inputs, config)` (`lib/battery-provenance/compute.ts`) — pure: fold → build
   per-source intensities → `computeFlowAccounting`.

- **Prod driver** — `lib/db/planetscale/battery-provenance-pg.ts`: load + compute + WRITE the blend
  `agg_5m` + KV, and (on the daily/range pass, `writeRollup`) the per-day rollup — the same accounting
  sliced per local day. The load window is extended back by `WARMUP_MS` (7 d) so the fold anchors at a
  reset before the target window; only the target window's rows are written (HWS-style warm-up).
- **Orchestration** — `lib/battery-provenance/recompute.ts`: `listBatteryProvenanceHandles` (Areas with a
  bound battery) + `reconcileTrailingWindow` (blend only) + `learnEtaForAllHandles` + `recomputeRange` (daily
  heal / backfill, writes the rollup). The minutely cron (`app/api/cron/minutely`) runs the reconcile **once
  per 5-min bucket** (inputs are 5-min-native, so a minutely re-fold is 5× waste) and a **watermark gate**
  skips a handle whose blend output has caught up to its battery input (idle / dead feed → 2 `MAX` reads, not
  a ~7.5-day re-fold). The **daily heal** (`lib/aggregation/daily-points.ts`, runs LAST — it reads the
  `agg_5m` the passes above materialise) learns+persists η FIRST, then recomputes blend + rollup so it reads
  the fresh η. Best-effort throughout.
- **Harness** — `scripts/replay-battery-provenance.ts`: read-only/dry-run over the dev mirror; loads once,
  sweeps configs (`--eta`, `--floor`, `--solar`, `--no-soc`); prints an inspector panel (blend series, per-
  load attribution, RTE, capacity, resets, loss buckets, a conservation self-audit). A pre-prod gate.

## Serving

`GET /api/energy-flow-matrix?systemId=&start=&end=&source=legacy|modern`
(`app/api/energy-flow-matrix/route.ts`):

- `source=legacy` (default) → `flow_1d`, energy only — today's Sankey, unchanged.
- `source=modern` → `flow_attr_1d`, the **same raw per-day per-edge** matrices PLUS the metric legs
  (emissions/renewable/cost/estimated), all additive over days. The client draws the Sankey from the energy
  slice and derives the per-load **period summary** ("EV: $1.78, 98 % renewable, 29 g/kWh") from the same
  rows — no second fetch, no separate endpoint. The `source` param is the eventual `flow_1d → flow_attr_1d`
  cutover switch.

## Invariants

- Provenance energy is **byte-identical** to `computeFlowMatrix` (the metric legs never perturb energy).
- Per metric: `Σ charged = Σ vended + Σ unattributed + stored` (fold conservation, exact).
- Renewable is a bounded `[0,1]` proportion (loss-invariant); only emissions/price inflate by 1/η.
- `E` is power-integrated, never capacity-derived → capacity changes need no config.
- Averages use **filtered denominators** (energy whose intensity was known) so unknown edges never bias
  them; `estimatedKwh` carries the confidence and never presents an estimate as fact.
- The helper is **owned by the Area owner** (private data, access-controlled like the real devices).

## Config knobs

`ProvenanceConfig` (`lib/battery-provenance/types.ts`): `reserveFloorPct` (default = a long-window ~2nd-
percentile of SoC, robust to non-cycling — computed once and **KV-cached ~25 h**, so the 90-day SoC read is
off the hot path and stable within a day), `efficiency` (a number pin; otherwise η is the persisted
`round-trip-efficiency` series, above), `solarValuation` (`"zero"` out-of-pocket, or `"opportunity"` =
forgone feed-in floored at `max(0, feed-in)`), `maxSegmentIntervals` (drift backstop), `reanchorEpsKwh`. The
off-grid `generatorSource` triple lives on the battery system's `config.batteryProvenance` (above).

## Operations

- **Backfill** — `scripts/backfill-battery-provenance.ts` (dry-run default) runs `recomputeRange` over full
  history; idempotent. Re-run when recovered upstream data (e.g. an Amber gap) lands.
- **Prod cutover** (pending): apply migration `0023` to `sydney` **as the `postgres` role** (table-ownership
  trap) **BEFORE** the dependent code deploys; then the crons auto-create the helper devices + blend +
  rollup, or run the backfill against `sydney` to populate history immediately. See PR #160's runbook and
  [migrations.md](migrations.md).

## Not yet (follow-ups)

- Bespoke FE **blend mini-card** + **EV-period card** (the live blend already renders via the generic
  device-metrics card; the period report is a client-side reduction of the `source=modern` payload).
- `monitor-observations` alerts (high estimated-fraction / stalled watermark / runaway segment).
- The `flow_1d → flow_attr_1d` **cutover** (flip the `source` default to `modern`, drop `flow_1d`).
- Sankey **relabel** `source.grid` → "Generator" for off-grid areas (the attribution is already correct).

## Key code

- Pure core: `lib/battery-provenance/fold.ts`, `battery-flows.ts`, `eta.ts` (η estimator);
  `lib/aggregation/flow-matrix-core.ts` (`computeFlowAccounting`).
- Shared engine: `lib/battery-provenance/{load,compute,types,recompute}.ts`.
- Helper device: `lib/areas/helper.ts`, `lib/vendors/helper/adapter.ts`,
  `lib/battery-provenance/register.ts` (blend points + Area bindings).
- Prod driver: `lib/db/planetscale/battery-provenance-pg.ts`; rollup table + migration `0023` in
  `lib/db/planetscale/schema.ts` / `drizzle-planetscale/`.
- Serving: `app/api/energy-flow-matrix/route.ts` (`source=modern`), `lib/aggregation/flow-node-meta.ts`.
- Harness / ops: `scripts/replay-battery-provenance.ts`, `scripts/backfill-battery-provenance.ts`.
