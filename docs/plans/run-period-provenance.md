# Per-run provenance — cost, emissions and renewable share for a run period

> **Status: PLANNED — not started.** Scoped out of the run-periods unit-honesty change (2026-07-28,
> Simon's call) because the naive implementation is only correct for an off-grid generator. Nothing is
> built yet. Prerequisite work lands in the battery-provenance layer, not in the run-periods table.

## Context

A run period (`derived_intervals`) records what a device did between two timestamps — for Daylesford's
genset, ~30 min to 3 h with a known `energy_kwh`. The obvious next columns on the runs table are
**cost**, **emissions** and **renewable share**: "what did that genset run cost me, and what did it emit?"

The obvious *implementation* is wrong, which is why this is a plan and not a patch.

### Why `energy × constant` is not the answer

`systems.config.batteryProvenance.generatorSource` (`lib/capabilities/config.ts:26-33`) already holds
exactly the three factors needed, and is confirmed set on prod system 1 (Daylesford's battery system):
`{ pricePerKwh: 70 (c/kWh), emissionsIntensity: 1000 (gCO₂/kWh), renewableFraction: 0 }`. The
battery-provenance fold prices generator energy with precisely these constants
(`lib/battery-provenance/load.ts:461-483` — `gridEmissions = timeline.map(() => gen.emissionsIntensity)`,
same for price), overriding any NEM/Amber signal. So for Daylesford, `energy_kwh × factor` is not even
an approximation — it is arithmetically identical to what the fold computes.

**But the run detector is role-generic.** It is `generator` today; `pump` and EV-charging are the stated
direction. An EV charging from the grid is the opposite case:

- Amber import price moves every 30 min; OpenElectricity emissions intensity every 5 min.
- If it charges partly off solar and battery, the honest intensity is neither the grid's nor a
  constant — it is the **blended** figure the fold already computes per 5-minute interval.

Applying a generator constant there would be straightforwardly wrong, not slightly off. Worse, the
`generatorSource` factors describe a **generator's output**; applying them to a *load* would price
consumption at the genset tariff. So any implementation must gate on what the device actually is.

## The design

**A run's cost/emissions/renewable share is an energy-weighted integral over the intervals it spans:**

```
costC       = Σ (energy_i × price_i)
emissionsG  = Σ (energy_i × emissionsIntensity_i)
renewableKwh= Σ (energy_i × renewableFraction_i)
```

over the 5-minute intervals `i` covered by `[run.start, run.end]`.

**Which intensity series** — Simon's ruling, 2026-07-28:

- **Consuming device** (EV, pump): the fold's **blended load-path** intensity for that device's load
  path — price, emissions intensity **and renewable fraction**. This is what accounts for the
  solar/battery/grid mix at the moment of consumption.
- **Producing device** (generator): the source-side intensity. For an off-grid generator the fold's
  series are the config constants, so this falls out as the **degenerate case of the same
  integration** — no separate code path, and nothing built here is wasted.

### The problem to solve first

`buildAttributedFlowMatrix(handle, startMs, endMs, …)` (`lib/history/build-attributed-flow-matrix.ts:130`)
already computes attributed energy/emissions/renewable/cost legs for an **arbitrary sub-daily window**
— it seeds the fold from a persisted checkpoint, runs `computeBatteryProvenance`, then
`computeFlowAccounting({ window })`. It is production code behind `/api/history?include=sankey`.

The blocker is **granularity of the API, not correctness**: it returns **one aggregate per window**. A
per-run figure would mean one invocation per run — ~76 for the full page's 30-day window, each seeding
the fold. Not viable in a table request.

So the work is to expose **per-interval (or batched-window) attribution** from the provenance layer:
one range read per request, integrated per run in memory. Note that
`point_readings_flow_attr_1d` is **day-granular** (PK `(area_id, day, source_path, load_path)`) and
cannot be sliced per run — it is not the source here.

### Pieces to reuse

- `computeFlowAccounting`, `buildSourceIntensities` (`lib/battery-provenance/compute.ts:87`)
- `SourceIntensity` (`lib/aggregation/flow-matrix-core.ts:51-58`) — per-interval `emissions[]`,
  `price[]`, `renewable[]`, `selfRenewable[]`, `estimated[]`, index-aligned to the timeline
- The `bidi.battery/*` blend points (`lib/battery-provenance/register.ts:30`) — carbon-intensity, price,
  renewable-fraction, already persisted at 5-minute resolution
- `reduceLoadProvenance` / `reduceSourceProvenance` (`lib/energy-flow-matrix.ts:147,247`) — the existing
  per-load / per-source summary reducers
- Formatters in `lib/provenance-format.ts` — `formatDollars` takes **cents**, `formatKgCo2` takes **kg**,
  `formatGramsPerKwh`, `formatRenewablePct`. Display precedent: `components/LoadProvenanceCard.tsx:98-129`

### Units

| quantity | factor unit | arithmetic | result |
| --- | --- | --- | --- |
| cost | `pricePerKwh` c/kWh | `energyKwh × price` | **cents** (`formatDollars` divides by 100) |
| emissions | `emissionsIntensity` gCO₂/kWh | `energyKwh × intensity` | **grams** (UI ÷1000 for `formatKgCo2`) |
| renewable | `renewableFraction` 0..1 | `energyKwh × fraction` | kWh (or % of run energy) |

### The seam

Put the arithmetic behind a provider so the route and tables never change again:

```ts
runIntensity(run) → { costC, emissionsG, renewableKwh } | null
```

A constant-factor implementation and a per-interval implementation are then interchangeable. Columns
must be **gated server-side** (as `RunPeriodColumns` in `lib/run-tracking/run-period-view.ts` already
does for the signal/power columns) so they are **absent** — never `$0.00` — when intensity is unknown.
Reuse the `generatorSource` gates exactly as the fold applies them (`load.ts:461-483`):
`emissionsIntensity` must be finite for *any* factors to apply, `pricePerKwh` is gated
**independently**, `renewableFraction` defaults to 0. If that resolution is duplicated rather than
shared, the runs table will silently disagree with the Sankey the first time the fold's gating changes.

## Open questions

- **Source vs load determination per role** — how does a detector declare which side it sits on?
  Derivable from `role` today (`generator` = source), but that wants stating explicitly rather than
  inferred.
- **Which energy series to integrate** — the run's `energy_kwh` comes from the detector's
  `source_points.energy` point (`lib/run-tracking/energy.ts`), while the fold's `source.grid` comes from
  the `bidi.grid` flow series. If they are the same physical register the run cost reconciles with the
  Sankey exactly; if not, they differ by meter error. **Verify before claiming reconciliation.**
- **Renewable presentation** — kWh, or % of the run's energy?
- **Open (running) runs** — energy-so-far is real, so a partial figure is meaningful; confirm that's
  wanted rather than blank.
- **Reconciliation test** — the gate for this work: split a run's energy into unequal 5-minute slices,
  sum `slice × intensity_i`, and assert it matches the whole-run figure. That pins the claim that the
  per-run integral agrees with the fold.

## Related

- [config-v4-execution-plan.md](config-v4-execution-plan.md) — "Open follow-up — run-interval statistics
  assume the signal IS power", the sibling issue (fixed separately in the unit-honesty change).
- [../architecture/battery-provenance.md](../architecture/battery-provenance.md) — the fold, the
  off-grid-generator section, and how `source.grid` carries generator output.
