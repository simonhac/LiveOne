# Battery energy provenance — metric-attributed energy flows

> **Status:** engine + data core LIVE on `main` (PR #160), validated on `liveone-dev`. A second wave —
> reproducible learned params (persisted per-day in `battery_provenance_daily`), off-grid **generator** support, and the
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
  [The learn](#the-learn-learn-in-shell--read-in-fold--battery_provenance_daily)). **Renewable is the exception**: it is a bounded
  _proportion_ (loss-invariant), so renewable content scales with `E` by η — keeping `Qr/E ∈ [0,1]`; only the
  unbounded intensities inflate by 1/η.
- **Conservation invariant** (property-tested): for every metric, `Σ charged = Σ vended to loads +
Σ unattributed + stored`. Holds to 0.00 % over 81k real intervals.

## The learn (learn-in-shell / read-in-fold) + `battery_provenance_daily`

All four learned params — **η** (round-trip), **C** (usable capacity), **η_c + idle** (the three-term loss
model) — are learned **once, over a stable window (fixed anchor → now) — never re-learned per recompute
window**. That is what keeps the blend **reproducible**: if the fold re-learned them from its own
(bounded) window, the same day would get different params depending on which cron last touched it,
breaking `fold(complete) == fold(partial) + heal` (repair-convergence).

The estimators are pure + causal (`eta.ts` / `capacity.ts` — daily EWMAs; `losses.ts` — an
expanding-window least-squares carrying 5 running sums; the pair applied to day D is learned from days
< D only), and they consume only **per-local-day reductions** of the raw registers. So the learn is
**incremental**, built on one table:

- **`battery_provenance_daily`** (migration `0024`) — ONE row per (battery Area, local day), the single
  canonical home for all daily battery-provenance state: the **learn inputs** (per-day Σcharge/Σdischarge,
  SoC first/last/samples, the rail-gated capacity pair sums, the recal flag — computed once from `agg_5m`
  by `daily.ts#reduceThroughputToDays`, with carry columns making each row a byte-exact resumable seam),
  the **learned params** (η / C / η_c / idle applied-that-day, natural units — ratios, not %), and the
  **fold checkpoint** (`fold_state`, next section).
- `learnAllForHandle` (`lib/db/planetscale/battery-provenance-daily-pg.ts`) is THE learn (η → C → losses
  ordering structurally enforced): incrementally maintain the input rows (append new days + re-reduce a
  trailing 3 days + re-reduce from the earliest `agg_1d`-probe mismatch — late-data invalidation), run
  the fits over the ~330 cached rows (microseconds), persist the params. A full-history activation /
  backfill / reduce-version bump forces a from-scratch rebuild (ONE bounded `loadBatteryThroughput`
  read — this is what keeps the recompute-provenance route's first batch inside its `maxDuration`).
- The **loader** reads the param columns (each day's value anchored at the day's first `interval_end`,
  forward-filled ≤ 48 h, with a 48 h lead-in) into `inputs.etaSeries` / `capacitySeries` /
  `chargeEfficiencySeries` / `idleLossKwhPerDaySeries`; `computeBatteryProvenance` stamps them per
  interval and does NOT re-learn. Precedence: a numeric `config.efficiency` (tests / manual pin) →
  persisted series (canonical) → an in-window learn (bootstrap only + the offline harness).
- The per-day param columns double as the **degradation-trend** diagnostic (slow decline = ageing; a
  step = a hardware/capacity change). Kinkora learns η ≈ 0.88–0.92.
- History: the params were previously four helper POINTS (`bidi.battery/round-trip-efficiency`,
  `/usable-capacity`, `/charge-efficiency`, `/idle-loss`, ordinals 110-113, η/η_c stored ×100). The
  legacy points/bindings/step-rows are deleted by `scripts/delete-battery-param-points.ts` — run ONLY
  after `scripts/verify-daily-learn-equivalence.ts` passes against the same DB (the step rows are the
  equivalence baseline).

## Off-grid sites + generator

An off-grid site has no grid but a **generator**, whose electrical output the inverter (the micro-grid
master) measures on its AC-input port — carried as `bidi.grid`, so it flows as `source.grid` through the
allocation (the point's `i` transform flips the inverter's raw sign so generator supply reads as positive
import). Its intensity is **config, not telemetry** — most off-grid sites have no queryable engine
controller, and the generator's _power_ isn't separately metered. So the battery system carries
`config.batteryProvenance.generatorSource = { emissionsIntensity, pricePerKwh, renewableFraction }`, and the
loader, whenever this config is present, feeds those constants into the grid intensity series — **overriding
any resolved NEM region** (setting `generatorSource` is the explicit statement that the AC-input is a
generator; an off-grid site can still be geolocated in VIC without being on the VIC1 grid). The fold then
prices generator charge and direct use exactly like grid; **no fold change**. Opt-in: absent config →
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
- It owns the 5 derived **blend points** (`bidi.battery/carbon-intensity` gCO₂/kWh, `/renewable-fraction` %,
  `/price` + `/price-opportunity` c/kWh, `/stored-energy` kWh) — ordinary `point_info` rows (the
  HWS/run-tracking derived-point pattern: written to their own `agg_5m` + KV latest; the 5m aggregator's
  `hasCurrent` guard skips them). They are **bound into the Area** (`area_bindings`, under
  `role='battery'`) so they fan out to the Area's KV latest and appear in its resolved point set — INERT
  to the compute/Sankey paths (the loader reads only power/soc/rate/energy; the flow resolver is
  power-only), so there is no feedback loop. **No schema change** for the helper. (The learned params
  live in `battery_provenance_daily`, not on the helper — see the learn section above.)

## Storage

- **Live blend** — the 5 derived points on the helper (`agg_5m` + KV latest), all written per interval by
  the same blend loop from one `FoldStep`: `carbon-intensity`, `renewable-fraction`, `price` (ACTUAL,
  out-of-pocket — "Battery Energy Cost"), `price-opportunity` (the ADDITIONAL forgone feed-in component,
  ≥ 0 — "Battery Opportunity Cost"), and `stored-energy` (usable kWh E). Serve on
  the Area dashboard via the generic point stack. The **Battery Contents card** (`components/BatteryContentsCard.tsx`,
  selector `lib/battery/contents-latest.ts`) reads these: the absolute totals are DERIVED client-side —
  `intensity × stored-energy` reconstructs each total exactly (total carbon, actual/opportunity cost, export
  value), nothing extra is stored.
- **Daily state** — `battery_provenance_daily` (migration `0024`): per (area, local-day) learn inputs +
  learned params + the fold checkpoint. See the learn + checkpoint sections.
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
  `agg_5m` + KV (via the shared `writeBlendOutputs`), and (on the daily/range pass, `writeRollup`) the
  per-day rollup — the same accounting sliced per local day. The load window is extended back by
  `WARMUP_MS` (7 d) so the fold anchors at a reset before the target window; only the target window's
  rows are written (HWS-style warm-up). The trusted long-window paths also persist **fold checkpoints**
  (`writeCheckpoints`; next section).
- **Orchestration** — `lib/battery-provenance/recompute.ts`: `listBatteryProvenanceHandles` (Areas with a
  bound battery) + `reconcileTrailingWindow` (blend only) + `learnForAllHandles` + `recomputeRange` (daily
  heal / backfill, writes the rollup + checkpoints). The minutely cron (`app/api/cron/minutely`) runs the
  reconcile **once per 5-min bucket** (inputs are 5-min-native, so a minutely re-fold is 5× waste); a
  **watermark gate** skips a handle whose blend output has caught up to its battery input (idle / dead
  feed → 2 `MAX` reads), and a live handle takes the **checkpoint-seeded O(today) path** (next section),
  falling back to the 12h+7d warm-up re-fold on any guard failure. The **daily heal**
  (`lib/aggregation/daily-points.ts`, runs LAST — it reads the `agg_5m` the passes above materialise)
  runs THE learn FIRST, then recomputes blend + rollup so it reads fresh params. Best-effort throughout.
- **Harness** — `scripts/replay-battery-provenance.ts`: read-only/dry-run over the dev mirror; loads once,
  sweeps configs (`--eta`, `--floor`, `--solar`, `--no-soc`); prints an inspector panel (blend series, per-
  load attribution, RTE, capacity, resets, loss buckets, a conservation self-audit). A pre-prod gate.

## Fold checkpoints + the O(today) minutely reconcile

`foldStep` is a pure function of (state, interval, config) and `foldBatteryProvenance` accepts an initial
state (slice-and-chain identity is property-tested), so the fold's state can be **checkpointed** instead
of re-derived from a 7-day warm-up every 5 minutes:

- **Write** (`battery_provenance_daily.fold_state`, a `FoldCheckpointEnvelope` —
  `lib/battery-provenance/checkpoint.ts`): the TRUSTED long-window paths only (the daily heal's
  `recomputeRange` and the recompute-provenance API; NEVER the minutely path) snapshot the fold state at
  each local midnight inside their write window (`snapshotAtMs` on `computeBatteryProvenance`). Gated on
  **canonical inputs** (persisted param series — a fold on in-window learners is window-dependent) and a
  pristine config. The envelope carries `anchorMs` (the END of the last folded interval ≤ midnight — a
  gap straddling midnight anchors BEFORE it), plus the two window-global scalars a seeded re-fold must
  replay: `reserveFloorPct` (the KV sliding floor at write time) and `etaFallback` (`etaUsed`).
- **Read** (`reconcileBatteryProvenanceFromCheckpoint`): the minutely reconcile seeds the fold with the
  freshest checkpoint (≤ 2 days back) and reads only (anchor → now] — **~1.5–5k agg_5m rows instead of
  ~25k, bounded forever**. Re-folding from the anchor each tick (not from the last tick) self-heals late
  INTRA-day data with zero invalidation bookkeeping. Guards, each falling back to the unchanged 12h+7d
  warm-up path: envelope validation (strict finiteness — the jsonb NaN→null hazard), model version,
  span ≤ 3.5 d, a pre-anchor `updated_at` staleness probe (catches backfills of yesterday), canonical
  inputs, custom config. Writes blend + KV only (no rollup, no checkpoints).
- **`BATPROV_MODEL_VERSION`** (`checkpoint.ts`): bump on ANY semantic change to the fold/compute/load/
  learners → every stored checkpoint is silently distrusted → warm-up fallback (today's exact behaviour)
  until the next 00:05 heal rewrites them. Never a regression; no operator action. An exhaustive
  `satisfies`-spec validator makes a `FoldState` shape change a compile error, forcing the bump decision.
- **Accepted trade-off**: pre-anchor revisions inside the old 12 h window (e.g. Amber finalising
  yesterday evening) now heal at the nightly heal rather than within minutes; the knob, if it bites, is
  seeding from day−1's checkpoint. The identity gate is
  `lib/battery-provenance/__tests__/checkpoint-identity.test.ts`.

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
per-day series from `battery_provenance_daily`, above), `maxSegmentIntervals` (drift backstop), `reanchorEpsKwh`. The
off-grid `generatorSource` triple lives on the battery system's `config.batteryProvenance` (above).

## Opportunity cost & the export tariff

Solar charged into the battery is **free out-of-pocket** but **forgoes the feed-in revenue** you'd have
earned exporting it. The fold tracks BOTH full bases every run as a **parallel accumulator** (`costC`
actual @ solar-0, `costOppC` opportunity @ solar-feed-in); the actual/opportunity split is first-class,
not a toggle. The WRITTEN points split the intuitive way: `price` = the actual basis ("Battery Energy
Cost") and `price-opportunity` = the **delta** `costOppC/E − costC/E` — the ADDITIONAL forgone feed-in
component only ("Battery Opportunity Cost", ≥ 0; see `blendValue` in
`lib/db/planetscale/battery-provenance-pg.ts`). Full economic cost = the sum of the two points.

Price-sign semantics: negative **import** prices flow through unclamped (grid charge at a negative Amber
rate books negative cost into BOTH bases — `price` can legitimately go negative). The **feed-in** price is
floored at 0 per interval (`compute.ts` `solarCostOpp`): under a negative export price the counterfactual
to storing solar is curtailment, not paying to export, so nothing was forgone.

The fold consumes only a per-interval `exportPrice[]`
series — it never sees modes/schedules — so the source is pluggable. `resolveExportPriceSeries`
(`lib/battery-provenance/tariff.ts`) resolves it from `config.batteryProvenance.exportTariff`:

- **`{ mode: "none" }`** (default) — no opportunity cost (`price-opportunity` reads 0).
- **`{ mode: "amber" }`** — the measured `bidi.grid.export/rate` feed-in series.
- **`{ mode: "schedule", plans }`** — a retailer schedule synthesised per interval. Plans are **effective-
  dated** (`effectiveFrom`; newest ≤ the interval's local date wins) so a historical re-fold prices each
  interval with the plan in force then. Flat rates today; the `tou` band shape is schema-reserved
  (`ScheduleTariffProvider` throws until the evaluator lands). Set via the config route.

Designed so a future **persisted tariff device** drops in with no fold change — it would materialise the
same schedule (reusing `ScheduleTariffProvider`) into a `bidi.grid.export/rate` point the loader reads
exactly like Amber. The per-day attribution rollup stays ACTUAL cost; opportunity lives only in the battery
fold / the Contents card.

## Operations

- **0. Handle → areaId** — `GET /api/areas/by-handle/{handle}` → `{ areaId, systemId, displayName }`. The
  recompute / provenance-summary endpoints are keyed on the Area **UUID**, but a human/runbook starts from
  the integer handle (e.g. `8` = Kinkora, `1000002` = Daylesford). Every ops session begins here.
- **Activate / reprice an Area via API** (the recommended path — no direct DB access) — owner/admin (or a
  `CRON_SECRET` bearer, see below), keyed on the `{areaId}` from step 0:
  1. `PUT /api/areas/{areaId}/bindings` — the role→point bindings (battery power/soc/charge+discharge
     energy, solar, load; for an off-grid site also `bidi.grid` = the generator, `transform:null` to inherit
     its `i` sign flip).
  2. `PATCH /api/admin/systems/{batterySystemId}/config` — set `batteryProvenance.generatorSource`
     `{emissionsIntensity, pricePerKwh, renewableFraction}` (send the WHOLE config; PATCH **replaces** the
     blob). For an on-grid site with feed-in, set `batteryProvenance.exportTariff` here too (e.g. `{mode:"amber"}`).
  3. `POST /api/areas/{areaId}/recompute-provenance` — bounded-batch materialise: learns η on the first batch,
     then recomputes blend + rollup, ensuring the helper device + points on demand. Loop on the returned
     `nextCursor` until `done` (body `{start?,end?,last?,cursor?,limit?}`, same semantics as `recompute-flow`).
- **4. Verify** — `GET /api/areas/{areaId}/provenance-summary?start=&end=` (or `last=Nd`; defaults to full
  history) returns, over the window:
  - `sources[]` — per-source intensities `{sourcePath, label, energyKwh, kgCo2, avgGramsPerKwh,
avgCentsPerKwh, pctRenewable, pctEstimated}`. Confirms a reprice landed (e.g. an off-grid `source.grid`
    ≈ the configured generator intensity) without hand-computing from the raw matrix.
  - `consistency` — the legacy↔modern reconciliation `{legacyKwh, modernKwh, deltaKwh, legacyDays,
modernDays, divergentDays[]}`. **`deltaKwh` ≈ 0 with an empty `divergentDays` is the pass** — the modern
    rollup is a faithful energy projection of the legacy Sankey. A listed divergent day ⇒ re-backfill that day.
    A reprice changes only metrics, never the energy leg, so `deltaKwh` must stay 0 across a reprice. (The
    `monitor-observations` `batprov_modern_legacy_divergence` alert watches this same invariant live.)
- **Headless ops (`CRON_SECRET`)** — `recompute-flow`, `recompute-provenance`, `provenance-summary`, and
  `by-handle` all accept `Authorization: Bearer $CRON_SECRET` in place of a Clerk session, so a reprice/verify
  is a plain `curl` loop. (A dev-minted Clerk JWT does **not** authenticate against prod; this removes the
  browser-extension dance.) Everything else stays owner/admin.
- **Cross-check against the Sankey** — `GET /api/energy-flow-matrix?systemId={handle}&start=&end=&source=legacy|modern`
  serves raw per-day matrices; its `sources`/`loads` are `{id,label,color}` objects (not strings) and
  `days[].matrix[srcIdx][loadIdx]` is that day's kWh. Summing `source.grid` across days for `legacy` vs `modern`
  is the manual form of the `consistency` check above.
- **Backfill (bulk / DBA)** — `scripts/backfill-battery-provenance.ts` (dry-run default) runs `recomputeRange`
  over full history (learns η first); idempotent. For a one-off bulk backfill, or when the API isn't reachable.
  Re-run when recovered upstream data (e.g. an Amber gap) lands.
- **Prod cutover** — migration `0023` applied to `sydney`; the crons auto-create helpers + blend + rollup, and
  the backfill (or the recompute-provenance API) materialises full history. See [migrations.md](migrations.md).

## Not yet (follow-ups)

- Bespoke FE **blend mini-card** + **EV-period card** (the live blend already renders via the generic
  device-metrics card; the period report is a client-side reduction of the `source=modern` payload).
- `monitor-observations` **runaway-segment** alert — the last deferred monitor signal; needs the fold's
  segment age persisted. (Blend/rollup staleness, high estimated-fraction, the modern↔legacy
  consistency alert, and the SoC↔meter reconciliation alert are live.)
- The `flow_1d → flow_attr_1d` **cutover** (flip the `source` default to `modern`, drop `flow_1d`).
- Sankey **relabel** `source.grid` → "Generator" for off-grid areas (the attribution is already correct).
- **Reserve floor is the one non-reproducible input** — every other learned input (η, C, η*c, idle) is
  fixed-anchor + persisted, but the reserve floor is a \_sliding* 90-day 0.5th-percentile cached in KV
  (~25h TTL; `load.ts`), so a backfill and a live reconcile can land on different floors across the
  TTL/window boundary. Bounded ≤ ~2.6 kWh by the `[5,10]` clamp. Candidate for the same
  persisted-point treatment as η/C.

### Closed: the "SoC vs registers disagree" caveat (2026-07-15)

The PR-#168 caveat ("Daylesford's SoC rises ~39pp over 40 days while metered net ≈ 0") did **not**
reproduce against prod registers — full-history reconciliation closes under a three-term loss model
(charge-side η_c ≈ 0.94, discharge ≈ 1:1, constant idle drain ≈ 0.47 kWh/day ≈ 20 W) plus rare,
benign **BMS full-charge recalibration snaps** (SoC re-syncs several pp in one interval with no
metered energy). The fold now implements exactly this: `losses.ts` learns (η_c, idle), persisted per-day in
`battery_provenance_daily` (`charge_eff`, `idle_loss_kwh_day`), the fold books an `idleLoss*` bucket and snaps E in
one step on a recal (learner days excluded), and `monitor-observations` check 5c
(`batprov_soc_meter_divergence`) turns the reconciliation into a standing per-day feed-fault detector.
Findings + plan: `docs/plans/battery-soc-meter-reconciliation.md`.

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
