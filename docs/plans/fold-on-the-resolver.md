# Fold on the resolver — make the deterministic slot resolver the fold's source selector

> **Status:** proposed — not started (drafted 2026-08-01). Mined out of the retired
> `docs/plans/info-producers-consumers.md`, whose model was nominally absorbed into
> [config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) §4.3–4.4. The resolver that plan
> describes was built; the "first consumer" half of it never was, so the analysis is re-stated here
> against the code as it stands rather than lost with the source doc.

## Why

[config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) §4.3 (lines 215–228) states the
intended model plainly: "One resolver, used by every consumer (fold, cards, derivations)", seeking
each `(role, metric)` slot as `explicit binding (lowest priority wins) → auto shape-match → area
config producer → absent`.

That is not what the code does. The resolver exists, is pure, is tested, and is served over HTTP —
and **no consumer calls it**. The battery-provenance fold, the one consumer the model was designed
around, still selects its inputs by hand with `Array.find` over a differently-ordered query. The
discrepancy is not cosmetic: the two orderings are keyed on different columns, so the `/resolution`
report and the fold can disagree about which point feeds a slot, and nothing in the system notices.

## Today

**What was built.** `resolveSlotsFromData` (`lib/areas/resolution.ts:50-136`) is a pure function over
candidate points, binding rows and area config. For each slot in the catalog it filters explicit
bindings by role, keeps only those whose stored `metricType` agrees with the point's own and whose
point satisfies the slot predicate, then sorts by `binding.priority` ascending with a `point.id`
lexical tiebreak (`resolution.ts:72-76`) and takes the first. Failing an explicit binding it
auto-connects a sole shape-match (`:89-103`), reports two-or-more as
`mode:"absent", reason:"ambiguous", candidates:[…]` (`:104-115`), and only then falls through to a
config producer (`:116-125`).

That precedence is backed by real storage. `area_bindings.priority` is a NOT NULL integer defaulting
to 0 (`lib/db/planetscale/schema.ts:714-716`) with a unique index
`area_bindings_slot_priority_unique` over `(area_id, role, metric_type, priority)`
(`schema.ts:730-735`), so a slot cannot hold two bindings at the same rank. `replaceBindings`
allocates priority per slot from array position when the caller omits it, rejects negatives, and
rejects in-payload duplicates (`lib/areas/create.ts:484-501`) before writing it (`create.ts:525`).
The behaviour is covered — `lib/areas/__tests__/resolution.test.ts:52-69` asserts the lowest-priority
binding wins over a higher-numbered one. The whole report is exposed at
`GET /api/v4/areas/[id]/resolution` (`app/api/v4/areas/[id]/resolution/route.ts`, 16 lines: it is a
thin auth-and-call wrapper, which is the point).

**What consumes it.** Nothing. `lib/battery-provenance/load.ts` loads bound points ordered by
`asc(areaBindings.ordinal)` (`load.ts:233`) — not priority — and then picks first-wins with
`Array.find`: battery power at `load.ts:371-373`, SoC at `:375`, and in the throughput loader the
power bind at `:579-581`, charge/discharge energy at `:592-597`, and SoC again at `:644`. Grid price
is the exception that proves the rule: `load.ts:437-450` iterates every rate binding and lets the
*last* one win, with a comment stating that this deliberately reproduces the original sequential
loop's behaviour.

**`ordinal` is not a slot order.** Unlike `priority` it has no unique index at all
(`schema.ts:713`); it is unique-per-slot only by the coincidence that `replaceBindings` writes
`ordinal: i` over the whole payload (`create.ts:519`). Other writers break the coincidence.
`registerBlendPoints` inserts server-managed helper bindings at `ordinal: 100 + i` and
`priority: 100 + i` (`lib/battery-provenance/register.ts:238-248`). The prod→dev sync conflict-keys
on the *priority* index, not ordinal (`lib/readings/prod-dev-sync.ts:344-347`). So the fold's
selector is sorted on a column no constraint defends.

**A deliberate contrary decision that must be addressed, not stepped over.**
`lib/run-tracking/intensity.ts:114-125` orders by `ordinal` with an explicit comment: "ORDINAL, not
priority — this must agree with the fold, which picks the battery device as the first
`role=battery, metric=power` of `boundPoints`, ordered by `ordinal` … Ordering by `priority` looks
equivalent and is not: the two columns are independent, so a site with two battery bindings could
price its runs off one device and its Sankey off the other." That reasoning is correct *given the
fold as it is*. This plan does not get to silently contradict it: moving the fold to priority
obliges the same move here, in the same change, or the comment's failure mode becomes real.

**The user-visible consequence.** Reordering sources in the Bindings tab rewrites `priority`
(`create.ts:484-490`, from array position) and therefore rewrites the `/resolution` report — while
the fold keeps consuming whatever `ordinal` happens to say. The editor's affordance and the
computation it appears to control are wired to different columns.

**Config-as-producer, half-built.** `ResolutionSlotDef.config` carries a key plus a validity
predicate (`lib/areas/slots.ts:21-24`), used for `grid/rate` (`:136-142`), `grid/export-price` with
the `hasValidatedExportTariff` gate (`:173-176`, gate at `:51-62`),
`grid/emissions-intensity` (`:183-189`) and `grid/renewable-fraction` (`:198-202`); the resolver
consults it only after point candidates (`resolution.ts:116-125`). The knobs are mirrored
device→area by `replaceBindings` (`create.ts:530-556`) and by
`syncAreaBatteryConfigFromDevice` (imported at
`app/api/admin/devices/[systemId]/config/route.ts:13`, called at `:198`). But the fold does not read
`areas.config` for them at all: it reads `ownerDeviceConfig(db, batteryBind.point)`
(`load.ts:414-416`, helper at `:254-265`) and hard-overrides the OE/Amber series *inside* an
`if (batteryBind)` block (`load.ts:452-476`). An area with a configured `generatorSource` but no
`battery/power` binding therefore silently gets no config producer, while `/resolution` cheerfully
reports `mode:"config"` for the same slot.

**The `TariffProvider` generalization that never happened.**
[battery-provenance-merge-handoff.md](completed/battery-provenance-merge-handoff.md) promised
`TariffProvider` would generalize into a `resolveInfoSources`-shaped seam. It did not.
`lib/battery-provenance/tariff.ts` is still the narrow instance — `TariffProvider:19`,
`ScheduleTariffProvider:43`, `resolveExportPriceSeries:97` — with exactly one caller,
`lib/battery-provenance/compute.ts:286`. The `grid/export-price` slot exists in the catalog complete
with its `exportTariff` config producer (`slots.ts:168-177`), but the fold never asks the resolver;
`exportTariff` is read straight off device config at `load.ts:458-461`.

**A binding-save gotcha worth recording.** `replaceBindings` deletes every binding for the area and
reinserts the payload (`create.ts:516-528`). The server-managed helper bindings at ordinal/priority
`100+i` survive an editor save only because `BindingsTab` seeds its row state from *every* binding
the aggregate returned (`components/area-builder/BindingsTab.tsx:55-60`) and posts them all back
(`:121-136`). On that round-trip they are renumbered to array-index `ordinal` and slot-derived
`priority`, losing the "helpers sort last" intent encoded by `100+i` — the editor deliberately does
not send `priority` (`BindingsTab.tsx:36-38`), so the server's counter reassigns it. The members
`PUT` got a server-side helper carve-out for exactly this hazard
(`app/api/v4/areas/[id]/members/route.ts:31`); the bindings `PUT` did not.

## The change

Make the fold the resolver's first real consumer, and delete its private selection logic.

Introduce a fold-facing accessor over `resolveSlotsFromData` that returns, per slot, the chosen
`PointId` (or config value) together with `mode` and `available`, reusing the existing query in
`resolveAreaSlots` (`resolution.ts:138-192`) rather than a second one. `load.ts` then asks for
`battery/power`, `battery/soc`, `battery/charge-energy`, `battery/discharge-energy`, `grid/rate`,
`grid/export-price`, `grid/emissions-intensity` and `grid/renewable-fraction` by slot name, and the
`Array.find` calls at `load.ts:371-375`, `:579-597` and `:644` go away.

Take a position on grid price. The last-wins loop at `load.ts:437-450` is not a rounding detail — it
is a different answer from the resolver's lowest-priority-wins. Either delete it in favour of the
resolver's single `grid/rate` pick, or keep it and write down, in the code, why this one slot
resolves differently from every other. This plan's recommendation is to delete it: the comment
justifies it as bug-compatibility with a loop that no longer exists elsewhere.

Move `lib/run-tracking/intensity.ts:114-125` to `priority` in the same change, replacing its comment
with the new invariant ("priority, agreeing with the resolver") rather than leaving a stale warning
that now describes the opposite of the truth.

Lift the config producers out of the `if (batteryBind)` block. `load.ts:452-476` should consult the
resolved `grid/rate`, `grid/emissions-intensity` and `grid/renewable-fraction` slots — which already
know how to fall back to `areas.config` — instead of gating the whole generator-source override on
the presence of a battery power binding. That is the fix for the "configured `generatorSource`, no
battery binding, silent no-op" divergence. Note that `areas.config` is populated by mirroring from
device config today; this change consumes the mirror, it does not remove it, so no schema work is
implied by this step.

Fold `resolveExportPriceSeries` behind the same seam: `compute.ts:286` should receive an
already-resolved export-price series or a `null`, chosen by the `grid/export-price` slot, so
`ScheduleTariffProvider` becomes an implementation detail of the config-producer branch rather than
a parallel resolution path. Generalizing `TariffProvider` into a named `resolveInfoSources`
abstraction is explicitly *not* required by this plan — one honest caller through the resolver is
worth more than a second framework.

Give the bindings `PUT` the helper carve-out the members `PUT` already has, so server-managed
bindings keep their `100+i` ranks across an editor save instead of being renumbered into the middle
of the user's list.

No schema change is proposed here. If the work uncovers a need to constrain `ordinal` (or to drop
it), that is a separate proposal requiring explicit approval before any migration is generated —
see the migration rules in `CLAUDE.md`.

## Risks / gotchas

The fold's outputs are persisted and user-visible (Sankey, provenance cards, `battery_provenance_daily`).
Changing which point feeds a slot changes numbers on real sites; any site whose `ordinal` and
`priority` orders disagree will move. Enumerate those sites before merging — the query is small
(bindings grouped by `(area_id, role, metric_type)` having more than one row) and the answer is
probably "none", which is exactly the answer worth having in writing.

`ordinal` still carries a second job: it stabilizes the legacy KV subscriber index
(`schema.ts:714-715` says so explicitly). Do not repurpose or renumber it as part of this change.

The helper bindings at `100+i` are ranked *after* everything a user can create, which is the
behaviour the fold's blend inputs rely on. Preserving that through the `PUT` carve-out matters more
once `priority` is load-bearing than it does today.

`resolveAreaSlots` takes both an area uuid and a legacy handle and falls back to the handle when an
area has no members (`resolution.ts:151-154`). The fold's throughput loader is handle-addressed
(`load.ts:570-576`). Keep those two agreeing, or an area-of-one resolves differently for the two
callers.

## Verification

Add a fixture area with two same-shape bindings in one slot at different priorities and assert that
the point the fold selects is byte-identical to the `producer.id` that `/api/v4/areas/[id]/resolution`
reports as `mode:"explicit"` for that slot. This is the assertion the whole plan exists to make true;
it should fail on `main` today.

Add the mirror-image case for config producers: an area with a validated `generatorSource` in
`areas.config` and **no** `battery/power` binding must produce the configured emissions/price
constants in the fold, matching `/resolution`'s `mode:"config"`, rather than falling through to the
OE/Amber series.

Assert explicitly on the grid-price path: either the last-wins loop is gone and a two-rate-binding
fixture resolves to the lowest-priority binding, or the retained behaviour is pinned by a test whose
name states the reason it differs.

Re-run the existing resolver suite (`lib/areas/__tests__/resolution.test.ts`) unchanged — the
resolver's semantics are not what is moving — and add a run-tracking case covering the
`intensity.ts` reorder, since its comment currently documents the failure the reorder is meant to
prevent.

Before and after, diff `battery_provenance_daily` for a representative multi-binding area over a
fixed window; a non-empty diff must be explainable by the priority order, not merely accepted.

## Related

A separate, smaller observation surfaced by the same audit and recorded here so it is not lost:
the capability registry and the slot catalog now describe overlapping shape vocabularies.
`CapabilityId` (`lib/capabilities/registry.ts:33-48`) and the derived `ATOMIC_CAPABILITY_RULES`
(`:169-174`, filtered from `CAPABILITIES` at `:87-166`) have no member for
`battery/charge-energy`, `battery/discharge-energy`, `grid/emissions-intensity` or
`grid/renewable-fraction`. Those shapes exist only as `exact()` predicates in `RESOLUTION_SLOTS`
(`lib/areas/slots.ts:107-118` and `:178-203`), while other slots delegate to the capability matcher
via the `capability()` helper (`slots.ts:37-46`). Two registries, one vocabulary, half-shared. Worth
resolving; **not** required by this plan, and deliberately out of its scope.

- [config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) §4.3–4.4 — the model this plan is
  trying to make true.
- [availability-to-estimated.md](availability-to-estimated.md) — the other half of the same seam:
  what a consumer does when a slot is unavailable.
- [battery-provenance-merge-handoff.md](completed/battery-provenance-merge-handoff.md) — where the
  `TariffProvider` generalization was promised.
