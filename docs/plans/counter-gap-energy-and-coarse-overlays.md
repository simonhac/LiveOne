# Counter-gap energy loss, and coarse-cadence energy overlays

> **Status:** proposed — research first, no code written (drafted 2026-08-03). Both items were found
> while investigating the five days that still disagreed with the meter after the `flow_attr_1d`
> first-interval fix (#353). The third finding from that investigation — the allocation numerator
> being asymmetric with its denominator — was a confirmed live defect and shipped separately with
> `FLOW_ATTR_VERSION` 7; this doc is the remainder. Neither item here is a flow-matrix defect, and
> neither should be started before the research in §0.

## Why this exists

Verifying #353 compared `point_readings_flow_attr_1d.energy_kwh` for `load.ev` against a
`Σ greatest(delta, 0)` baseline on the EV counter (`points.rid = 50`, Kinkora Mondo). Four of the five
residual days are explained by things that are **not** the matrix being wrong:

| day | rows | non-null `delta` | Σ`delta` | attr | diff | cause |
|---|---|---|---|---|---|---|
| 2026-04-16 | 287 | 286 | 22.350 | 24.2436 | +1.8936 | counter gap (§A) |
| 2025-10-06 | 284 | 282 | 7.290 | 9.7411 | +2.4511 | counter gap (§A) |
| 2025-11-24 | 287 | 286 | 9.452 | 9.4696 | +0.0176 | counter gap (§A) |
| 2026-08-02 | 288 | 288 | 12.532 | 12.5320 | 0.0000 | none — was an incomplete day when measured |

The **baseline** is what is short on the first three, not the matrix. That is §A. §B is a separate
distortion found while reading the same code path — invisible to a meter comparison because it
conserves energy, so nothing in the #353 verification could have caught it.

## What is already settled — do not re-derive

Measured on `liveone-dev`, 2026-08-03. Area `019ec06c-f829-76ea-9427-32552b2a9248` (Kinkora Unified,
handle 8, fixed +600 min).

**§A mechanism, confirmed end to end.** `previousLast` is read only from the *immediately preceding*
5-minute interval's raw (`lib/db/planetscale/aggregate-points-pg.ts:186-232`); with no raw poll there,
`aggregate5mForPoint` returns `delta = null` (`lib/aggregation/point-aggregates.ts:82`). So one missed
poll costs `delta` **two** intervals — the missing one (no row) and the next one (null).

- 2026-04-16: rows at 02:00 and 02:10, none at 02:05. `last` goes 18011500.6 → 18013386.6 Wh, so
  **1.886 kWh really flowed** and `Σ delta` books none of it.
- The raw is genuinely absent, not merely un-aggregated: `point_readings` for rid 50 jumps
  01:59:16 → 02:06:51 (Mondo polls ~2-minutely). **So this cannot be fixed by re-aggregating.**
- The matrix falls back to the trapezoid over the widened 10-minute interval —
  `(11359.865 + 11362.856)/2 × 1/6 h = 1.8936 kWh`, within 0.4 % of the true counter difference. On
  2025-10-06 (holes at 00:15 and 00:45–00:55) the true loss was 2.070 kWh and the trapezoid recovered
  2.451 kWh, 18 % over, because the charger was duty-cycling through the hole.

**§A blast radius.** 786 null-delta rows across 21 `transform='d'` points in 365 days:

| gap | occurrences |
|---|---|
| 1 missed poll (10 min) | 456 |
| 2–3 missed (≤20 min) | 72 |
| ≤1 h | 129 |
| ≤1 day | 111 |
| >1 day | 18 |

Σ of `last − prev_last` across those rows: Kinkora EV 4.3 kWh; Daylesford Solar 953.7 kWh; Craig
Export 263.8 kWh. **The count is in the short gaps, the energy is in the long ones** — a single
Daylesford Solar row spans 910 kWh.

**A dead end, already closed.** Six rows (all Nov 2025, none since) are null-delta with the previous
5-minute row *present* and its raw committed in time — i.e. `prevLast` was available and `delta`
should have been 0. Almost certainly the pre-PG writer. It is historical, not a live second mechanism;
do not spend time on it.

**§B mechanism, confirmed in code, magnitude not yet quantified.** `attachEnergyOverlays` sums every
register targeting a node, with null-poisoning (`lib/aggregation/flow-series.ts:398-416`), and
`energyPoints` is an unfiltered `filter` over the area's resolved points with no priority or dedup
(`lib/aggregation/logical-system.ts:117-129`). At Kinkora, `source.grid` receives **two**: Fronius
`bidi.grid.import` (rid 47, 5-minute) and Amber `bidi.grid.import` (rid 75, **30-minute**) — the same
grid connection, metered twice, both bound (`area_bindings` grid/energy at priority 0 and 1).

So `source.grid`'s overlay is **null in 5 of every 6 intervals** (Amber absent → null-poisoned) and at
the sixth is `fronius_5min + amber_30min` (2026-08-01 02:30 → 19 + 38 Wh; 03:00 → 43 + 75 Wh). The
grid's weight in the allocation is therefore inflated in one interval of six and falls back to power
in the rest. Day totals are unaffected (the shares still sum to 1), which is why the meter comparison
was blind to it.

Corroborating, **not** conclusive: on 2026-08-01 the matrix attributes **21.705 kWh** to `source.grid`
against a metered import of **20.794 kWh** (Fronius) / 20.104 kWh (Amber) — 4.4 % over, with solar and
battery correspondingly under. All imported energy is consumed somewhere, so those two numbers should
agree; but part of that gap may have other causes.

## §0 — Research to do first

Neither §A nor §B should be implemented before these are answered. Each one can change the choice.

1. **Re-measure §A's distribution on prod, not dev.** The dev mirror never looks backwards, so it is
   blind to prod historical backfills (~9 % short on `agg_5m`). Mint a short-TTL read-only role
   (`--inherited-roles pg_read_all_data --ttl 1h`) and delete it after. The gap-length histogram is
   what decides whether a bounded lookback is worth having at all.
2. **Enumerate the consumers of `agg_5m.delta` and `agg_1d.delta` before changing either.** This is
   the gate on every §A option. Known so far: the flow overlay (`flow-series-pg.ts:197-213`),
   `sumDeltas`, and the energy cards. `lib/run-tracking/energy.ts` reads **raw** `point_readings`, not
   `delta`, so runs are already immune. Anything that treats `delta` as a 5-minute quantity is what a
   lookback would break.
3. **Are the long §A gaps already known outages?** Cross-check the >1 h gaps against the
   coverage-repair register (`docs/architecture/coverage-repair.md`). If they are outages the
   product already labels, filling them silently is worse than leaving them null and visible.
4. **Quantify §B properly.** Recompute one Kinkora day with the Amber energy registers excluded from
   `energyPoints` and diff the per-edge matrix. That isolates §B's real magnitude from the 0.911 kWh
   above, which is not attributable to §B without doing it.
5. **How many areas are affected by §B?** Find every area where two registers of different native
   cadence target the same flow node. If it is only Kinkora, a binding change may beat a code change;
   if it is general, the code change is the only honest fix.
6. **Does any area's grid node depend on a coarse register alone?** §B's leading fix removes the
   coarse register's overlay entirely, falling back to power integration. Harmless where a 5-minute
   sibling exists; a real (if acceptable) regression where it does not.

## §A — a missed poll deletes recoverable counter energy

Recoverable because `last` is intact on both sides of the hole. Lost from `agg_5m.delta`, therefore
from `agg_1d.delta`, therefore from every daily-energy surface. The flow matrix is **not** affected —
it already recovers this via power fallback.

| option | conserves energy | risk | notes |
|---|---|---|---|
| **A1. Bounded lookback** — let `previousLast` reach back up to N intervals in `recompute5mIntervalsWithin`, null beyond | yes, for gaps ≤ N | **high** | Mis-times the whole gap's energy into one 5-minute bucket. Two measured hazards: (a) the long tail would put 910 kWh in one bucket, so N must be small; (b) gaps are frequently **not** area-wide — point 50's gaps often contain other points' rows (2025-11-24: 5; 2025-10-20: 117) — and since the flow timeline is the **union** of all points' `interval_end`s, a gap-spanning `delta` landing on the last sub-interval would be double-counted against the power fallback used for the earlier ones. Needs §B's coverage guard first to be safe at all. |
| **A2. Fix the daily rollup only** — `agg_1d.delta` for `transform='d'` points becomes the odometer difference across the day, not `Σ` of the 5m deltas (`sumDeltas`, `point-aggregates.ts:147-158`) | yes, at the day grain | medium | Correct by construction at the grain that matters; leaves 5-minute semantics (charts, overlays, run detection) untouched; no `agg_5m` backfill. Two cases to handle explicitly: a **re-base inside the day** makes the difference negative → fall back to `Σ delta`; **missing boundary rows** leave a bounded sliver under-reported. Changes daily totals for every counter point, so it needs the §0.2 consumer list. |
| **A3. Document only** — record that `Σ delta` is not a conserving baseline across gaps and stop using it as ground truth | no | none | Cheapest, and it is the part that must happen regardless: this baseline is what made #353's verification report three false anomalies. |

**Leaning:** A3 unconditionally, then A2. A1 only if §0.1 shows the short-gap population is much larger
on prod than on dev *and* §0.2 turns up no consumer that reads `delta` as a 5-minute rate — and even
then, only after §B's coverage guard exists.

## §B — a coarse-cadence register should not decorate a fine-grained interval

| option | fixes double-count | fixes cadence | notes |
|---|---|---|---|
| **B1. Coverage guard** — a register's `delta` at slot `t` covers `(that point's previous interval_end, t]`; if that span is wider than the timeline interval it lands on, it is not an exact energy for that interval and must be `null` (fall back to power). Implemented where `energyKwhBySlot` is built, `flow-series-pg.ts:197-213` | yes, as a consequence | yes | One change fixes both halves: Amber's 30-minute register can never cover a 5-minute interval so it stops contributing, and with it gone `source.grid` is decorated by the Fronius register alone. Nothing area-specific, no binding change. Also the precondition that would make A1 safe. Cost: an area whose only grid meter is coarse falls back to power integration — what happened before overlays existed. |
| **B2. Prefer the finest-cadence contributor** instead of summing | yes | partially | Needs a notion of "same physical quantity" that `addContribution` does not have — summing is *correct* for Amber `.controlled` + `.import`, which are genuinely different circuits. Risks breaking that case. |
| **B3. Spread a coarse register across the intervals it covers**, in proportion to power | yes | yes, and strictly better than B1 | The right long-run answer — it keeps a coarse meter's exactness instead of discarding it. More work, and it needs a rule for what to do when the power sibling is missing inside the covered span. |
| **B4. Binding change only** — unbind the Amber energy registers at Kinkora | yes, here | yes, here | Not a fix: leaves the code able to do it again, and 🛑 a dev-side binding change reverts on the next 2-hourly prod→dev sync. Only meaningful applied to prod. |

**Leaning:** B1 now, B3 later if a coarse-only area turns out to matter. Do **not** do B4 alone.

## Sequencing

§A and §B are independent. §B touches the flow matrix and needs its own `FLOW_ATTR_VERSION` bump (8)
so `rehealStaleAttrDays` re-materialises history; §A touches neither the matrix nor its version. If
A1 is ever chosen, it lands **after** B1, not before.

## Related

- `docs/architecture/energy-flow-matrix.md` — the conservation invariant added with v7.
- `docs/incidents/2025-11-26-amber-import-channel-collision.md` — why Kinkora's Amber import channel
  has the history it does. Context only; not the cause of either item here.
- `docs/architecture/coverage-repair.md` — the existing gap-find/backfill machinery §0.3 checks against.
