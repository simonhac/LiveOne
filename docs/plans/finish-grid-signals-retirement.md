# Finish the grid-signals retirement

> **Status:** proposed — not started (drafted 2026-08-01). Mined out of
> `docs/plans/dashboard-nested-tile-model.md` before that doc was deleted. That doc described the
> **v3** dashboard model, which config-v4 Phase 14 removed (`lib/dashboard/v3.ts` gone,
> `dashboards.descriptor` dropped by migration `0054`); none of its v3 machinery is carried forward.
> What survives is one unfinished half of a retirement it proposed — and the observation that config-v4
> made that half **cheaper**, not harder.

## Why

The grid-signals retirement was proposed as two halves: rename the card-type vocabulary so
`grid-signals` stops being a card, and delete the location-derived resolution path that decides
whether a site has one. The first half shipped. The second half not only did not ship — it was
**ported forward** through config-v4 Phase 13 and is now load-bearing in two more places than it was
when the retirement was written.

The result is a seam that contradicts the shipped design. Every other card's availability is a
property of what an area *contains*; grid-signals alone is a property of where the area *is*, resolved
by an inline server-render database walk that must be defensively wrapped so it can't 500 the
dashboard.

## Today

**Done — the vocabulary half.** `grid-signals` is not a card type. It is absent from `V4_CARD_TYPES`
([`lib/dashboard/card-types.ts:22-68`](../../lib/dashboard/card-types.ts)). `oe-grid` is a first-class
card type in its place — listed among the tile views at `:31`, registered as a tile plugin at
[`components/dashboard/registry.tsx:78`](../../components/dashboard/registry.tsx), and catalogued at
[`lib/capabilities/catalog.ts:142-148`](../../lib/capabilities/catalog.ts). The other rename in the
same batch (`grid` → `house-to-grid`) shipped too: `house-to-grid` is at `card-types.ts:27`.

**Not done — the resolution half.** [`lib/grid/context.ts`](../../lib/grid/context.ts) still exists,
and was actively maintained rather than deleted: `:57-59` carries a config-v4 Phase 13 PR 5 comment
explaining that the area is now located via `legacy_handles` rather than the dropped
`areas.legacy_system_id`, implemented as the inner join at `:60-65`. `resolveGridContextForDevice`
(`:45`) still does the full location walk — area location (`:68`) → `nemRegionForLocation` (`:71`) →
a grid-role point check (`:77`) → a lookup of the public OpenElectricity device serving that region
(`:81-90`). Its own comment at `:48-50` records that this "runs inline on the dashboard server
render" and must therefore swallow every DB fault, "never 500 the whole dashboard". Its result type
lives in [`lib/grid/types.ts:10-15`](../../lib/grid/types.ts).

**It is now load-bearing in two places, both in the capability layer.**
[`lib/capabilities/server.ts:90`](../../lib/capabilities/server.ts) mints the capability itself —
`if (await resolveGridContextForDevice(handle)) caps.add("grid-signals")` — and `:154` calls it a
second time to resolve `gridDeviceSystemId`, which becomes the `ctx.gridDevice` the strategy reads
([`lib/capabilities/strategy.ts:45`](../../lib/capabilities/strategy.ts)) to emit the card
(`:126-127`: `tiles.push(card("oe-grid", { device: ctx.gridDevice }))`).

**And it is the one deliberate exception to the capability model.** The registry says so at
[`lib/capabilities/registry.ts:26-27`](../../lib/capabilities/registry.ts): compound capabilities are
"a predicate over area config + external rows … (area location + a grid point + NEM region + a seeded
OE row → `grid-signals`), not a point-presence scan". The catalog repeats it at
[`catalog.ts:27`](../../lib/capabilities/catalog.ts). [`lib/capabilities/derive.ts:14`](../../lib/capabilities/derive.ts)
names the complete set of non-point-derived capabilities as exactly two: `generator-running` — which
is a predicate over an enabled run-detector derivation, i.e. still a property of the area's own
configured contents — and `grid-signals`, which is the only one that reaches outside the area
entirely, to a location and a globally-seeded public device.

**The consumer side already stopped caring about location.** The tile is bound to a device, not a
place: [`components/dashboard/tiles/oe-grid.tsx:9-12`](../../components/dashboard/tiles/oe-grid.tsx)
— "bound to a member OE region device. Reads the live price/emissions/renewables values from the
device's `latest`; the region label comes from the device's own `vendorSiteId` payload (no location
derivation)." It self-fetches, like every other tile. Only the *resolution* side still goes via
location. That asymmetry is exactly what makes this change cheap: the render target is already the
right shape, so there is nothing to rewrite downstream.

## The change

Make the OpenElectricity region device an ordinary **member of the area**, and let the capability
fall out of membership.

Concretely: seed an `area_members` row binding the area to the public OE region device that serves
its NEM region. `grid-signals` then derives the same way every other capability does — from the
member set and the members' own points — with no location lookup, no region derivation and no global
device search at render time. `lib/grid/context.ts` and `lib/grid/types.ts` are deleted, and the two
`resolveGridContextForDevice` calls in `lib/capabilities/server.ts` (`:90` and `:154`) go with them;
`gridDeviceSystemId` becomes "the OE member device, if any", read off the membership the resolver has
already loaded.

The cleanest way to state the rule: **the absence of the member IS the off-grid rule.** An off-grid
site simply has no OE region member, so it offers no `grid-signals` capability, so the strategy emits
no card and the picker greys the card out. There is no conditional-render branch, no off-grid
special case, no `if (!hasGridPoint) return null` — the three separate null-returns inside
`resolveGridContextForDevice` (`:66`, `:72`, `:78`) collapse into "not a member".

**This is cheaper now than when it was first proposed.** The original had to work around
`area_devices.system_id`, an integer with no foreign key. The shipped table is
[`area_members`](../../lib/db/planetscale/schema.ts) at `schema.ts:1032-1050`: `(area_id, device_id)`
as the primary key, both `uuid`, both with real `references(...)` and `onDelete: "cascade"`. A
membership row is now FK-clean and cannot dangle — strictly better ground than the proposal assumed.

## Risks / gotchas

**Seeding the member is a data write to production config, not a schema change.** No migration is
proposed here and none is approved. It still needs explicit approval before it is run, plus a dry-run
that prints the exact `(area_id, device_id)` pairs it would insert, because it changes what areas
*contain* — and area membership is an input to flow attribution, share scope and the strategy.

**Areas with existing flow history must not be disturbed.** Adding a member to an area that already
has `point_readings_flow_attr_1d` rows changes its resolved point set, which is the input to that
attribution. The OE region device's points are grid *signals* (price, emissions, renewable share),
not power flows, so they should not enter any flow role — but "should not" is the thing to prove
before writing, not after. If proving it is hard for a given area, that area does not get seeded.

**The `ownerUserId IS NULL` property matters.** The OE region devices are deliberately public and
ownerless ([`context.ts:88`](../../lib/grid/context.ts)). Making one a member of a privately-owned
area means a shared dashboard's read scope now transitively includes a public device's points. That
is fine — they are public — but the share-scope walk in `lib/dashboard/access.ts` should be checked
to confirm it yields the intended set and nothing wider.

**One device, many areas.** A single `NSW1` device will be a member of every NSW area. The
composite `(area_id, device_id)` PK handles that fine, but any code that assumes a device belongs to
"its" area should be looked at before, not after.

## Verification

This changes an area's resolved membership, so it must be gated by a **per-area resolved-point-set
parity assertion**: for every area, the set of `(system_id, point_id)` it resolves to must be
identical before and after the seed, except for the deliberate addition of the OE device's own
points. Nothing else may move.

The methodology to copy is
[`lib/capabilities/__tests__/strategy-equivalence.test.ts:1-13`](../../lib/capabilities/__tests__/strategy-equivalence.test.ts):
full serialized goldens, asserted case by case. That test's provenance is the precedent — the v4
strategy builder was proven to reproduce the v3 producer's output for every case *before* the v3
producer was deleted, and the assertion was then retired in the same PR because "there is only one
producer now". Do the same here: prove the membership-derived capability reproduces the
location-derived one for every real area, then delete the location path.

A sibling proposal, [area-point-set-parity-harness.md](area-point-set-parity-harness.md), is being
written to provide exactly this gate as a reusable harness. Use it rather than building a one-off.

Beyond parity: confirm an off-grid area (no OE member) emits no `oe-grid` card and no `grid-signals`
capability; confirm the tile renders identically for a seeded area, since it already reads the
member device rather than the location; and confirm the strategy goldens are unchanged for every
NEM area.

## Related

- [config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) — the design that made `area_members` the
  single, FK-clean membership table.
- [config-v4-execution-plan.md](completed/config-v4-execution-plan.md) — the epic record; Phase 13 PR 5 is
  where `lib/grid/context.ts` was ported forward instead of retired.
- [area-point-set-parity-harness.md](area-point-set-parity-harness.md) — the parity gate this change
  depends on.
- [../architecture/areas-and-dashboards.md](../architecture/areas-and-dashboards.md) — the area /
  dashboard layering `lib/grid/context.ts` still cites.
- [v4-dashboard-configurator.md](v4-dashboard-configurator.md) — the other proposal mined out of the
  same deleted doc; its picker is the surface where "no OE member ⇒ greyed-out card" becomes visible.
