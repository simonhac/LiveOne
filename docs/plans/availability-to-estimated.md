# Availability → estimated — a missing input degrades to a labelled estimate, never a silent null

> **Status:** proposed — not started (drafted 2026-08-01). Mined out of the retired
> `docs/plans/info-producers-consumers.md`, whose model was nominally absorbed into
> [config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) §4.3–4.4. That plan's P2 decision —
> "define the staleness threshold that flips `available:false`" — was never made; this doc re-states
> the problem against the code as it stands and takes a position.

## Why

[config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) §4.3 promises that
"`available:false`/stale feeds the existing estimated-confidence channel — a missing source degrades
to best-effort, never a wrong fact." Two of those three words are load-bearing and only one of them
is implemented. `available` exists but means something much narrower than the sentence implies;
"stale" has no representation in the resolver at all; and a slot that resolves `absent` produces
silent nulls in the fold rather than a flagged best-effort result.

The failure mode this is meant to prevent is a number that is quietly wrong. A site whose Amber
price feed stops does not get a gap — it gets a forward-filled price, then nulls, then a Sankey that
looks the same as a healthy one. The confidence machinery to say otherwise already exists; it is
just not connected to availability.

## Today

**`available` means `points.active`, and nothing else.** In the explicit-binding branch the resolver
sets `available: explicit.point.active` (`lib/areas/resolution.ts:83`) and in the auto branch
`available: point.active` (`:99`), with `reason:"inactive"` attached in both cases when the flag is
off. `active` is a static registry flag on the `points` row. No timestamp, no reading, and no
staleness input reaches `resolveSlotsFromData` — its whole signature is
`(points, bindingRows, config)` (`resolution.ts:50-54`), and `ResolutionCandidate`
(`resolution.ts:33-39`) carries no recency field. So `available:true` today asserts only "this point
is registered and not disabled", which is compatible with it having last reported a value in March.

**The `estimated` channel already exists, and is better than the audit's framing suggests.**
`forwardFill` (`lib/battery-provenance/load.ts:155-178`) returns `{ value, estimated }` per timeline
slot and sets `estimated` in three distinct ways: when the value was carried forward beyond its
native interval (`:170`), when the source reading's own `data_quality` marker is unsettled
(`:171`), and when the value is older than `maxStaleMs` — in which case the value nulls out *and*
`estimated` is true (`:172-175`). So there is already a staleness threshold, already fused with
vendor quality. It is simply a **private constant of each fold call site** rather than a property of
the source: `SOC_FILL_MS = 30 min` (`load.ts:376`), `OE_FILL_MS = 15 min` (`load.ts:380`),
`RATE_FILL_MS = 35 min` against a `RATE_NATIVE_MS = 30 min` native interval
(`load.ts:387-390`). The resulting flags flow into `gridEmissionsEstimated` / `gridPriceEstimated`
(`load.ts:425, 430, 440, 446`, hard-set to `false` on the generator-source override at `:468, :473`)
and are OR-ed per source in `lib/battery-provenance/compute.ts:118-120`. Separately, `coverage`
(`load.ts:535-539`) reports a non-null fraction per series — a diagnostic, not an availability
declaration.

**There is real prior art for surfacing estimated-ness to the user, with a real vocabulary.**
`lib/data-quality.ts` defines `isSettledQuality` (`:30-32`) over an explicit `SETTLED_QUALITIES` set
(`:18-24`) — `good`, `actual`, `billable`, and Amber's abbreviated `a` / `b`. Its header comment
(`data-quality.ts:1-16`) records exactly why: most vendors write `"good"`, OpenElectricity bulk
history writes `"actual"` while its live path writes `"good"`, and Amber writes single chars
(`b`=billable, `a`=actual, `f`=forecast, `e`=estimated, `.`=unknown) and *never* writes `"good"` —
so comparing against the literal `"good"` flags every Amber-priced interval as estimated forever.
That set is the vocabulary; it should not be reinvented. Downstream, `pctEstimated` is computed in
`lib/energy-flow-matrix.ts` (`:214`, `:335`, `:429`, typed at `:135`, `:240`, `:355`) with the
rationale at `:123`, carried through `components/SiteChartsCard.tsx:898` and rendered as the
"% estimated" chip in `components/NodeTooltip.tsx:289-292`.

**What the resolver already knows that the UX does not show.** Beyond `inactive`, the resolver
distinguishes `mode:"absent", reason:"ambiguous", candidates:[…]` (`resolution.ts:104-115`) from
`reason:"missing"` (`:126-134`), and refuses to hide ambiguity behind a config fallback — a
behaviour pinned by `lib/areas/__tests__/resolution.test.ts:99-118`. These are precisely the states a
"why is this number an estimate?" affordance would want to name.

## The change

**Define staleness on the slot, not at the call site.** Add an optional `maxStaleMs` to
`ResolutionSlotDef` (`lib/areas/slots.ts:15-25`) so the catalog — which already owns each slot's
shape predicate and config producer — also owns its expected cadence. Seed it from the constants
that exist today so this is a move, not a redesign: 30 min for `battery/soc`, 15 min for the OE grid
slots, 35 min for the rate slots. Slots without a declared threshold get a default derived from the
5-minute serving grain, matching `forwardFill`'s `FIVE_MIN_MS` default (`load.ts:155-159`).

**Feed recency into the resolver.** Extend `ResolutionCandidate` (`resolution.ts:33-39`) with the
point's latest reading time, sourced from the KV latest-values cache in `resolveAreaSlots`
(`resolution.ts:155-182`) rather than a per-point query against `point_readings`. A slot whose chosen
producer is older than its `maxStaleMs` resolves `available:false` with a new
`reason:"stale"` alongside the existing `inactive` / `ambiguous` / `missing`. `available:true`
then means what its name says.

**Propagate into the existing channel, not a parallel one.** `available:false` must arrive at the
consumer as the same `estimated[]` boolean array `forwardFill` already produces, so that
`compute.ts:118-120`, `pctEstimated` and the NodeTooltip chip need no new concept. Concretely: a
stale or absent slot yields a series that is null-valued and `estimated:true` throughout, which is
exactly the shape `forwardFill:172-175` already emits past `maxStaleMs`. Nothing downstream learns a
second vocabulary; `isSettledQuality` remains the sole definition of "settled".

**Take a position on absent required slots.** A consumer must not silently emit nulls. The rule
proposed here: a slot the consumer declares **required** and that resolves `absent` fails the
computation loudly — the fold returns `null` for the window, as it already does for a missing
battery power binding (`load.ts:582`), and the reason is surfaced rather than swallowed. Every other
slot is **optional**, and an absent or stale optional slot produces a fully-`estimated` best-effort
series rather than a hole. The distinction is a property of the consumer, not the slot, because
`grid/rate` is required for pricing and irrelevant to autarky. Making it explicit is the point:
today the difference is expressed only by which `Array.find` result happens to be checked for
`undefined`.

**Surface the reason.** `reason` is already computed and already returned over
`/api/v4/areas/[id]/resolution`; the "% estimated" chip should be able to say *why* — stale feed,
inactive point, or ambiguous binding needing a choice — reusing the resolver's own words.

No schema change is proposed. The recency input is read from the existing KV latest-values cache and
`points.active`; if implementation shows a persisted per-point `last_seen` column would be better,
that is a separate proposal requiring explicit approval before any migration is generated (see
`CLAUDE.md`).

## Risks / gotchas

Making `available` recency-dependent makes the resolver's output **time-varying**. It is currently a
pure function of configuration, and `/resolution` is cacheable on that basis. Anything memoizing it
needs to know. Keep `resolveSlotsFromData` pure by passing recency in as data — do not reach for a
clock inside it, or `lib/areas/__tests__/resolution.test.ts` loses its determinism.

Amber's vocabulary is the trap that has already bitten once. `data-quality.ts:11-15` exists because a
naive `=== "good"` marked every Amber interval estimated forever. Any new code that inspects
`data_quality` must go through `isSettledQuality`, never a literal.

Thresholds that are too tight will paint healthy sites as estimated; vendor cadences differ per
device and per plan. Seed from today's constants — which are field-proven — and treat any tightening
as a separate, evidenced change.

The generator-source override deliberately sets `estimated:false` for constants it synthesizes
(`load.ts:468, 473`): a configured constant is a known fact, not a guess. That must survive — a
config producer resolving `available:true` is not an estimate.

`coverage` (`load.ts:535-539`) and `estimated[]` will now say overlapping things. Decide whether
coverage remains a diagnostic or is retired; do not let two numbers drift into disagreeing about the
same window.

## Verification

Unit-test the resolver's new state directly: a bound, `active` point whose latest reading predates
`maxStaleMs` must resolve `available:false, reason:"stale"` while keeping `mode:"explicit"` and its
producer id — staleness reports the source, it does not un-bind it.

Assert the propagation end-to-end on a fixture: an area whose grid rate feed stops mid-window must
produce `estimated:true` for every interval after the threshold and a `pctEstimated` that rises
accordingly through `lib/energy-flow-matrix.ts`, with no new flag introduced along the way.

Assert the required/optional split: a fixture missing a required slot must fail loudly (null window,
stated reason), and a fixture missing an optional slot must return a complete, fully-flagged
best-effort result — never a partially-null series that reads as real.

Pin the Amber vocabulary: a fixture priced from `b` (billable) intervals must **not** be flagged
estimated, which is the regression `lib/__tests__/data-quality.test.ts` already guards at the helper
level and which should now also be guarded at the slot level.

Confirm `lib/areas/__tests__/resolution.test.ts:99-118` still passes unchanged — the refusal to hide
ambiguity behind a config fallback is the invariant this plan builds on, not one it may relax.

## Related

- [fold-on-the-resolver.md](fold-on-the-resolver.md) — the other half of the same seam: making the
  fold consume the resolver at all, which is a prerequisite for availability reaching it.
- [config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) §4.3 — where the
  availability→estimated promise is written down.
- `lib/data-quality.ts` — the settled/provisional vocabulary this plan reuses rather than replaces.
