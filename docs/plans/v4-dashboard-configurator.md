# A configurator for the v4 dashboard document

> **Status:** proposed — not started (drafted 2026-08-01). Mined out of `docs/plans/dashboard-nested-tile-model.md`
> before that doc was deleted: it described the **v3** descriptor model, which config-v4 Phase 14
> removed outright (`lib/dashboard/v3.ts` is gone and migration `0054` dropped `dashboards.descriptor`).
> None of the v3 machinery is carried forward here — only the two ideas that survive the rewrite: that
> there is still no editor, and that the picker should be two-step and greyed-out rather than filtered.

## Why

A user can create a dashboard, rename it, re-slug it, share it and delete it. What they cannot do is
change what is **on** it. The document that a new dashboard is seeded with comes from the capability
strategy ([`lib/capabilities/strategy.ts`](../../lib/capabilities/strategy.ts)), and from that moment
it is frozen unless someone hand-writes a JSON body and `PUT`s it. Adding a card, removing one,
reordering two, or hiding one you don't care about are all "open a terminal" operations today.

This is not a regression that snuck in; it is a known hole. The v2/v3 "customize" editor was removed
during the dashboard rewrites and was never replaced, and the capability catalog says so out loud —
[`lib/capabilities/catalog.ts:31`](../../lib/capabilities/catalog.ts) notes that the gallery filters
`availableAreaCards`/`availableDeviceCards` "remain INERT until an Add-Card UI exists". The data
source for the picker was built; the picker was not.

## Today

**The renderer exists and the editor does not.** `components/dashboard/v4/` contains exactly one
file, [`node-view.tsx`](../../components/dashboard/v4/node-view.tsx) — a pure recursive renderer over
the v4 tree. [`components/DashboardSettingsDialog.tsx`](../../components/DashboardSettingsDialog.tsx)
is the only dashboard-editing surface, and it has **zero** references to the document, its nodes, or
cards (the only matches for "doc" in that file are `document.body` for the portal). It edits name,
slug and sharing. Nothing else.

**The write side is already built, server-only.** `PUT /api/v4/dashboards/[id]`
([`app/api/v4/dashboards/[id]/route.ts:52`](../../app/api/v4/dashboards/%5Bid%5D/route.ts)) takes a
whole document with an optional `If-Match: "<rev>"`, and returns `{ revision, doc, warnings }` plus
an `ETag` at `:92`, with a `412 revision-conflict` on a stale write at `:85-90`. (`PATCH` at `:98` is
**meta only** — name and slug; the doc goes through `PUT`.) A companion
`POST /api/v4/dashboards/[id]/validate` returns `{ valid, errors, warnings, normalized }` without
writing. In other words the transactional, optimistically-concurrent, validate-before-you-commit
half of a configurator is done and in production. What is missing is a UI that calls it.

**Hide is already a first-class concept.** `hidden?: boolean` is validated on both node kinds —
card at [`lib/dashboard/v4-validate.ts:76`](../../lib/dashboard/v4-validate.ts), group at `:89` — and
honoured at render by the `.filter((c) => !c.hidden)` in
[`node-view.tsx:273`](../../components/dashboard/v4/node-view.tsx). So the single most-wanted edit
("stop showing me this card") needs no model change at all: it is a checkbox that flips a boolean and
`PUT`s.

**The picker's data source is already built.** [`lib/capabilities/catalog.ts:84`](../../lib/capabilities/catalog.ts)
defines `NODE_CATALOG` — every known card type with a label, a scope (`area` or `device`) and a
`requires` capability predicate. `availableTilesFromCaps` (`:250`), `availableAreaCards` (`:257`) and
`availableDeviceCards` (`:266`) already answer "which cards can this area/device offer", in canonical
order, tiles first. The strategy consumes the same catalog to derive the default layout. A picker
does not need new derivation logic; it needs to call three functions that already exist and are
currently dead code outside the seed path.

**The model itself is small.** There are exactly two node kinds —
[`lib/dashboard/v4.ts:53-68`](../../lib/dashboard/v4.ts): a structural `group` (`direction`, `wrap`,
`heading`, `size`, `children`) and a `card` leaf. There is **one** compile-time render registry,
`CARD_RENDERERS` at [`components/dashboard/registry.tsx:68-91`](../../components/dashboard/registry.tsx),
total over `KnownCardType` by a `satisfies` gate (`:18`, `:91`), and one vocabulary in
[`lib/dashboard/card-types.ts`](../../lib/dashboard/card-types.ts) — 9 tile views (`V4_TILE_TYPES`,
`:22-32`), 11 non-tile card types (`V4_NON_TILE_CARD_TYPES`, `:47-59`), unioned into the 20
`V4_CARD_TYPES` at `:65-68` with `KnownCardType` at `:70`.

That is why this is markedly easier than it was under v3. Under v3 an editor had to understand
sections vs. tiles-containers vs. cards as three different things, with two registries and a
descriptor whose shape was per-type. Under v4 an editor manipulates one recursive tree with two node
kinds, adds a leaf whose type comes from one enumerated vocabulary, hides via a field that already
exists, and commits through a revision-checked endpoint that already exists.

## The change

Build an edit mode over the rendered document, in `components/dashboard/v4/`, that reads the
document, mutates it locally, and commits with `PUT` + `If-Match`. Four operations, in the order
they earn their keep:

1. **Hide / show** a node — flip `hidden`. Zero model change; already rendered correctly.
2. **Remove** a card — splice the leaf out of its parent's `children`.
3. **Reorder** — move a leaf within its parent's `children`. Layout in v4 *is* child order, so this
   is the whole of "move it up".
4. **Add** a card — the picker below.

The picker is the one design fragment worth carrying forward from the deleted doc: a **two-step
device → view** flow that **greys out unavailable options rather than hiding them**. Step one picks
the subject (the area, or one of its member devices); step two picks the view, listing the full
catalog for that scope with the ones whose `requires` predicate the subject does not satisfy shown
disabled, with the reason. Filtering unavailable cards away makes the product look smaller than it
is and gives a user no way to learn *why* their site can't show a card; greying out turns the picker
into a capability map.

Commit semantics should be: mutate a local draft, `POST .../validate` to surface warnings inline,
then `PUT` with the `If-Match` revision the page was loaded with, and surface the `412` as "someone
else changed this dashboard — reload".

### Sub-item A — `GroupNode.size` is validated, stored, and never read

`size` (the 12-column hint) is accepted by the validator on both node kinds
([`v4-validate.ts:77`](../../lib/dashboard/v4-validate.ts) and `:90`) and typed in the model, but the
renderer states plainly that it ignores it —
[`node-view.tsx:19`](../../components/dashboard/v4/node-view.tsx): "`GroupNode.size` (the 12-column
hint) is still unread here — layout is child order + group flow."

That is fine while the only author of documents is the strategy, which never sets it. It stops being
fine the moment a human can arrange cards: the first thing anyone asks for after "move this up" is
"make this one wider". So either the configurator ships with a width control and the renderer starts
honouring `size` on the 12-column grid, or the configurator ships explicitly width-less and `size`
stays a documented forward seam. Pick one deliberately rather than discovering it in review.

### Sub-item B — `TileFeature` has been inert through two model generations

[`lib/dashboard/card-types.ts:138-145`](../../lib/dashboard/card-types.ts) defines `tileFeatureSchema`
— a discriminated union of `sparkline` / `breakdown` / `flow-direction` / `toggle` — and `:147-151`
attaches it to every promoted tile type as `tileCardConfigSchema` (`{ features?: TileFeature[] }`),
applied to all nine tiles at `:275-284`. A repo-wide search for `TileFeature`, `TileCardConfig` or
`.features` finds **no reader**: every hit is inside `card-types.ts` itself, and the file's own
comments say so twice ("the `TileFeature` forward-seam union (inert today)", "just the inert features
list").

The argument for shipping it inert was that it costs nothing to carry and saves a second migration
later, and that argument has been **vindicated**: it round-tripped an entire model rewrite (v3
descriptors → v4 documents) for free, preserved verbatim, with no migration. But it has now been
inert across two model generations with no consumer, and unused vocabulary in a validated schema is a
liability once a UI exists that can emit it — a configurator that lets a user tick "sparkline" and
then renders nothing is worse than no checkbox.

So take a position with this work: either **wire it** (the configurator exposes features and the tile
plugins read them) or **delete it** (drop the union and the per-tile config, leaving the tiles bare).
"Leave it inert for another generation" is the one option this doc argues against.

## Risks / gotchas

The revision race is real but bounded: `PUT` is `If-Match`-gated and returns `412` with the current
revision, so the failure mode is a clear reload prompt rather than a silent clobber. Do not add a
merge strategy; this project has a single user.

Do not let the editor mint refs anywhere except the node envelope. Section §8.3 of the clean-sheet
model puts scope-bearing refs **only** in `node.area` / `node.device`, never inside `config`, and
share-scope is computed by one type-agnostic walk over exactly those positions (`collectRefs` in
`v4-validate.ts`). An editor that stashed a device id inside a card's `config` would silently break
the share boundary. The validator should be treated as the enforcement point, not the UI.

An unknown or unregistered card type does not crash — it takes the §8.4 labelled-placeholder branch
in the renderer. That is a useful property for a picker that can offer future types, but it also
means a bad type string fails quietly; surface `validate` warnings in the UI rather than trusting the
render.

### Already solved — do not redo

**Shared `?access=` views work on v4.** [`lib/dashboard/access.ts:8-15`](../../lib/dashboard/access.ts)
derives a share's read scope purely from the document's `ar_` envelope refs, and `:32-38` makes a doc
that fails the v4 shape guard resolve to an **empty** scope (fail-closed) rather than falling back to
a second document shape. The shared render path is live at
[`app/dashboard/[...slug]/page.tsx:282-289`](../../app/dashboard/%5B...slug%5D/page.tsx). An editor
must not weaken this, but it does not need to rebuild it.

**The per-section shared chart header and synced hover survived the rewrite.** The N→1 collapse of a
section's stacked-area `chart` cards plus its `sankey` into a single `SiteChartsGroup` is driven by an
optional `collapseKey` on the plugin contract —
[`cards/chart.tsx:41-49`](../../components/dashboard/cards/chart.tsx),
[`cards/sankey.tsx:10-13`](../../components/dashboard/cards/sankey.tsx) — consumed by the two-pass
collapse in [`node-view.tsx:202-206, 255-275`](../../components/dashboard/v4/node-view.tsx) and
rendered by [`cards/site-charts.tsx:4-6, 20-27`](../../components/dashboard/cards/site-charts.tsx).
The editor must be aware that hiding or removing one of a collapsed pair changes what the group
renders (`keys` drives `cardVisible`), but the mechanism itself needs no work.

## Verification

The catalog helpers already have a golden test —
[`lib/capabilities/__tests__/strategy-equivalence.test.ts`](../../lib/capabilities/__tests__/strategy-equivalence.test.ts)
pins `buildAreaStrategy`'s output per capability context — so a picker built on
`availableAreaCards`/`availableDeviceCards` inherits that coverage for "which cards are offered".

What needs new tests is the mutation layer: unit tests over pure `doc → doc` transforms (hide,
remove, move, add) asserting the result still passes `normalizeDocV4`, that node ids are preserved
across edits that don't create nodes, and that no transform ever writes a ref outside the envelope
(assert via `collectRefs` before and after). Then one end-to-end pass: seed a dashboard, add a card,
reload, confirm it renders; hide it, confirm the shared `?access=` view of the same dashboard also
stops rendering it and that its scope shrinks accordingly.

## Related

- [config-v4-clean-sheet.md](completed/config-v4-clean-sheet.md) — §8 is the normative description of the
  document model this configurator edits (§8.1 inheritance, §8.2 stored-vs-derived, §8.3 envelope
  refs, §8.4 unknown types).
- [config-v4-execution-plan.md](completed/config-v4-execution-plan.md) — the record of the epic that produced
  the shipped model and deleted v3.
- [../architecture/areas-and-dashboards.md](../architecture/areas-and-dashboards.md) — the
  three-layer physical/semantic/presentation split.
- [finish-grid-signals-retirement.md](finish-grid-signals-retirement.md) — the other proposal mined
  out of the same deleted doc.
