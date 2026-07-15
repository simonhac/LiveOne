# Battery energy provenance — metric-attributed energy flows

> **Status:** engine + data core LIVE on `main` and prod (PR #160 wave, then #173 opportunity-cost
> delta split, #174 `battery_provenance_daily` incremental learn + fold checkpoints, #175 scoped
> consistency check). Current branch: the reserve floor becomes the fifth persisted per-day learned
> parameter (it was previously a KV-cached sliding percentile — the last non-reproducible input).
> Prod runbook: see [Operations](#operations). Companion to
> [energy-flow-matrix.md](energy-flow-matrix.md): provenance is the **metric legs** of that same flow.

**How to read this doc.** Part 1 explains the problem and the mental model (no prior context assumed).
Part 2 walks through the algorithm, from the simplest form to the full production model. Part 3 explains
how the design stays correct and cheap when data arrives late, revised, and gappy. Part 4 is the
implementation and operations reference.

---

## Part 1 — The problem and the idea

### The question we answer

A LiveOne dashboard already shows a household's **energy** flows — how many kWh went from solar, grid,
and battery to each load (the Sankey diagram). This feature adds the **quality** of that energy, so a
user can ask, for any load and any period:

> _"What did it cost, how green was it, and what were the emissions to charge the EV over July?"_

Three metrics are attached to every energy flow:

- **Emissions intensity** — grams of CO₂ per kWh. Source: OpenElectricity
  `grid.emissionsIntensity/intensity` (tCO₂e/MWh ≡ gCO₂/kWh) on the household's NEM-region system,
  5-minute resolution.
- **Renewable proportion** — what fraction of the energy was renewable (%). Source: OpenElectricity
  `grid.renewables/proportion`, same region system, 5-minute.
- **Cost / price** — cents per kWh. Source: Amber `bidi.grid.import/rate` on the household's own
  system, 30-minute step.

These are **intensive** metrics: per-kWh properties carried _by_ the flow (like the temperature of
water in a pipe), as opposed to **extensive** totals (grams, cents — like litres). Multiply an
intensive value by the kWh it rode on and you get the extensive total; that multiplication is exactly
what the attribution does.

### Why the battery is the hard part

For direct flows the answer is immediate. A load served by solar at 2 pm got 0 gCO₂/kWh, 100 %
renewable energy at the solar cost. A load served from the grid inherits whatever the grid's intensity
and price were _in that 5-minute interval_.

The battery breaks this, because it **time-shifts energy**. The kWh your house draws from the battery
at 9 pm was put there at some earlier time, under some earlier mix — maybe free afternoon solar, maybe
cheap-but-dirty overnight grid, usually a blend of several charging sessions. To attribute battery
energy honestly you need _memory_: a running account of what went into the battery and what it was
worth when it went in.

### The core idea: the battery as a tank of blended energy

We model the battery exactly like **average-cost inventory accounting** (the same way a warehouse
prices stock bought at different prices):

- **Charging mixes in.** Energy entering the battery carries its source's metrics. Solar charge is
  0 gCO₂, 100 % renewable, at the solar cost; grid charge carries that interval's grid intensity and
  price. The tank's contents become the **weighted average** of everything currently in it.
- **Discharging vends the blend.** Energy leaving the battery carries the tank's _current_ blended
  metrics — and (like taking a bucket from a stirred tank) discharging doesn't change the blend of
  what remains.
- **Bottoming out resets the ledger.** When the battery empties down to its **reserve floor** (the
  minimum charge its management system keeps in reserve), the accumulators reset and a fresh account
  begins.

So a load served by the battery inherits the battery's blend at that moment, and per-load questions
("the EV over July") become a single query over pre-computed attributions.

### Terminology

The rest of this doc uses these terms freely; all are defined in depth later.

| Term                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fold**                       | The battery model's core computation, named after the functional-programming _fold_ (a.k.a. _reduce_): a pure function `(state, one 5-min interval) → state`, applied interval-by-interval over the timeline. Deterministic, no database/clock/IO — so the same inputs always produce byte-identical output. "The fold" refers to both the function (`lib/battery-provenance/fold.ts`) and the battery model it implements. |
| **blend**                      | The battery's current weighted-average metrics (gCO₂/kWh, % renewable, c/kWh) — what a discharge vends right now.                                                                                                                                                                                                                                                                                                           |
| **intensity**                  | An intensive per-kWh metric value (see above).                                                                                                                                                                                                                                                                                                                                                                              |
| **segment / reset**            | The fold's history between two resets. A reset (battery bottomed out) starts a new segment; segments are independent, which bounds how far any recomputation must look back.                                                                                                                                                                                                                                                |
| **the learn / learned params** | Five per-day physical parameters (efficiency, capacity, charge efficiency, idle loss, reserve floor) estimated from history by "the learn" — a separate nightly process — and _read_ by the fold, never estimated inside it.                                                                                                                                                                                                |
| **checkpoint**                 | A snapshot of the fold's state at a local midnight, persisted so the frequent live recompute can resume from it instead of re-deriving days of history.                                                                                                                                                                                                                                                                     |
| **helper device**              | A non-physical, derived device owned by an Area that carries the Area's computed points — here, the 5 published blend points.                                                                                                                                                                                                                                                                                               |
| **Area / handle**              | An Area is the logical household (its devices, bindings, dashboards); its integer _handle_ (e.g. `8`) is the human-facing id, distinct from its UUID.                                                                                                                                                                                                                                                                       |
| **`agg_5m`**                   | `point_readings_agg_5m`, the 5-minute pre-aggregated readings table — the fold's sole telemetry input.                                                                                                                                                                                                                                                                                                                      |
| **`estimatedKwh`**             | The confidence denominator: energy whose attribution relied on an estimated or missing input, tracked per attribution edge.                                                                                                                                                                                                                                                                                                 |
| **reserve floor**              | The SoC (state-of-charge) percentage below which the battery never usefully discharges; usable energy is measured _above_ it.                                                                                                                                                                                                                                                                                               |

### The system at a glance

```
vendor telemetry (solar / battery / grid meters; OpenElectricity; Amber)
        │  normal ingest pipeline
        ▼
point_readings_agg_5m ────────────► THE LEARN (nightly): per-day reductions → fits
        │                               └─► battery_provenance_daily
        │                                   (learn inputs + 5 learned params + fold checkpoints)
        ▼                                        │  params read back per interval
loadProvenanceInputs  ◄──────────────────────────┘
        ▼
computeBatteryProvenance  =  THE FOLD (per-5-min battery blend)
                             + computeFlowAccounting (per-load attribution)
        │
        ├─► 5 blend points on the helper device (agg_5m + KV latest)  — live dashboard
        ├─► point_readings_flow_attr_1d                               — per-day per-edge rollup
        └─► fold checkpoints (battery_provenance_daily.fold_state)    — cheap live recompute
        ▼
serving: /api/energy-flow-matrix?source=modern · provenance-summary · Battery Contents card
```

Three write cadences drive this (detail in [Part 3](#the-three-cadences)): a **minutely reconcile**
keeps the live blend fresh, a **nightly heal** re-learns params and recomputes the trailing window, and
an **on-demand recompute API / backfill** materialises history.

---

## Part 2 — The algorithm

### One allocation loop; provenance is its metric legs

The Sankey energy matrix and provenance are **the same allocation**, computed once.
`computeFlowAccounting` (`lib/aggregation/flow-matrix-core.ts`) is the single allocation loop: it
integrates each load's energy and splits it across sources by generation share, and — when given
per-source **intensity** series — decorates every contribution with that source's
emissions/renewable/cost. `computeFlowMatrix` (the Sankey) is the **energy projection** of it, so the
metric legs can never drift from energy (guarded by the existing flow-matrix byte-identical tests).

Per-source intensities:

| Source  | Emissions                                 | Renewable              | Cost                                                                                                                      |
| ------- | ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| solar   | 0 gCO₂/kWh                                | 100 %                  | `solarCost` (0 out-of-pocket; see [opportunity cost](#actual-vs-opportunity-cost))                                        |
| grid    | OpenElectricity series                    | OpenElectricity series | Amber series (or, off-grid, a configured **generator** constant — see [Off-grid + generator](#off-grid-sites--generator)) |
| battery | **the fold's per-interval blend** (below) | ″                      | ″                                                                                                                         |
| other   | unknown (null)                            | unknown                | unknown                                                                                                                   |

### The fold: the battery model, step by step

`lib/battery-provenance/fold.ts` — pure, deterministic, DB-free (the structural analogue of
`lib/run-tracking/detect.ts`). The state it carries per segment:

- **`E`** — the inventory: (Σ deliverable charge − Σ discharge) since the last reset, floored at 0.
  Note this is **reset-relative**, not absolute stored energy — it needs no battery nameplate capacity.
- **`Qc`, `Qr`, `Qm`** — the blended stocks riding on `E`: total grams of CO₂, renewable kWh, and cost
  (cents) currently "in the tank" (plus a parallel opportunity-cost stock, below). Intensities are
  always _derived_ (`Qc/E`, `Qr/E`, `Qm/E`), never stored.

Each 5-minute interval does three things:

1. **Charge mixes in** — add the interval's charge to `E` and each source's contribution to the `Q`s
   at that source's intensity. The solar-vs-grid split of a charge interval comes from the flow
   allocation (`lib/battery-provenance/battery-flows.ts`), so it stays consistent with `flow_1d`'s
   `load.battery` cells.
2. **Discharge vends the blend** — remove the discharged energy from `E` and draw the `Q`s down
   _proportionally_, so the vended intensity equals the pre-discharge blend and the remaining blend is
   unchanged. The vended blend is written to the published blend points AND fed to the attribution as
   `source.battery`'s intensity for that interval.
3. **Maybe reset** — if the battery bottomed out, zero the state and start a new segment.

**A worked example** (simplified: 100 % efficiency, whole hours, emissions only). The battery starts
empty. Morning: 5 kWh of solar charge → `E = 5`, `Qc = 0 g` → blend 0 gCO₂/kWh. Afternoon: 5 kWh of
grid charge at 600 gCO₂/kWh → `E = 10`, `Qc = 3 000 g` → blend 300 gCO₂/kWh. That evening the house
draws 4 kWh: that energy is attributed at 300 gCO₂/kWh (1 200 g), and the battery is left with
`E = 6`, `Qc = 1 800 g` — still 300 gCO₂/kWh. The same arithmetic runs in parallel for renewable kWh
and cost.

**Resets** come in three flavours:

- **`empty`** — `E` drains to ≤ `reanchorEpsKwh` (the reserve bottom-out, needs no SoC). Primary.
- **`soc-floor`** — measured SoC ≤ the reserve floor (drift correction when SoC is available; lazy —
  applied at the next charge, so discharge down at the reserve still vends the real blend).
- **`backstop`** — a segment ran `maxSegmentIntervals` (default 6 days) without a reset; a staleness
  cap for a battery that neither empties nor reports SoC.

Resets matter beyond physics: each one **segments the history**, and segments are independent — so a
late-data repair only ever needs to re-fold from the last reset before the affected data, never from
the beginning of time. Any residual `Q` discarded at a _forced_ (non-empty) reset is captured in the
`unattribLoss*` buckets so the conservation identity (below) stays auditable.

### Refinements

The model above is the skeleton. Real batteries lose energy, drift, and lie about their SoC; the
production fold layers these refinements on, each inert when its inputs are absent.

#### Round-trip efficiency (η)

A battery returns less than you put in. With η < 1, charge adds `η·charge` to `E` (the _deliverable_
part) but the **full** footprint to `Q` — so delivered energy carries the whole footprint (round-trip
loss is priced into the loads the battery serves) and `E` reaches 0 exactly at the physical bottom-out
(`discharge ≈ η·charge`). The `(1−η)` overhead is also tallied in **loss buckets** (kWh / $ / gCO₂) as
a decomposition — a diagnostic, not subtracted, so nothing is double-counted. η is a per-interval
**input** to the fold, learned in the shell and read back ([the learn](#the-learn--five-reproducible-parameters)).

**Renewable is the exception**: it is a bounded _proportion_ (loss-invariant — losing energy doesn't
make the remainder less renewable), so renewable content scales with `E` by η, keeping `Qr/E ∈ [0,1]`;
only the unbounded intensities (emissions, cost) inflate by 1/η.

#### The three-term loss model (η_c + idle)

A single η conflates three physically distinct losses, measured on real registers vs SoC (see
`losses.ts`): a **charge-side** efficiency η*c (~0.94 — SoC rises by `η_c·charge`), a ~1:1 discharge,
and a small constant **idle/standby drain** (~20 W ≈ 0.47 kWh/day: BMS + cell balancing +
self-discharge — proportional to \_time*, not throughput). When the learner has values, η*c replaces η
at the charge seam (same "loss priced into delivered" booking, just the right coefficient) and the
idle drain bleeds the store pro-rata into `idleLoss*` buckets each interval — so \_parked* energy pays
the standby tax over time instead of charging sources paying it up front. Absent (SoC-blind history,
learner not yet run) both are inert and the fold is byte-identical to the single-η model.

#### The SoC-anchor overlay

The reset-relative model has no valid anchor for a battery that **never physically empties** (it sits
high; a generator holds the floor). Such a battery hits neither the `empty` nor `soc-floor` reset, so
the crude `backstop` would be its only reset — dumping the whole live inventory to unattributed loss
mid-SoC. The fix, without abandoning the power model: an optional overlay pins `E` to the physical
usable energy

```
targetE = (SoC − reserveFloor) / 100 · C
```

each interval (`C` a **learned** usable capacity, stamped per-interval like η). A small per-interval
nudge (`socSyncGamma`) bleeds integration drift into auditable `sync*` buckets instead of a 6-day
backstop bonfire. A down-correction scales all accumulators by one factor — **provenance-neutral**
(vended ratios unchanged); an up-correction injects energy at the site's fallback provenance. When SoC
or C is absent the overlay is inert and the fold is byte-identical to the pure power model (the
backstop keeps its only real job: the SoC-blind staleness cap).

#### BMS recalibration snaps

A coulomb-counting BMS periodically re-syncs its SoC at full charge — SoC steps several percentage
points in one interval with **no matching metered energy**. The fold tracks the metered deliverable net
since the last SoC observation; when the SoC-implied energy diverges from it by more than
`recalSnapKwh`, the interval is flagged `recal` and the SoC sync snaps `E` to target in one step
(bypassing the `socSyncGamma` smoothing) — a re-anchor event, not energy. The same detection (in
`losses.ts`) excludes that local day from the learners so the phantom energy can't bias the fits.

#### Why these choices (robustness properties)

- **No capacity knob.** `E` is integrated from charge/discharge _power/energy_, never `SoC × capacity`
  — so a mid-life battery-capacity change is absorbed automatically (observed: the inferred capacity
  stepping from ~20 kWh to ~40 kWh when a site's battery doubled, with zero reconfiguration).
- **SoC is optional.** It is used only to detect the reserve floor and (with learned C) to anchor `E`
  — never to _size_ `E`. With no SoC the fold relies on full-discharge auto-resets + the drift
  backstop; ablation shows removing SoC changes the EV-attribution number by < 10 %. (One site's SoC
  feed had a ~7-month gap; the model ran through it.)

#### Actual vs opportunity cost

Solar charged into the battery is **free out-of-pocket** but **forgoes the feed-in revenue** you'd have
earned exporting it. The fold tracks both bases every run as a parallel accumulator (`costC` actual @
solar-cost-0, `costOppC` opportunity @ solar-feed-in) — the split is first-class, not a toggle. The
**written** points split the intuitive way: `price` = the actual basis ("Battery Energy Cost") and
`price-opportunity` = the **delta** `costOppC/E − costC/E` — only the _additional_ forgone feed-in
component, ≥ 0 ("Battery Opportunity Cost"; see `blendValue` in
`lib/db/planetscale/battery-provenance-pg.ts`). Full economic cost = the sum of the two points.

Price-sign semantics: negative **import** prices flow through unclamped (grid charge at a negative
Amber rate books negative cost into both bases — `price` can legitimately go negative). The **feed-in**
price is floored at 0 per interval (`compute.ts` `solarCostOpp`): under a negative export price the
counterfactual to storing solar is curtailment, not paying to export, so nothing was forgone. Where the
feed-in series comes from (Amber, a retailer schedule, nothing) is config — see
[the export tariff](#opportunity-cost--the-export-tariff-config-detail) in Part 4.

### The learn — five reproducible parameters

The fold needs per-interval values for physical parameters no one configures by hand:

| Param             | What it is                              | Estimator                                                        |
| ----------------- | --------------------------------------- | ---------------------------------------------------------------- |
| **η**             | round-trip efficiency                   | `eta.ts` — daily EWMA of Σout/Σin                                |
| **C**             | usable capacity (kWh, 0→100 % SoC span) | `capacity.ts` — daily EWMA of rail-gated discharge/ΔSoC pairs    |
| **η_c**           | charge-side efficiency                  | `losses.ts` — expanding-window least-squares (5 running sums)    |
| **idle**          | standby drain (kWh/day)                 | `losses.ts` (same fit; recal days excluded)                      |
| **reserve floor** | minimum operating SoC (%)               | `reserve-floor.ts` — low quantile of trailing per-day SoC minima |

All five are learned **once, over a stable window (fixed anchor → now) — never re-learned per
recompute window**. That is what keeps the blend **reproducible**: if the fold re-learned them from its
own (bounded) window, the same day would get different params depending on which cron last touched it,
breaking `fold(complete) == fold(partial) + heal` (repair convergence — the load-bearing property of
[Part 3](#part-3--repeatable--efficient-with-dripfed-data)). Hence **learn-in-shell / read-in-fold**:
the estimators run in the daily shell; the fold only reads.

The estimators are pure + causal (the pair applied to day D is learned from days < D only) and consume
only **per-local-day reductions** of the raw registers — so the learn is incremental, built on one
table, `battery_provenance_daily` (structure in [Part 3](#battery_provenance_daily--the-incremental-seam)):

- `learnAllForHandle` (`lib/db/planetscale/battery-provenance-daily-pg.ts`) is THE learn (η → C →
  losses ordering structurally enforced; the reserve floor fits independently from the SoC minima):
  incrementally maintain the per-day input rows, run the fits over the ~330 cached rows
  (microseconds), persist the params.
- The **loader** reads the param columns (each day's value anchored at the day's first `interval_end`,
  forward-filled ≤ 48 h, with a 48 h lead-in) into `inputs.etaSeries` / `capacitySeries` /
  `chargeEfficiencySeries` / `idleLossKwhPerDaySeries` (and, this branch, the reserve-floor series);
  `computeBatteryProvenance` stamps them per interval and does **not** re-learn. Precedence: a numeric
  config pin (tests / manual) → persisted series (canonical) → an in-window learn (bootstrap only +
  the offline harness).
- The per-day param columns double as the **degradation-trend** diagnostic (slow decline = ageing; a
  step = a hardware/capacity change). The first activated site learns η ≈ 0.88–0.92.

**The reserve floor** (this branch) deserves its own note, because it used to be the odd one out: a
_sliding_ 90-day 0.5th-percentile of all 5-min SoC samples, cached in KV (~25 h TTL) — the ONE
provenance input that was neither reproducible nor persisted, so a stale cache could re-freeze into
fold checkpoints and self-perpetuate (the ~20 % "genset comfort setpoint" bug). It is now learned per
local day by `learnReserveFloorByDay` (`reserve-floor.ts`): a low quantile (5th percentile) of the
trailing ≤ 90-day per-day SoC **minima** (the additive `socMin` reduction in `daily.ts`), minus 2 pp,
clamped to `[5, reserveFloorMaxPct]` — persisted in `battery_provenance_daily.reserve_floor_pct`
exactly like η/C/η_c/idle. The clamp is a "learn-where-you-can, assume-where-you-can't" rule: where the
battery discharges deep the quantile is data-driven; where it never goes below its genset setpoint the
true floor is unidentifiable from SoC, so it pins to the prior `reserveFloorMaxPct`
(`config.batteryProvenance.reserveFloorMaxPct`, default 10 %) — also the fallback when the window has
< 10 observed days.

**History**: the params were previously four helper POINTS (`bidi.battery/round-trip-efficiency`,
`/usable-capacity`, `/charge-efficiency`, `/idle-loss`, ordinals 110–113, η/η_c stored ×100). The
legacy points/bindings/step-rows are deleted by `scripts/delete-battery-param-points.ts` — run ONLY
after `scripts/verify-daily-learn-equivalence.ts` passes against the same DB (the step rows are the
equivalence baseline).

### The conservation invariant

For every metric, over any window (property-tested; holds to 0.00 % over 81k real intervals):

```
Σ charged + Σ sync-injected  =  Σ vended to loads + Σ unattributed + Σ idle loss + Σ stored
```

Every gram, cent, and renewable kWh that enters the model is accounted for — vended, explicitly
bucketed as loss, or still in the tank. Nothing leaks silently.

---

## Part 3 — Repeatable & efficient with dripfed data

The fold is a clean pure function, but its inputs are anything but clean: they **drip in** from several
devices, asynchronously, with lag, revisions, and gaps. The engineering problem of this feature is
making a stateful, history-dependent model behave well under that — every recompute **idempotent**,
every repair **bounded**, and the hot path **cheap**.

### What the data actually looks like

- OpenElectricity: ~5-min with small lag; occasional late intervals.
- Amber: 30-min step; prices arrive `estimated` and are later revised to `billable`.
- Battery power/SoC (Fronius/Mondo/…): can gap for hours or months.
- Backfills and repairs can rewrite _history_ long after the fact (via the normal receiver upsert).

### Tolerating gaps: per-input estimators

The engine is best-effort per missing input, never all-or-nothing: carry forward the last
OpenElectricity value within a segment; hold Amber's 30-min step; integrate power when an energy
register is missing; on a battery blackout **freeze** (don't reset) the accumulator and replay on
catch-up.

### Honesty about estimates: `estimatedKwh`

Estimation is tracked, not hidden. **`estimatedKwh` is the confidence denominator** — energy whose
attribution used an _estimated or missing_ input (Amber still `estimated`, a forward-filled OE reading,
a null, or battery energy inheriting a taint; provenance is _sticky within a cycle_ — tainted charge
taints the discharge that vends it). Surfaced as `pctEstimated = 100·Σestimated_kwh / Σenergy_kwh`.
When late data lands, re-folding upgrades `estimated → good` for free. Anything unresolved past a
cutoff is finalised-but-flagged (`finalized_at`), never silently promoted to fact.

### Repair = bounded, idempotent recompute

Three properties make "just recompute the window" safe and cheap:

1. **Determinism** — the fold is pure; same inputs ⇒ byte-identical outputs, so recomputing over
   already-good data is a no-op write.
2. **Resets bound the past** — a segment starts from zero state, so a re-fold only needs to start at a
   reset before the affected window. In practice the load window is extended back by `WARMUP_MS` (7
   days) so the fold anchors at a reset before the target window; only the target window's rows are
   written (the HWS-style warm-up).
3. **Params are read, not learned** — the fixed-anchor learn (Part 2) means a bounded re-fold uses the
   _same_ per-day params as a full-history run, so the two converge on the same answer.

So the repair story is simply: late/revised data lands via the normal receiver upsert → the trailing
reconcile / nightly heal re-folds the affected window → done. No invalidation bookkeeping.

### `battery_provenance_daily` — the incremental seam

Migration `0024`: **one row per (battery Area, local day)** — the single canonical home for all daily
battery-provenance state, three groups of columns:

- **Learn inputs** — the per-day reductions of the raw registers (Σcharge/Σdischarge, SoC
  first/last/min/samples, the rail-gated capacity pair sums, the recal flag), computed once from
  `agg_5m` by `daily.ts#reduceThroughputToDays`, with carry columns making each row a byte-exact
  resumable seam.
- **Learned params** — η / C / η_c / idle / reserve floor applied that day (natural units — ratios,
  not %).
- **Fold checkpoint** — `fold_state` (next section).

`learnAllForHandle` maintains the input rows incrementally: append new days + re-reduce a trailing 3
days (absorbs late data near the tip) + re-reduce from the earliest `agg_1d`-probe mismatch (late-data
invalidation deeper in history) — then re-run the fits over all cached rows (microseconds) and persist.
A full-history activation / backfill / reduce-version bump (`BATTERY_DAILY_VERSION`, bumped when the
reduction semantics change — e.g. to 2 when `socMin` was added) forces a from-scratch rebuild: ONE
bounded `loadBatteryThroughput` read — which is what keeps the recompute-provenance route's first batch
inside its `maxDuration`.

### The daily-history panel (debugging/observability UI)

`battery_provenance_daily`'s learn inputs + learned params + fold-checkpoint scalars are otherwise
only inspectable via `psql`. A read-only panel on the **helper device's `/device` view** renders them
as 7 stacked daily charts (throughput, SoC + reserve floor, η/η_c, capacity + idle loss, coverage +
recal-day bands, fold-checkpoint contents, fold-checkpoint blended intensities) over a navigable 1Y/30D
window, with a synced hover crosshair and a value table carrying a description tooltip per field —
built specifically to make the reserve-floor learner (previous section) and the other learners visible
without a database session:

- `GET /api/areas/{areaId}/provenance-daily?start=&end=` (`app/api/areas/[areaId]/provenance-daily/route.ts`)
  — dense day-indexed columnar arrays (a missing row is `null` in every field, so gaps render as
  breaks, never bridged lines); fold-checkpoint scalars (`storedKwh`, `carbonG`, …) are extracted
  through `validateFoldCheckpointEnvelope` so a malformed/stale envelope degrades to `null` rather than
  a wrong value. `requireDashboardAccess`-gated (share-token viewers can reach it, like the other
  read-only data endpoints).
- `lib/battery-provenance/field-registry.ts` is the single source of truth the API, the chart series,
  and the table's tooltip copy all read from — a `satisfies Record<keyof BatteryProvenanceDailyRow, …>`
  guard makes an un-registered schema column a compile error.
- The helper device carries no area-of-one, so the panel resolves its **parent** Area (the row key)
  from the helper's `vendor_site_id` (`helper:area:<uuid>`, minted by `ensureHelperDevice` —
  [above](#the-helper-device--where-the-blend-lives)) via `lib/areas/helper-site-id.ts`, not from the
  device page's section-key sentinel.
- Gated behind a new atomic capability `battery/provenance` (matched on the helper's
  `bidi.battery`/`stored-energy` blend point), seeded only in `buildAreaStrategy`'s instrumentation-only
  branch — i.e. today, only the helper's own `/device` view; not (yet) an addable Area-dashboard card.

### Fold checkpoints + the O(today) minutely reconcile

Without help, keeping the live blend fresh would mean re-folding a 7-day warm-up every 5 minutes.
Because `foldStep` is pure and `foldBatteryProvenance` accepts an initial state (slice-and-chain
identity is property-tested), the fold's state can be **checkpointed** instead:

- **Write** (`battery_provenance_daily.fold_state`, a `FoldCheckpointEnvelope` —
  `lib/battery-provenance/checkpoint.ts`): the TRUSTED long-window paths only (the nightly heal's
  `recomputeRange` and the recompute-provenance API; NEVER the minutely path) snapshot the fold state
  at each local midnight inside their write window (`snapshotAtMs` on `computeBatteryProvenance`).
  Gated on **canonical inputs** (persisted param series — a fold on in-window learners is
  window-dependent) and a pristine config. The envelope carries `anchorMs` (the END of the last folded
  interval ≤ midnight — a gap straddling midnight anchors BEFORE it) plus the scalars a seeded re-fold
  must replay: the reserve floor in effect at write time (`reserveFloorPct`) and `etaFallback`
  (`etaUsed`).
- **Read** (`reconcileBatteryProvenanceFromCheckpoint`): the minutely reconcile seeds the fold with the
  freshest checkpoint (≤ 2 days back) and reads only (anchor → now] — **~1.5–5k `agg_5m` rows instead
  of ~25k, bounded forever**. Re-folding from the anchor each tick (not from the last tick) self-heals
  late INTRA-day data with zero invalidation bookkeeping. Guards, each falling back to the unchanged
  12h+7d warm-up path: envelope validation (strict finiteness — the jsonb NaN→null hazard), model
  version, span ≤ 3.5 d, a pre-anchor `updated_at` staleness probe (catches backfills of yesterday),
  canonical inputs, custom config. Writes blend + KV only (no rollup, no checkpoints).
- **`BATPROV_MODEL_VERSION`** (`checkpoint.ts`): bump on ANY semantic change to the
  fold/compute/load/learners → every stored checkpoint is silently distrusted → warm-up fallback
  (exactly the pre-checkpoint behaviour) until the next 00:05 heal rewrites them. Never a regression;
  no operator action. An exhaustive `satisfies`-spec validator makes a `FoldState` shape change a
  compile error, forcing the bump decision.
- **Accepted trade-off**: pre-anchor revisions inside the old 12 h window (e.g. Amber finalising
  yesterday evening) now heal at the nightly heal rather than within minutes; the knob, if it bites, is
  seeding from day−1's checkpoint. The identity gate is
  `lib/battery-provenance/__tests__/checkpoint-identity.test.ts`.

### The three cadences

- **Minutely reconcile** (`app/api/cron/minutely` → `reconcileTrailingWindow`, blend only): runs **once
  per 5-min bucket** (inputs are 5-min-native, so a minutely re-fold would be 5× waste). A **watermark
  gate** skips a handle whose blend output has caught up to its battery input (idle / dead feed → just
  2 `MAX` reads); a live handle takes the checkpoint-seeded O(today) path, falling back to the 12h+7d
  warm-up re-fold on any guard failure.
- **Nightly heal** (`lib/aggregation/daily-points.ts`, runs LAST in the daily cron — it reads the
  `agg_5m` the earlier passes materialise): runs THE learn first, then recomputes blend + rollup +
  checkpoints over the trailing window, so it reads fresh params. Best-effort throughout.
- **On-demand**: the recompute-provenance API / backfill script re-materialises any range
  ([Operations](#operations)).

---

## Part 4 — Implementation reference

### The "helper" device — where the blend lives

The blend is **Area-derived** (it depends on the Area's whole solar/grid/battery mix), so it must not
be shoehorned onto a physical child device. It lives on a **helper** — a derived, non-physical device
that lives in an Area and owns the Area's computed points (the Home-Assistant "derived device in an
area" pattern; see [home-assistant-comparison.md](home-assistant-comparison.md)):

- A real `systems` row, `vendor_type = 'helper'`, **owned by the Area's owner** (the blend is private
  household data — NOT ownerless), `status = 'active'`, never polled (a no-op push adapter,
  `lib/vendors/helper/adapter.ts`, so the minutely poll loop skips it). Created lazily + idempotently
  by `ensureHelperDevice(areaId)` (`lib/areas/helper.ts`), added as an `area_devices` member.
- It owns the 5 derived **blend points** (`bidi.battery/carbon-intensity` gCO₂/kWh,
  `/renewable-fraction` %, `/price` + `/price-opportunity` c/kWh, `/stored-energy` kWh) — ordinary
  `point_info` rows (the HWS/run-tracking derived-point pattern: written to their own `agg_5m` + KV
  latest; the 5m aggregator's `hasCurrent` guard skips them). They are **bound into the Area**
  (`area_bindings`, under `role='battery'`) so they fan out to the Area's KV latest and appear in its
  resolved point set — INERT to the compute/Sankey paths (the loader reads only power/soc/rate/energy;
  the flow resolver is power-only), so there is no feedback loop. **No schema change** for the helper.
  (The learned params live in `battery_provenance_daily`, not on the helper.)

### Storage

- **Live blend** — the 5 derived points on the helper (`agg_5m` + KV latest), all written per interval
  by the same blend loop from one `FoldStep`: `carbon-intensity`, `renewable-fraction`, `price`
  (ACTUAL, out-of-pocket — "Battery Energy Cost"), `price-opportunity` (the ADDITIONAL forgone feed-in
  delta, ≥ 0 — "Battery Opportunity Cost"), and `stored-energy` (usable kWh, `E`). Served on the Area
  dashboard via the generic point stack. The **Battery Contents card**
  (`components/BatteryContentsCard.tsx`, selector `lib/battery/contents-latest.ts`) reads these; the
  absolute totals are DERIVED client-side — `intensity × stored-energy` reconstructs each total exactly
  (total carbon, actual/opportunity cost, export value), nothing extra is stored.
- **Daily state** — `battery_provenance_daily` (migration `0024`): per (area, local-day) learn inputs +
  learned params + fold checkpoint ([Part 3](#battery_provenance_daily--the-incremental-seam)).
- **Attribution rollup** — `point_readings_flow_attr_1d` (`lib/db/planetscale/schema.ts`; migration
  `0023`). Keyed exactly like `point_readings_flow_1d` `(area_id, day, source_path, load_path)` and
  carrying **energy too**, plus `emissions_g` / `renewable_kwh` / `cost_c` (nullable — null = intensity
  unknown), `estimated_kwh`, `finalized_at`. So `flow_1d` is a strict **subset** of this — the design
  intent is a later cutover (repoint the Sankey read, drop `flow_1d`).

### Compute pipeline

The engine is **two shared functions** used identically by the prod driver and the offline harness
(they differ only at the edges: which window, and write-vs-print):

1. `loadProvenanceInputs(handle, window)` (`lib/battery-provenance/load.ts`) — resolve curated points
   via `area_bindings` (dedupes a site that double-measures on two devices), read `agg_5m`, resample,
   read back the persisted per-day param series. Battery charge/discharge prefer an **energy register**
   (exact interval energy) over trapezoidal power when the Area binds one.
2. `computeBatteryProvenance(inputs, config)` (`lib/battery-provenance/compute.ts`) — pure: fold →
   build per-source intensities → `computeFlowAccounting`.

Around them:

- **Prod driver** — `lib/db/planetscale/battery-provenance-pg.ts`: load + compute + WRITE the blend
  `agg_5m` + KV (via the shared `writeBlendOutputs`), and (on the daily/range pass, `writeRollup`) the
  per-day rollup — the same accounting sliced per local day. Applies the `WARMUP_MS` warm-up
  ([Part 3](#repair--bounded-idempotent-recompute)); the trusted long-window paths also persist fold
  checkpoints (`writeCheckpoints`).
- **Orchestration** — `lib/battery-provenance/recompute.ts`: `listBatteryProvenanceHandles` (Areas with
  a bound battery) + `reconcileTrailingWindow` (blend only) + `learnForAllHandles` + `recomputeRange`
  (nightly heal / backfill; writes rollup + checkpoints). Cadences in
  [Part 3](#the-three-cadences).
- **Harness** — `scripts/replay-battery-provenance.ts`: read-only/dry-run over the dev mirror; loads
  once, sweeps configs (`--eta`, `--floor`, `--solar`, `--no-soc`); prints an inspector panel (blend
  series, per-load attribution, RTE, capacity, resets, loss buckets, a conservation self-audit). A
  pre-prod gate.

### Off-grid sites + generator

An off-grid site has no grid but a **generator**, whose electrical output the inverter (the micro-grid
master) measures on its AC-input port — carried as `bidi.grid`, so it flows as `source.grid` through
the allocation (the point's `i` transform flips the inverter's raw sign so generator supply reads as
positive import). Its intensity is **config, not telemetry** — most off-grid sites have no queryable
engine controller, and the generator's _power_ isn't separately metered. So the battery system carries
`config.batteryProvenance.generatorSource = { emissionsIntensity, pricePerKwh, renewableFraction }`,
and the loader, whenever this config is present, feeds those constants into the grid intensity series —
**overriding any resolved NEM region** (setting `generatorSource` is the explicit statement that the
AC-input is a generator; an off-grid site can still be geolocated in VIC without being on the VIC1
grid). The fold then prices generator charge and direct use exactly like grid; **no fold change**.
Opt-in: absent config → generator energy stays `estimated` (no regression).

### Serving

`GET /api/energy-flow-matrix?systemId=&start=&end=&source=legacy|modern`
(`app/api/energy-flow-matrix/route.ts`):

- `source=legacy` (default) → `flow_1d`, energy only — today's Sankey, unchanged.
- `source=modern` → `flow_attr_1d`, the **same raw per-day per-edge** matrices PLUS the metric legs
  (emissions/renewable/cost/estimated), all additive over days. The client draws the Sankey from the
  energy slice and derives the per-load **period summary** ("EV: $1.78, 98 % renewable, 29 g/kWh")
  from the same rows — no second fetch, no separate endpoint. The `source` param is the eventual
  `flow_1d → flow_attr_1d` cutover switch.

### Opportunity cost & the export tariff (config detail)

The semantics are in [Part 2](#actual-vs-opportunity-cost); the pluggable source: the fold consumes
only a per-interval `exportPrice[]` series — it never sees modes/schedules.
`resolveExportPriceSeries` (`lib/battery-provenance/tariff.ts`) resolves it from
`config.batteryProvenance.exportTariff`:

- **`{ mode: "none" }`** (default) — no opportunity cost (`price-opportunity` reads 0).
- **`{ mode: "amber" }`** — the measured `bidi.grid.export/rate` feed-in series.
- **`{ mode: "schedule", plans }`** — a retailer schedule synthesised per interval. Plans are
  **effective-dated** (`effectiveFrom`; newest ≤ the interval's local date wins) so a historical
  re-fold prices each interval with the plan in force then. Flat rates today; the `tou` band shape is
  schema-reserved (`ScheduleTariffProvider` throws until the evaluator lands). Set via the config
  route.

Designed so a future **persisted tariff device** drops in with no fold change — it would materialise
the same schedule (reusing `ScheduleTariffProvider`) into a `bidi.grid.export/rate` point the loader
reads exactly like Amber. The per-day attribution rollup stays ACTUAL cost; opportunity lives only in
the battery fold / the Contents card.

### Invariants

- Provenance energy is **byte-identical** to `computeFlowMatrix` (the metric legs never perturb
  energy).
- Per metric: `Σ charged + Σ sync = Σ vended + Σ unattributed + Σ idle loss + stored` (fold
  conservation, exact).
- Renewable is a bounded `[0,1]` proportion (loss-invariant); only emissions/price inflate by 1/η.
- `E` is power-integrated, never capacity-derived → capacity changes need no config.
- All five learned params are fixed-anchor, persisted per-day, and read (never re-learned) by any
  bounded recompute → `fold(complete) == fold(partial) + heal`.
- Averages use **filtered denominators** (energy whose intensity was known) so unknown edges never
  bias them; `estimatedKwh` carries the confidence and never presents an estimate as fact.
- The helper is **owned by the Area owner** (private data, access-controlled like the real devices).

### Config knobs

`ProvenanceConfig` (`lib/battery-provenance/types.ts`) — every knob is an override; the defaults are
the learned/persisted values:

- `reserveFloorPct` — manual pin of the reserve floor %; default = the persisted per-day learned floor
  ([the learn](#the-learn--five-reproducible-parameters)). The learner's upper clamp / prior is the
  separate `config.batteryProvenance.reserveFloorMaxPct` (default 10) on the battery system.
- `efficiency` — a numeric η pin (tests / manual); otherwise η is the persisted per-day series.
- `maxSegmentIntervals` — drift backstop (default 6 days = 6·288).
- `reanchorEpsKwh` — the `empty`-reset threshold on `E` (default 0.3).
- `socSyncGamma` / `socSyncDeadbandKwh` — SoC-anchor overlay: per-interval correction fraction
  (default 0.2) and the ignore-below deadband for SoC quantisation noise (default 0.2 kWh).
- `recalSnapKwh` — BMS-recalibration snap threshold (default 2 kWh).

The off-grid `generatorSource` triple and the `exportTariff` live on the battery system's
`config.batteryProvenance` (above).

### Operations

- **0. Handle → areaId** — `GET /api/areas/by-handle/{handle}` → `{ areaId, systemId, displayName }`.
  The recompute / provenance-summary endpoints are keyed on the Area **UUID**, but a human/runbook
  starts from the integer handle (e.g. `8`, `1000002`). Every ops session begins here.
- **Activate / reprice an Area via API** (the recommended path — no direct DB access) — owner/admin
  (or a `CRON_SECRET` bearer, see below), keyed on the `{areaId}` from step 0:
  1. `PUT /api/areas/{areaId}/bindings` — the role→point bindings (battery power/soc/charge+discharge
     energy, solar, load; for an off-grid site also `bidi.grid` = the generator, `transform:null` to
     inherit its `i` sign flip).
  2. `PATCH /api/admin/systems/{batterySystemId}/config` — set `batteryProvenance.generatorSource`
     `{emissionsIntensity, pricePerKwh, renewableFraction}` (send the WHOLE config; PATCH **replaces**
     the blob). For an on-grid site with feed-in, set `batteryProvenance.exportTariff` here too (e.g.
     `{mode:"amber"}`).
  3. `POST /api/areas/{areaId}/recompute-provenance` — bounded-batch materialise: learns params on the
     first batch, then recomputes blend + rollup, ensuring the helper device + points on demand. Loop
     on the returned `nextCursor` until `done` (body `{start?,end?,last?,cursor?,limit?}`, same
     semantics as `recompute-flow`).
- **4. Verify** — `GET /api/areas/{areaId}/provenance-summary?start=&end=` (or `last=Nd`; defaults to
  full history) returns, over the window:
  - `sources[]` — per-source intensities `{sourcePath, label, energyKwh, kgCo2, avgGramsPerKwh,
avgCentsPerKwh, pctRenewable, pctEstimated}`. Confirms a reprice landed (e.g. an off-grid
    `source.grid` ≈ the configured generator intensity) without hand-computing from the raw matrix.
  - `consistency` — the legacy↔modern reconciliation `{legacyKwh, modernKwh, deltaKwh, legacyDays,
modernDays, divergentDays[]}`. **`deltaKwh` ≈ 0 with an empty `divergentDays` is the pass** — the
    modern rollup is a faithful energy projection of the legacy Sankey. A listed divergent day ⇒
    re-backfill that day. A reprice changes only metrics, never the energy leg, so `deltaKwh` must
    stay 0 across a reprice. (The `monitor-observations` `batprov_modern_legacy_divergence` alert
    watches this same invariant live.)
- **Headless ops (`CRON_SECRET`)** — `recompute-flow`, `recompute-provenance`, `provenance-summary`,
  and `by-handle` all accept `Authorization: Bearer $CRON_SECRET` in place of a Clerk session, so a
  reprice/verify is a plain `curl` loop. (A dev-minted Clerk JWT does **not** authenticate against
  prod; this removes the browser-extension dance.) Everything else stays owner/admin.
- **Cross-check against the Sankey** —
  `GET /api/energy-flow-matrix?systemId={handle}&start=&end=&source=legacy|modern` serves raw per-day
  matrices; its `sources`/`loads` are `{id,label,color}` objects (not strings) and
  `days[].matrix[srcIdx][loadIdx]` is that day's kWh. Summing `source.grid` across days for `legacy`
  vs `modern` is the manual form of the `consistency` check above.
- **Backfill (bulk / DBA)** — `scripts/backfill-battery-provenance.ts` (dry-run default) runs
  `recomputeRange` over full history (learns params first); idempotent. For a one-off bulk backfill,
  or when the API isn't reachable. Re-run when recovered upstream data (e.g. an Amber gap) lands.
- **Prod cutover** — migrations `0023`/`0024` applied to `sydney`; the crons auto-create helpers +
  blend + rollup, and the backfill (or the recompute-provenance API) materialises full history. See
  [migrations.md](../migrations.md).

### Not yet (follow-ups)

- Bespoke FE **blend mini-card** + **EV-period card** (the live blend already renders via the generic
  device-metrics card; the period report is a client-side reduction of the `source=modern` payload).
- `monitor-observations` **runaway-segment** alert — the last deferred monitor signal; needs the fold's
  segment age persisted. (Blend/rollup staleness, high estimated-fraction, the modern↔legacy
  consistency alert, and the SoC↔meter reconciliation alert are live.)
- The `flow_1d → flow_attr_1d` **cutover** (flip the `source` default to `modern`, drop `flow_1d`).
- Sankey **relabel** `source.grid` → "Generator" for off-grid areas (the attribution is already
  correct).

### Closed: the "SoC vs registers disagree" caveat (2026-07-15)

The PR-#168 caveat (one site's SoC rising ~39 pp over 40 days while metered net ≈ 0) did **not**
reproduce against prod registers — full-history reconciliation closes under the three-term loss model
(charge-side η_c ≈ 0.94, discharge ≈ 1:1, constant idle drain ≈ 0.47 kWh/day ≈ 20 W) plus rare, benign
**BMS full-charge recalibration snaps** (SoC re-syncs several pp in one interval with no metered
energy). The fold now implements exactly this ([Part 2](#refinements)): `losses.ts` learns (η_c, idle),
persisted per-day in `battery_provenance_daily` (`charge_eff`, `idle_loss_kwh_day`), the fold books an
`idleLoss*` bucket and snaps `E` in one step on a recal (learner days excluded), and
`monitor-observations` check 5c (`batprov_soc_meter_divergence`) turns the reconciliation into a
standing per-day feed-fault detector. Findings + plan:
`docs/plans/battery-soc-meter-reconciliation.md`.

### Key code

- Pure core: `lib/battery-provenance/fold.ts` (the fold), `battery-flows.ts` (charge-source split),
  `checkpoint.ts` (envelope + model version); estimators `eta.ts`, `capacity.ts`, `losses.ts`,
  `reserve-floor.ts`, over the `daily.ts` per-day reductions;
  `lib/aggregation/flow-matrix-core.ts` (`computeFlowAccounting`).
- Shared engine: `lib/battery-provenance/{load,compute,types,recompute,tariff}.ts`.
- Helper device: `lib/areas/helper.ts`, `lib/vendors/helper/adapter.ts`,
  `lib/battery-provenance/register.ts` (blend points + Area bindings).
- Prod driver + learn: `lib/db/planetscale/battery-provenance-pg.ts`,
  `lib/db/planetscale/battery-provenance-daily-pg.ts` (`learnAllForHandle`); tables + migrations
  `0023`/`0024` in `lib/db/planetscale/schema.ts` / `drizzle-planetscale/`.
- Serving: `app/api/energy-flow-matrix/route.ts` (`source=modern`),
  `lib/aggregation/flow-node-meta.ts`.
- Harness / ops: `scripts/replay-battery-provenance.ts`, `scripts/backfill-battery-provenance.ts`.
