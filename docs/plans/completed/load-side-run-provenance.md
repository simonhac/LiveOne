# Load-side run provenance — pricing an EV or pump run

> **Status:** SHIPPED 2026-08-01, alongside EV charge-session tracking at Kinkora. Split out of
> [run-period-provenance.md](run-period-provenance.md), which shipped the generator (source-role)
> side on 2026-07-28. The design below is what was built; **"What actually shipped"** at the end
> records the two places the implementation departed from it, both found by measuring.

## Why

A run period for a producing device is priced. A run period for a consuming device is not — at all.
`resolveIntensitySeries` returns null for a `load`-category role, so an EV or pump detector produces
rows with no `cost_c`, no `emissions_g` and no `renewable_kwh`. The columns are absent, not zero, which
is the right failure mode but is still a hole: the whole point of run tracking on a load is to answer
"what did that charge session cost me?", and today it cannot.

The gap is deliberate and documented rather than accidental. `lib/run-tracking/intensity.ts:16-21`
states it in the module doc:

> a CONSUMING device (`ev`, and `pump` when it lands) → the fold's BLENDED load-path intensity at the
> moment of consumption: solar vs battery vs grid, moving every 5 minutes. That series does not exist
> per-interval anywhere today (the load blend only materialises as an aggregate inside
> `computeFlowAccounting`), so this returns null and the columns stay absent. Applying a generator's
> OUTPUT constants to a load would price consumption at the genset tariff — wrong, not approximate.

That last sentence is the reason this was not bodged at the time, and it still holds.

## Today

The resolver is [`lib/run-tracking/intensity.ts`](../../../lib/run-tracking/intensity.ts). Its first
executable line is the whole story — `intensity.ts:81`:

```ts
// Enumerated, not inferred — see the module doc on why `category === "source"` is the wrong gate.
if (det.role !== GENERATOR_ROLE) return null;
```

Only `generator` gets past it, and it resolves via `resolveGeneratorIntensity`
(`lib/battery-provenance/generator-source.ts`) wrapped in `constantIntensity`
(`intensity.ts:67-69`) — the site's configured `generatorSource` triple, the same constants the
battery-provenance fold substitutes for the grid signal, deliberately shared so the two cannot drift.

It is wired into the recompute at
[`lib/db/planetscale/derived-intervals-pg.ts:88`](../../../lib/db/planetscale/derived-intervals-pg.ts)
(resolved once per call, outside the transaction, and skipped entirely without an energy point) and
consumed at `derived-intervals-pg.ts:161` by `assignProvenanceToPeriods`.

**The storage already exists and is nullable.** `derived_intervals`
([`lib/db/planetscale/schema.ts:806`](../../../lib/db/planetscale/schema.ts), renamed from
`device_run_periods` per the comment at `:804`) carries `costC` at `:842`, `emissionsG` at `:843` and
`renewableKwh` at `:844`, all `double precision` and all nullable. They were added by migration
`0042_derived_intervals_provenance`, which is expand-only — three
`ADD COLUMN IF NOT EXISTS` statements, nothing else. **No new migration is needed for this work**, and
none is proposed here: this is a provider-only change. (Any schema change would need explicit approval
first; there is nothing to approve.)

**The integrator is already ready for a time-varying series.** `assignProvenanceToPeriods`
([`lib/run-tracking/energy.ts:93-98`](../../../lib/run-tracking/energy.ts)) takes an `IntensitySeries`
whose `at(tMs)` is sampled per counter slice, and
[`lib/run-tracking/__tests__/energy.test.ts:107-145`](../../../lib/run-tracking/__tests__/energy.test.ts)
("is slice-decomposable: unequal slices sum to the whole-run figure") drives it with a price that
**steps mid-run** over deliberately uneven slices and asserts the parts sum to the whole. The test
comment names this explicitly as "the regression guard for the day a time-varying (load-side blend)
series lands". So the integrator side of this feature is built and tested; only the provider is
missing.

**Why the provider is the hard part.** There is no per-interval, per-load blended intensity persisted
anywhere. The load blend only materialises as an aggregate inside `computeFlowAccounting`
([`lib/aggregation/flow-matrix-core.ts:144`](../../../lib/aggregation/flow-matrix-core.ts)) — it is
computed, consumed, and discarded. The persisted `bidi.battery/*` blend points are the *battery's*
contents (what is in the battery right now), not a load path. Grid and solar intensities are not
persisted either: grid intensity comes from separately-bound OE/Amber points, and the generator
override is config-only. So a load-side provider cannot read a series off a table; it has to
**reassemble** one — essentially the pair
[`loadProvenanceInputs` (`lib/battery-provenance/load.ts:286`)](../../../lib/battery-provenance/load.ts)
plus
[`buildSourceIntensities` (`lib/battery-provenance/compute.ts:87`)](../../../lib/battery-provenance/compute.ts),
run over the run's window, with the per-step load-path blend surfaced rather than folded away.

## The change

Implement `resolveIntensitySeries`'s consuming-device leg as a **second provider**, leaving the
generator leg untouched and the enumeration explicit (still not `category === "source"`, for the reason
the module doc gives: `solar` is a source role too, and a solar detector priced at the site's diesel
rate would be silently, badly wrong).

The shape:

1. Extend the enumeration in `intensity.ts` from one role to a small set — `ev`, and `pump` when it
   lands — routed to a new `resolveLoadIntensity`.
2. That provider resolves the detector's area to the site area whose bindings the fold uses (the same
   two-hop walk the generator leg already does: detector's area → member devices → sibling areas → the
   `role=battery, metric=power` binding, ordered by `ordinal` then `areaId`), then calls
   `loadProvenanceInputs` for the run's window and `buildSourceIntensities` over it.
3. It returns an `IntensitySeries` backed by the per-step blend — a sorted step array with a
   binary-searched `at(tMs)`, not a constant. Because `IntensitySeries.at()` already takes epoch-ms
   (`intensity.ts:58-64` says so in as many words: "so a future per-interval implementation (the
   load-side blend) drops in without touching the integrator"), nothing downstream changes.
4. Unknown stays null. A window with no fold inputs, or a site with no bindings, returns null and the
   columns stay absent — never a zero, never a fallback to some other device's constants.

Cost note: the generator leg is one small config read, resolved once per detector per recompute. The
load leg is a fold over the run window, which is materially more expensive — it should be resolved per
recompute call over the recompute's window (not per run, and certainly not per slice), and the existing
"resolved once, outside the transaction" placement at `derived-intervals-pg.ts:86-89` is the right seam
for that.

## Risks / gotchas

**The off-by-one, carried verbatim from the parent doc because it is the specific trap this work will
hit:** fold step `i` covers `[timeline[i], timeline[i+1]]`, `computeFlowAccounting` reads intensity at
index `i`, but `writeBlendOutputs` stamps `interval_end = timeline[i+1]`. A provider that indexes the
reassembled series the way the *persisted* blend points are stamped will be one step out from the way
the fold *computed* them, and a one-step error in a 5-minute series is invisible in aggregate and wrong
in every individual run.

**Renewable share ships as a % of run energy.** For a diesel generator that column reads `0%` on every
row — accepted deliberately when the source side shipped. Revisit only if it stays noise; on the load
side the same column becomes genuinely informative (a charge session that ran on solar), so the
presentation may want revisiting anyway.

**Reconciliation with the Sankey is close but not exact, and must not be claimed otherwise.** The run
integrates the energy point's counter deltas; the fold trapezoid-integrates the `bidi.grid` power
series. Same physical register, different integration. Expect agreement to a fraction of a percent, and
do not write a test that asserts equality.

**`regenerate` deletes, it does not re-price.** A recompute re-detects from the *current* signal point,
so a window predating a detector re-point is rebuilt from a signal with no data there and the runs are
deleted rather than re-priced. Daylesford's detector moved to DSE Engine Speed on 2026-07-27 and that
point only has data from 2026-07-11; a full-range regenerate on dev collapsed 71 rows to 3. Bound
`start` to the current signal's data window. (The parent doc still describes this accurately at
`completed/run-period-provenance.md:101-105`; its trailing remark about `detector_version` gating the
statistic is now stale — migration `0055` put `signal_unit` on the row and retired that gate, per
`schema.ts:827-837`.)

**Dev writes revert.** The 2-hourly prod→dev sync is an UPSERT, so provenance written on `liveone-dev`
over prod-existing `derived_intervals` rows reverts within two hours. Validate the numbers on dev, but
expect to re-run after any sync, and land the real backfill against prod.

## Verification

The slice-decomposability test at `lib/run-tracking/__tests__/energy.test.ts:107-145` is already the
gate for the integrator; the provider needs its own equivalent — a unit test that the reassembled
series steps at the fold's boundaries and samples the value the fold used, driven off a fixture
timeline, so the off-by-one above is caught by construction rather than by eyeballing a chart.

End to end: pick a real EV detector, run a bounded `regenerate` over a window well inside the signal's
data range, and compare the run's `cost_c` against the same window's load cost from the Sankey — close,
explicitly not equal, with the residual explained by the integration difference above. Then confirm a
site with no battery binding still yields NULL columns rather than a number.

No migration, so no DDL to apply and no schema approval to seek.

## What actually shipped

Two departures from the plan above, both found by measuring rather than by reading:

**1. The fold already returns the per-source intensities.** The plan proposed calling
`loadProvenanceInputs` + `buildSourceIntensities`. In fact `computeBatteryProvenance` builds that
array itself to drive `computeFlowAccounting` and returns it on `ProvenanceResult.sourceIntensities`
(`lib/battery-provenance/compute.ts`). So `resolveLoadIntensity` reads the very array the Sankey
attributed with, and does not re-derive solar/grid/battery factors at all.

**2. The off-by-one has TWO halves, and the plan only named one.** Which sample belongs to which
interval is as described (index `i`, the fold's convention, not `interval_end`). But *which interval
a timestamp lands in* does not follow from it: `assignProvenanceToPeriods` prices each counter slice
at its **later** reading, so the step lookup must be **right-closed** — the interval that ENDS at or
after `tMs`. A left-closed lookup is correct for every slice strictly inside an interval (most of
them, which is why it survives casual testing) and jumps a step for any slice ending exactly on a
5-minute boundary. Both halves are pinned by tests in `lib/run-tracking/__tests__/energy.test.ts`.

Also worth recording:

- The allocation weights are no longer duplicated. `sourceWeightsForInterval` was extracted from
  `computeFlowAccounting` (`lib/aggregation/flow-matrix-core.ts`) and is now called by both, so a
  run's cost and the Sankey's cost for the same kWh cannot drift. It returns `anyExact` too — the
  kWh-vs-kW switch is set by scanning sources AND loads, so the blend must be told about the loads
  even though it only reads source weights.
- Resolution is **lazy and run-windowed**, not "once per recompute call". The series is resolved
  only when a pass actually detected periods, over the span of those periods — so an idle minutely
  pass does no fold at all, and a busy one folds hours rather than the whole 6h window. It reads on
  the pool rather than the recompute's transaction (a read-only side query that cannot deadlock
  against it). The plan's suggestion to hoist the whole read/detect phase out of the transaction was
  NOT taken: the anchor lookup has to stay under the advisory lock or the bounded
  delete-and-reinsert loses its invariant.
- The requested window is padded by one fold interval either side, so the timeline brackets the runs
  and a run's first counter slice does not fall before `timeline[0]` and price at null.

**Measured against the Sankey** (`point_readings_flow_attr_1d`, `load_path='load.ev'`, Kinkora, 13
days): energy agrees within 1.6%, cost within 4.8%, emissions within 2.7% — the expected residual
from counter-delta vs trapezoid integration. One day (2026-07-15) showed −52%, traced to a data hole
in the dev mirror's own readings for that day, NOT a defect: dev's raw counter and its `agg_5m` both
say 3.38 kWh and the run says 3.33, while `flow_attr_1d` carries prod's complete 6.89. See
[dev-mirror-blind-to-prod-backfills].

> 🛑 **CORRECTION (2026-08-02) — the paragraph above read a real defect as noise, and the paragraph
> above THAT is the reason it existed.**
>
> "The expected residual from counter-delta vs trapezoid integration" cannot be right, and the shape
> of the numbers says so: integration basis moves *energy*, not an *intensity*. A 1.6% energy
> agreement alongside a 4.8% cost disagreement is not one phenomenon, it is two.
>
> What was actually happening: **the one-fold-interval padding is not a warm-up, and this leg needed
> one.** `computeBatteryProvenance` is stateful — the battery's blend at any instant depends on every
> interval since the last reset — so a fold started five minutes before a run begins with an empty
> store and seeds the whole blend from the SITE FALLBACK, which is the grid's instantaneous intensity
> and price (`fold.ts`). It never washes out, and discharge is provenance-neutral, so the wrong blend
> rides the entire session. Worst observed case: a Kinkora EV session on 2026-08-01 supplied **100% by
> a solar-charged battery** (solar 1 W, grid exporting, battery discharging 7.2–7.8 kW) was booked at
> **33.7 c/kWh and 742 gCO₂/kWh** — the grid import rate of the minute the fold happened to start. The
> engine's own persisted blend for those very intervals read 0.94 c/kWh and 107 gCO₂/kWh.
>
> Fixed by deleting the fold from this leg entirely: `resolveLoadIntensity` now reads the engine's
> per-interval `bidi.battery/*` points (`lib/battery-provenance/persisted-blend.ts`) and blends them
> with the same stateless `blendLoadIntensities`. `WarmProvenanceInputs` +
> `scripts/check-warm-fold-boundary.mjs` make the original mistake unrepresentable rather than merely
> discouraged. The energy half was separately wrong — see the counter-partition note in
> `lib/run-tracking/energy.ts`.
>
> **Lesson worth keeping:** this cross-check was run, it did show the defect, and it was explained
> away — because it was a one-off measurement written into a doc rather than a test. The regression
> guards now live in `lib/run-tracking/__tests__/energy.test.ts` and
> `lib/battery-provenance/__tests__/persisted-blend.test.ts`.

## Related

- [run-period-provenance.md](run-period-provenance.md) — the shipped source-role
  side; the record this plan was split out of.
- [../../architecture/battery-provenance.md](../../architecture/battery-provenance.md) — the fold, the
  off-grid-generator section, and how `source.grid` carries generator output.
- [../../../lib/run-tracking/intensity.ts](../../../lib/run-tracking/intensity.ts) — the module doc there is
  the authoritative statement of *what prices a device's energy* and why the gate is enumerated rather
  than inferred; this plan added a leg to it, it did not revise it.
