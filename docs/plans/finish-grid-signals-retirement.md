# Finish the grid-signals retirement

> **Status:** proposed — not started (drafted 2026-08-01). Mined out of
> `docs/plans/dashboard-nested-tile-model.md` before that doc was deleted. That doc described the
> **v3** dashboard model, which config-v4 Phase 14 removed (`lib/dashboard/v3.ts` gone,
> `dashboards.descriptor` dropped by migration `0054`); none of its v3 machinery is carried forward.
> What survives is one unfinished half of a retirement it proposed — and the observation that config-v4
> made that half **cheaper**, not harder.
>
> **Re-drafted 2026-09-14.** The original remedy — "make the OpenElectricity region device an ordinary
> member of the area" — was blocked by the device→0..1-area change and has been REPLACED, not merely
> annotated: a device is in 0 or 1 area (`devices.area_id`, migration 0071; `area_members` dropped by
> 0074), and an ownerless OE region is deliberately AMBIENT — consumed by every area in its NEM
> state, contained by none, and refused outright by `assertDevicesRehomable`.
>
> The DIAGNOSIS never needed changing: grid-signals is the one capability decided by where an area
> *is* rather than what it *contains*, and `lib/grid/context.ts` should go. The remedy is now an
> explicit **reference on the area** — Home Assistant's `areas.temperature_entity_id` shape — which
> keeps this plan's headline property (**the absence of the reference IS the off-grid rule**), drops
> the location derivation, and is strictly safer than membership because a pointer never enters the
> area's resolved point set. See "The change" below. Still not started.

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
and has been actively maintained rather than deleted — twice. Config-v4 Phase 13 PR 5 re-pointed the
area lookup at `legacy_handles` when `areas.legacy_system_id` was dropped; the device→0..1-area
change re-pointed it again (2026-09-14) at `devices.area_id`, because stopping the area-of-one mint
left a newly onboarded device with no handle→area leg at all and a re-homed one resolving its
shell's location instead of its site's. `resolveGridContextForDevice` still does the full location
walk — area location (`:68`) → `nemRegionForLocation` (`:71`) →
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

**🛑 And the AREA half of it has never worked — measured, not inferred.** `devicePlaysGridRole`
([`lib/grid/context.ts`](../../lib/grid/context.ts)) joins `points → devices` on `devices.rid`, so a
handle with no `devices` row matches nothing. Every area handle therefore resolves its location and
its NEM region correctly and then fails the grid-role check. On `liveone-dev`, 2026-09-14, handles
7 (Craig Unified), 8 (Kinkora Unified), 1000001 (Kuti House), 1000002 (Daylesford) and 1000003
(High Street Kew) all answer `grid-signals: false` — the Local Grid card has only ever rendered on a
DEVICE-addressed dashboard. That is a second, independent reason to delete this path rather than
repair it: the repair is "check the area's bindings", which is a product change (a card appears on
five dashboards that do not have one today) dressed as a bug fix, and this plan replaces the whole
resolution anyway.

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

Put an explicit **pointer on the area** at the OpenElectricity region device that serves it, and let
the capability fall out of that pointer.

This is Home Assistant's answer to the same problem, arrived at independently. HA areas carry
`temperature_entity_id` / `humidity_entity_id` — a named sensor the area **does not contain** — for
exactly the case where a reading belongs to a place without belonging to its inventory. Our OE NEM
regions are the same shape: `entry_type=SERVICE` producers consumed by every area in their state and
contained by none.

**The shape:** a `gridSignals` producer slot in `areas.config` holding the region device's `dv_…`
ref. Not a new column, because the area already has a producer-slot mechanism and this is one more
of them — `areas.config` carries `generatorSource` today, and the documented role-resolution chain
already ends `… → area config producer (areas.config: generatorSource, …) → absent`
([areas-and-dashboards.md](../architecture/areas-and-dashboards.md)). Adding a slot to a chain step
that exists needs no migration and no new authorization story. (A first-class
`areas.grid_signals_device_id uuid REFERENCES devices(id)` is the alternative and is better on
referential integrity — a jsonb ref can dangle where an FK cannot. Take it if the dangling ref turns
out to matter; it is a schema change and needs approval.)

`grid-signals` then derives from area config, with no location lookup, no region derivation and no
global device search at render time. `lib/grid/context.ts` and `lib/grid/types.ts` are deleted, and
the two `resolveGridContextForDevice` calls in `lib/capabilities/server.ts` (`:90` and `:154`) go
with them; `gridDeviceSystemId` becomes "the device the slot names, if any".

The cleanest way to state the rule is unchanged from the original draft, and it is why the shape is
worth the work: **the absence of the reference IS the off-grid rule.** An off-grid site names no
region device, so it offers no `grid-signals` capability, so the strategy emits no card and the
picker greys it out. There is no conditional-render branch and no off-grid special case — the three
separate null-returns inside `resolveGridContextForDevice` (`:66`, `:72`, `:78`) collapse into
"the slot is empty".

### Why not membership, which is what this plan used to say

The original remedy was an `area_members` row making the region device an ordinary member. That is
no longer representable and would be wrong if it were:

- **A device is in 0 or 1 area** (`devices.area_id`, migration 0071; `area_members` dropped by
  0074). One `NSW1` device cannot be a member of every NSW area — the composite PK the original
  draft relied on is gone, and with it the "one device, many areas" gotcha it listed.
- **`assertDevicesRehomable` refuses to place an ownerless device at all** (422, for every caller
  including an admin). That refusal is not incidental: placing an OE region in one area would TAKE
  IT OUT of nothing and put it somewhere no other area could reach, and nothing could free it again.
- **A reference is the honest description anyway.** An area does not *contain* the NEM. It reads it.
  The membership framing only ever looked right because membership was additive.

What carries over unchanged from the original draft is everything about what the reference BUYS:
the deletion of the location walk, the collapse of the three null-returns, and the off-grid rule.

### Seeding it

One-off, derived from what is already true rather than asked of the user: run today's
`resolveGridContextForDevice` over every area, write the device it resolves into the new slot, and
diff. An area whose slot matches what the walk would have returned is behaviour-identical by
construction — which is the whole gate (see Verification). Areas the walk declines become areas with
an empty slot, i.e. off-grid, which is what they already render as.

After that the slot is editable like any other area config, which is a small improvement on its own:
today an area in a state the postcode table maps wrongly has no override at all.

## Risks / gotchas

**Seeding is a data write to production config, not a schema change** (unless the column variant is
chosen, which needs approval). It still needs a dry run that prints the exact `(area, device)` pairs
it would write, because it changes what the strategy emits.

**A jsonb ref can dangle.** `areas.config` has no FK, so deleting a seeded OE device leaves a slot
naming nothing. The resolver must treat an unresolvable ref as an EMPTY slot (render no card), never
as an error — and `lib/integrity/ledger.ts` should carry an entry for it, since a dangling config
ref is exactly the class that census exists to name. The column variant makes this impossible
instead of merely handled.

**Existing flow history must not be disturbed.** This is where the reference shape is strictly safer
than the membership one: a pointer does not enter the area's resolved point set at all, so
`point_readings_flow_attr_1d` cannot see it. The original draft had to *prove* that grid signals
(price, emissions, renewable share) never entered a flow role; now there is nothing to prove.

**Share scope.** A shared dashboard rendering an `oe-grid` card reads a public, ownerless device's
points. That is fine — they are public — but `lib/dashboard/access.ts`'s walk should be checked to
confirm it yields the intended set and nothing wider, exactly as the original draft said.

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

- [config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) — the design that made membership
  single and FK-clean.
- [areas-and-dashboards.md](../architecture/areas-and-dashboards.md) — the role-resolution chain this
  slot joins, and the device→0..1-area change that forced the re-draft.
- [config-v4-execution-plan.md](completed/config-v4-execution-plan.md) — the epic record; Phase 13 PR 5 is
  where `lib/grid/context.ts` was ported forward instead of retired.
- [area-point-set-parity-harness.md](area-point-set-parity-harness.md) — the parity gate this change
  depends on.
- [../architecture/areas-and-dashboards.md](../architecture/areas-and-dashboards.md) — the area /
  dashboard layering `lib/grid/context.ts` still cites.
- [v4-dashboard-configurator.md](v4-dashboard-configurator.md) — the other proposal mined out of the
  same deleted doc; its picker is the surface where "no OE member ⇒ greyed-out card" becomes visible.
