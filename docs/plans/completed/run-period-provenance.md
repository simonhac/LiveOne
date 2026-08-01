# Per-run provenance — cost, emissions and renewable share for a run period

> **Status: SHIPPED — historical record.** Landed 2026-07-28 for producing (source-role) devices.
> `derived_intervals` carries `cost_c` / `emissions_g` / `renewable_kwh` (migration `0042`,
> expand-only), accumulated by the recompute rather than derived at render time — which is the
> decision that dissolved the original blocker, and the reason this doc is worth keeping.
>
> The **load-side** provider (EV, pump) was never built and is now tracked separately as
> [../load-side-run-provenance.md](../load-side-run-provenance.md). The "Still to do" section below is
> retained as the analysis that plan starts from.

## Context

A run period (`derived_intervals`) records what a device did between two timestamps — for Daylesford's
genset, ~30 min to 3 h with a known `energy_kwh`. The obvious next columns are **cost**, **emissions**
and **renewable share**: "what did that genset run cost me, and what did it emit?"

The obvious _implementation_ — `energy × constant`, computed when the table is rendered — is wrong
twice over: wrong about **where** the work belongs, and wrong for any device that isn't an off-grid
generator.

## What was built

**The run tracker accumulates provenance, exactly as it already accumulates energy.** Not a render-time
derivation. `recomputeIntervalsForWindow` (`lib/db/planetscale/derived-intervals-pg.ts`) already reads
the energy point's readings once per window for `assignEnergyToPeriods`; the provenance integral rides
that **same array**, so it costs no extra reads, and the read path is a plain column select.

This is what dissolved the original blocker. The first draft of this plan framed the problem as
render-time — one `buildAttributedFlowMatrix` per run, ~76 for a 30-day page, each seeding the fold,
"not viable in a table request". Moving the computation to the writer makes the question moot.

### The integral

```
costC        = Σ (sliceKwh × price(t))
emissionsG   = Σ (sliceKwh × emissionsIntensity(t))
renewableKwh = Σ (sliceKwh × renewableFraction(t))
```

`assignProvenanceToPeriods` (`lib/run-tracking/energy.ts`). The slices are the **energy counter's own
~1-minute steps**, not 5-minute flow intervals — which is strictly better than the original design:

- **Finer** than the fold's timeline.
- **No edge truncation.** `computeFlowAccounting`'s `window` only counts intervals lying _entirely_
  inside it (`lib/aggregation/flow-matrix-core.ts`), so a fold-based per-run figure would have
  systematically under-counted short runs by up to two intervals.
- **Reconciles with the run's own `energy_kwh` by construction** — same readings, same reset-safe
  forward-delta rule (a counter reset drops the negative step).

Each of the three accumulators is **independently null** when its factor is unknown across the run, so
a site with emissions but no configured price reports CO₂ and omits cost. NULL means unknown; the
column is then **absent** from the table, never rendered as `$0.00`.

### Which intensity — and how the side is decided

- **Producing device** (generator): the source-side intensity of the energy it produces. Off-grid that
  is the site's `generatorSource` triple — the same constants the battery-provenance fold substitutes
  for the OE/Amber grid signal, so a run and the Sankey price the same energy identically.
- **Consuming device** (EV, pump): the fold's **blended load-path** intensity at the moment of
  consumption. Not built — see [Still to do](#still-to-do).

**The side is already declared in code**: `RoleCategory` (`lib/roles/registry.ts`) is
`"source" | "load" | "bidi"`; `generator` is `source`, `ev` is `load`. The original open question
("how does a detector declare which side it sits on?") needed no new concept.

### One resolution, so runs and the Sankey can't drift

`resolveGeneratorIntensity` (`lib/battery-provenance/generator-source.ts`) is the **only**
implementation of the `generatorSource` gate — `loadProvenanceInputs` was rewritten to call it. The
rule: `emissionsIntensity` must be finite for _any_ factors to apply; `pricePerKwh` is gated
**independently** inside that; `renewableFraction` defaults to 0.

`resolveIntensitySeries` (`lib/run-tracking/intensity.ts`) finds the config in **two hops**, which is
not obvious and worth stating: a detector's own area is typically a device-level **area-of-one with no
bindings at all** (Daylesford's generator detector hangs off the Selectronic's area), while
`generatorSource` lives on the battery system named by the **site** area's `role=battery, metric=power`
binding. So: detector's area → its member devices → every area those devices belong to → that binding
→ that system's config. One place to configure; a site that prices its Sankey prices its runs.

### Units

| column          | unit           | display                                              |
| --------------- | -------------- | ---------------------------------------------------- |
| `cost_c`        | cents (signed) | `formatDollars` (divides by 100)                     |
| `emissions_g`   | grams CO₂      | `formatKgCo2(g / 1000)`                              |
| `renewable_kwh` | kWh            | `formatRenewablePct(100 × renewableKwh / energyKwh)` |

Footer totals sum only the runs that carry a figure; the renewable-% denominator is
`renewableKnownKwh` (the energy of just those runs), so a partially-priced window reports the share of
what it actually knows rather than diluting it with unknowns.

## Operating it

### Re-pricing history

A persisted figure is priced at the constants **in force when the run was recorded**. Change
`generatorSource` and history keeps the old price until you re-run the recompute — at which point the
runs table would otherwise silently disagree with the (always re-folded) Sankey.

```bash
curl -X POST https://liveone.energy/api/cron/derivations \
  -H "Authorization: Bearer $CRON_SECRET" -d '{"action":"regenerate","start":"…","end":"…"}'
```

> ⚠️ **Never regenerate over all history.** The recompute re-detects from the CURRENT signal point, so
> any window predating a detector re-point is rebuilt from a signal that has no data there — the runs
> are **deleted, not re-priced**. Daylesford's detector moved to DSE Engine Speed on 2026-07-27 and
> that point only has data from 2026-07-11; a full-range regenerate on dev collapsed 71 rows to 3.
> Bound `start` to the current signal's data window. Older runs simply keep NULL provenance — which is
> consistent. (The original clause here said their `avgSignal` was already suppressed by the
`detector_version` unit gate — that gate was **retired** by migration `0055`, which put `signal_unit`
on each row instead. The regenerate warning above still stands; only its footnote was stale.)

### Backfill after the migration

Migration `0042_derived_intervals_provenance` is expand-only (three nullable columns). Existing rows
carry NULL until a recompute rewrites them, so run `regenerate` over the current signal's window.

## Still to do

**The load-side provider.** `resolveIntensitySeries` returns null for a `load`-category role, so an EV
or pump detector gets no provenance columns at all. Making it work needs a **time-varying**
`IntensitySeries` — the integrator already accepts one and is tested against one, so this is a change
to the provider only:

- There is **no per-interval, per-load blended intensity anywhere today**. The load blend only
  materialises as an aggregate inside `computeFlowAccounting`; the persisted `bidi.battery/*` blend
  points are the _battery's_ contents, not a load path.
- Grid/solar intensities are not persisted either (grid comes from separately-bound OE/Amber points,
  the generator override is config-only), so a provider would still have to reassemble them —
  essentially `loadProvenanceInputs` + `buildSourceIntensities`.
- Watch the off-by-one: fold step `i` covers `[timeline[i], timeline[i+1]]`, `computeFlowAccounting`
  reads intensity at index `i`, but `writeBlendOutputs` stamps `interval_end = timeline[i+1]`.

Also open:

- **Renewable presentation** ships as a % of run energy. For a diesel generator that column is `0%` on
  every row — accepted deliberately; revisit if it stays noise.
- **Reconciliation with the Sankey** is close but not exact: the run integrates the energy point's
  counter deltas, while the fold's `source.grid` trapezoid-integrates the `bidi.grid` power series.
  Same physical register, different integration — do not claim exact agreement.

## Related

- [../architecture/battery-provenance.md](../../architecture/battery-provenance.md) — the fold, the
  off-grid-generator section, and how `source.grid` carries generator output.
- [config-v4-execution-plan.md](config-v4-execution-plan.md) — the sibling "run-interval statistics
  assume the signal IS power" issue, fixed in the unit-honesty change.
