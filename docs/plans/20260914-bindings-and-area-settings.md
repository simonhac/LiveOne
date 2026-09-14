# Bindings and area settings — one sequenced plan

> **Status:** active — the EXECUTION SEQUENCE. Consolidates two 2026-09-14 handoffs
> (`device-naming-and-area-settings`, `explicit-bindings`) and, as of the same day, the design
> discussion that reconciled them with [20260910-block-model.md](20260910-block-model.md): one-or-zero
> wires, unit classes on wires, looms, the generator publishing a market loom. **The block model owns
> the model; this document owns the order.** Product decisions are agreed; no application change here
> has been implemented.
>
> This document is self-contained. No other plan or conversation is required.
>
> **Device naming is no longer part of this plan.** It was Unit 1 (Amber name generation,
> name-at-creation, `PATCH /api/v4/devices/{dv_}` for name/slug, `liveone device rename`) and is being
> delivered separately — removed 2026-09-14 once that work was underway elsewhere. Two things it owed
> the rest of this plan, which must still be true when Unit 4 lands: the v4 device PATCH must accept
> `{ name, slug }` so `DeviceSettingsDialog` can stop posting to the admin-only
> `/api/admin/devices/{systemId}/settings`, and a device rename must never rename its area.
>
> It also **absorbs `finish-grid-signals-retirement.md`**, now deleted. That document's diagnosis is
> reproduced under Unit 1 ("Grid signals — the first consumer"); its proposed `areas.config.gridSignals`
> jsonb pointer is replaced by a binding, which gets the same property with a real FK.

## Why these are one plan

They are not independent. Unit 5 requires that *"membership/binding changes that affect materialized
area history mark affected areas"* and that *"rehome, member replacement, onboarding, and binding
edits cannot bypass tracking."* Unit 1 **changes what those writers mean** — it deletes the implicit
union, adds a create-time binding command, and converts `ensureHelperBindings` from a machine
reconciler into a command.

Concretely, there is one edge that would be nasty to track correctly under today's model: whether a
binding change alters an area's serving set **depends on whether it is the first binding**, because
that silently narrows the area from member-union to just-that-point. Tracking built before Unit 1
has to special-case that; tracking built after cannot encounter it.

A second dependency is a live bug waiting to be triggered. **Unit 3 (the generator publishes a market
loom) must follow Unit 2 (the unit-class registry).** `lib/battery-provenance/load.ts:44`
(`oeEmissionsToGPerKwh`) multiplies emissions intensity by 1000 with NO unit check — it assumes the
source is OpenElectricity in tCO₂e/MWh. The generator's intensity is already in gCO₂/kWh
(`emissionsIntensity: 1000`). Bind it into that port before the registry exists and it becomes
1,000,000. The registry is what makes Unit 3 safe.

And chain retirement lives inside Unit 1 rather than beside it, because the create-time binding
command must write one-or-zero wires from its very first row.

## The five units, in order

| # | Unit | Ships as | Depends on |
| --- | --- | --- | --- |
| 1 | **Explicit bindings** — union retired, priority chain retired, OE path rename, loom-aware create command | one PR (7 stages) | nothing; must precede 3 and 5 |
| 2 | **Unit-class registry** — ports declare units, wires convert, one converter replaces five | one PR | nothing; must precede 3 |
| 3 | **The generator publishes a market loom** — `generatorSource` config retires | one PR | 1 and 2 |
| 4 | **Area Settings** — settings ownership, standard-time derivation, route deletions | one PR | the device-naming PATCH, shipping separately |
| 5 | **Durable rebuild state and repairs** | one PR | 1 and 4 |

**Order of execution: 1 → 2 → 3 (the bindings thread), with 4 in parallel, then 5.** The bindings
thread goes first because Unit 3 is unsafe without Unit 2, and because a durable job system (Unit 5)
should not be built on a model still changing underneath it.

Units 1 and 4 barely overlap and may run in parallel. Unit 4 was the second half of the original
"PR B"; it is split out here because a dialog refactor and a durable job system fail in completely
different ways and should not be reviewed together.

⚠️ **Unit 4 has already partly landed, out of order.** PR #507 ("Move site settings to areas and
harden area data handling") removed timezone/location editing from `DeviceSettingsDialog` and reworked
`AreaBuilderDialog`. What remains of Unit 4 is the rest: `AreaSettingsDialog` (absent),
`standardOffsetMin` (absent), and deleting the two legacy routes (`app/api/admin/devices/[systemId]/settings`
and `app/api/devices/[systemId]/location`, both still present). Note the half that landed is the half
that does **not** fix the original complaint — the dialog still saves the device name through the
admin-only route, which is what the separate naming work unblocks.

Unit 4 also **closes Stage 6 of the device→0..1-area epic** — the `areas.timezone_offset_min` vs
`day_offset_min` duplication (~12 readers), which its "no independently editable area offset"
decision resolves.

---

## Cross-cutting decisions — do not re-litigate

**Area settings**

- Display timezone uses IANA local time, including daylight saving, for display and wall-clock
  scheduling.
- The area's aggregation offset is derived from that timezone's standard time, excluding daylight
  saving. Every aggregation day remains exactly 24 hours. There is no independently editable area
  offset.
- Changing a boundary saves the change and marks affected aggregation as needing repair; it does not
  start a background rebuild.
- Moving a device into an area with an incompatible aggregation offset marks a repair requirement. It
  does not silently rewrite device history.
- Boundary incompatibility and incomplete rebuilding are separate concepts.
- Available daily data remains visible with persistent warnings until repair succeeds.
- Operators initiate resumable repairs through the CLI.
- Unit 5 includes an authorized additive database migration for dedicated rebuild state.
- Include a dry-run/apply audit to find and mark existing mismatches. Deployment itself does not run
  that audit or repairs.

**Bindings**

- **Grid signals attach by BINDING the shared ambient OpenElectricity device** — not by minting a
  per-area grid device, and not by a jsonb pointer in `areas.config`.
- **That needs no migration.** `area_bindings.metric_type` has no CHECK constraint and `grid` is
  already in `area_bindings_role_check`. An earlier idea to add a `market` role was wrong and
  abandoned: non-flow-ness lives on `metric_type` (`battery`/`soc` is the existing proof), not on
  `role`.
- **No reconcilers; commands are fine.** A command runs once, on user action, and never re-asserts —
  its rows are ordinary user-owned data: editable, deletable, and they stay deleted. A reconciler runs
  on every mutation and fights the user. This is Home Assistant's "generated, then take control",
  except we skip straight to materialised.
- **Empty areas: archive, don't delete.** `areas.status` already carries `active | archived | removed`
  and both non-active values are in use.
- **Unit handling fails closed** — an unrecognised or missing unit is never scaled on a guess.
  (Shipped in #506.) Unit 2 upgrades this from read-time passthrough to bind-time refusal.
- **One or zero wires per serving key.** The priority chain (`lib/areas/binding-chain.ts`) is retired.
  It was live-map-only failover, implicit resolution at read time, a type hole (no unit check across
  a chain), and it has exactly one real user in the fleet — the very case that produced the coin-flip
  bug it was written to order. Cardinality is per **serving key** `(area, logical_path, metric_type)`,
  NOT per slot: a `load` slot legitimately holds many circuits. Failover, if ever wanted, is an
  explicit `switch` block in the graph, which would type-check its inputs.
- **Unit classes on wires.** Compatibility is same unit *class*, not same unit. Input ports declare
  the unit they compute in; a wire is valid iff source and sink share a class; conversion happens at
  the sink on read; stored readings stay native, always. Unknown unit → refused at bind time.
- **Looms are an authoring concept; wires are the storage.** A loom is a named, typed bundle of
  ports — Simulink's *virtual* bus — with zero runtime footprint. A loom plug is one suggestion and
  one atomic write of N wires. **Loom ≠ role**: role `grid` contains a `flow` loom and a `market`
  loom; Amber publishes both, OpenElectricity and the generator publish `market` only.
- **The generator publishes a market loom.** `generatorSource` config is the same anti-pattern the
  export tariff already retired (`lib/battery-provenance/tariff.ts` header: a second implementation
  of "a price over time" beside the one the system has — a bound point). Its three scalars become
  three points on the `generator` role. This retires the block model's binding mode 3 ("config
  satisfies a port"), which had exactly this one live instance.
- **Every dependency is an explicit edge; not every relationship is an edge row.** Three lines hold:
  params are not ports (don't wire constants); types are not blocks (`transform` and unit conversion
  are type axes, never nodes); shape is not storage (cards conform to the edge shape but stay in
  `dashboards.doc`). And **one shape, several tables** — no unified `edges` table, because sinks are
  `ar_`/`dx_`/`au_` in different tables and a polymorphic sink loses the FK `area_bindings.point_uid`
  has today.

### ✅ CODE LANDED (2026-09-14) — the OpenElectricity path rename — Unit 1, stage 1.1

> **Status: code done, DATA NOT APPLIED.** The rename is in
> `lib/vendors/openelectricity/point-metadata.ts` (`OE_STEMS`), the `slots.ts` carve-out is deleted,
> and `lib/grid/latest.ts`, `lib/battery-provenance/load.ts`, the slot catalogue, the test fixtures
> and the docs move with it. The six `points.logical_path` rows are **not** renamed yet —
> `scripts/utils/rename-oe-grid-stems.ts` is the data half (dry-run by default; `--revert` inverts the
> path mapping, though not the database state — it re-bumps `updated_at`), and it must be applied to
> **prod**: `points` is a `mode: "full"` leg of the 2-hourly prod→dev sync, so a dev-only apply is
> overwritten within the hour.
>
> 🛑 **Sequence: deploy the code, then apply the data, then rebuild KV — close together, and not
> across 00:05 local.** The two halves are independent (`ensurePointInfo` short-circuits on an
> existing point, and `mintPoint`'s `ON CONFLICT` SET clause omits `logical_path`), so neither heals
> nor reverts the other; in the window between them the Local Grid card's price/emissions/renewables
> read a key nothing publishes and go blank, and the fold loses its emissions and renewables legs.
> Both are recoverable — the card on the KV rebuild, the fold by `liveone device recompute` — but a
> window that spans the daily aggregation is a day of provenance to rebuild rather than a blank card
> for five minutes.
>
> No history moves: `points.id` is a uuidv5 over `(vendor, vendorSiteId, physicalPathTail)` and
> readings key on `point_rid`, so neither identity depends on the logical path.
>
> ⚠️ **Two of the three new keys are Amber's**, which is the intent (one port, either source) but is
> live before Unit 2 exists to convert. `bidi.grid.spot/rate` is `$/MWh` on OE and `cents_kWh` on
> Amber. Two consequences, one closed and one deliberately left open:
>
> - **Closed here:** the `oe-grid` tile keyed on values alone, which only OE could satisfy before the
>   rename. It would now light up on an Amber device and render 10 c/kWh as "$10/MWh" — and the card
>   picker would offer it on every Amber dashboard. `oeGridSelection` (`lib/grid/latest.ts`) now
>   requires a real NEM region, which is what "these units are OE's" actually rests on.
> - **Open, and correctly so:** an area that bound BOTH sources to that serving key would get a
>   mixed-unit chain, since `binding-chain.ts` groups on path + metric and nothing checks units. No
>   area binds an OE point today, and the two answers are Unit 1.2 (the chain goes) and Unit 2 (the
>   wire converts). Do not patch a half unit-check in ahead of them.

### The original decision

`ROLES.grid.stem` is `"bidi.grid"` and `stemMatchesRole` matches the anchor or a dotted descendant, so
`grid.*` points are bindable **only** via a carve-out at `lib/areas/slots.ts:215`
(`role === "grid" && stem.startsWith("grid.")`).

| point | verdict |
| --- | --- |
| `grid.renewables` → `bidi.grid.renewables` | yes — both `%` |
| `grid.emissionsIntensity` → `bidi.grid.emissionsIntensity` | yes |
| `grid.price` → `bidi.grid.spot` | **yes** — the earlier objection (Amber `cents_kWh` vs OE `$/MWh`) is answered by Unit 2: the wire converts. Note the rationale has changed: with no chains, "shares Amber's serving key" no longer buys a fallback; the reason is now solely the carve-out below |
| `grid.demand` | **no** — MW, and `grid`/`power` is where the real site meters live |

The whole point of the rename is that it lets the `slots.ts:215` carve-out be **deleted** — the
three market signals then match role `grid` through ordinary `stemMatchesRole`. **Do it before any
binding seed** — nothing binds those points yet, so this is the cheapest it will ever be. Six rows of
`points.logical_path` (2 regions × 3 signals), no DDL; `lib/grid/latest.ts` hardcodes all four
serving keys and must change with it; definitions are in
`lib/vendors/openelectricity/point-metadata.ts`. Readings key on `point_rid`, so no history is
orphaned; zero dashboard documents name a logical path.

---

## Measured facts — expensive to re-derive

Measured 2026-09-14. Re-verify before acting.

- **Prod holds no orphaned data.** All 17 prod areas via `liveone area provenance` (window
  2024-01-01 → 2026-09-14): only `Daylesford` (flow 1749), `High Street Kew` (445) and
  `Kinkora Unified` (8222) hold rows. All 13 emptied areas-of-one report
  `flow 0 · provenance 0 · bindings 0 · agg5m 0 · agg1d 0`, as does `Kutis`. Nothing to purge.
- 🛑 **`liveone-dev` disagrees and dev is WRONG.** Dev shows `Kuti House` with 235 flow rows,
  `Daylesford Selectronic` with 10, and 12 stale `Kutis` bindings (6 pointing at a device re-homed to
  High Street Kew). Prod deleted all of these correctly; they survive on the mirror because the
  2-hourly prod→dev sync is an UPSERT that mostly does not delete. **Never judge an orphaned-data
  question from dev.**
- 🛑 **Hard-deleting an area must `UPDATE legacy_handles SET area_id = NULL`, never `DELETE` the row.**
  16 of 17 empty areas share their handle row with a device (an area-of-one inherited its device's
  handle); deleting the row destroys the DEVICE's handle mapping. Only `Kuti House` (handle 1000001)
  is area-only. Keeping the row also preserves monotonic allocation — `lib/areas/handles.ts` allocates
  `max(max(devices.rid), max(legacy_handles.handle), 1_000_000) + 1`, so removing the top row would
  let the next area reuse that integer.
- **Exactly one area per environment uses the implicit membership union** — prod: `Kutis`, whose sole
  member is the *retired* `Kutis · derived` helper; dev: `Craig (legacy)`.
- **There is no auto-binder.** Only two writers of `area_bindings`: `replaceBindings` (user-initiated)
  and `ensureHelperBindings` (battery-provenance recompute).
- **Exactly one priority chain exists in the fleet.** One serving key with more than one wire:
  Kinkora Unified `bidi.battery/soc` — `Kinkora Mondo`@0, `Kinkora Fronius`@1. Every other
  multi-priority slot (`grid/rate` at 0, 1, 2) is import/export/spot: different serving keys that
  never contend, numbered sequentially only because the writer numbered them.
- **The unit census** (active points): `power` is `W` (34), `kW` (Tesla), `MW` (OE); `rate` is
  `$/MWh` (OE), `cents_kWh` (Amber) **and `mi/hr` (Tesla)** — one metric type spanning an energy
  price and a speed, so unit class must derive from the unit, not the metric. Spelling varies where
  it must be exact: `cents_kWh`/`c/kWh`/`cents`, `mph`/`mi/hr`, `bool`/`boolean`, `epochMs`/`epoch_s`.
  **Five converters that do not know each other**: `convertUnits` (site-data-processor),
  `convertToKw` (lines-data), and `toKw`/`toKwh`/`oeEmissionsToGPerKwh` inline in
  `lib/battery-provenance/load.ts`. **MW passes through all five unscaled.** There is no dimensional
  unit layer anywhere — `lib/point/unit-typography.ts` is typographic and says so.
- Empty areas are otherwise inert in both environments: zero dashboard-document references, zero
  automations, zero `users.default_area_id` pointers.

Preserve unrelated workspace changes, especially overlapping work in `lib/areas/create.ts` and
`lib/readings/prod-dev-sync.ts`. Do not rename the current branch. Follow repository migration and PR
procedures.

---

## Unit 1 — Explicit bindings

### The problem

An Area resolves its serving point set **two different ways, and the two disagree.**

`PointManager._resolvePointsForHandle` is bindings-**XOR**-members:

```ts
if (boundUids.length > 0) { /* the bound points ARE the set */ }
// No bindings → default to the union of the area's member devices' own points.
```

`buildSubscriptionRegistry` (`lib/kv-cache-manager.ts:369`) is bindings-**UNION**-members, always — it
walks the bindings, then walks `getAreaMemberPointsForServing()` and adds every member point not
already bound.

So for an area *with* bindings, history/charts/flow serve the curated set while the KV live map
publishes that set **plus every unbound member point**. Nothing reconciles them and nothing names it.

The XOR half has a second cost: because bindings are an override rather than an addition, **adding a
first binding silently NARROWS an area** from "everything my devices produce" to "this one point".

🛑 **And neither of those is what the architecture doc says.** `areas-and-dashboards.md` §3 states:

> **Role resolution is per-role and explicit.** An area's _visible point set_ is always the union of
> its members' points. Its _role resolution_ is per-role: if bindings exist for role R they define R;
> otherwise R derives from members' points by stem match.

So the documented design is **union for visibility, per-role for resolution** — and by that reading the
KV registry is *correct* and `PointManager` is the deviation, which is the opposite of the framing this
plan started with. `_resolvePointsForHandle` is neither per-role nor union: one binding in any role
replaces the whole set, in every role.

✅ **SETTLED 2026-09-14: explicit-only.** Three candidates were considered:

1. **Make the code match the doc** — union stays, resolution becomes per-role. Smallest conceptual
   change and it keeps an area usable with zero bindings, but it preserves two concepts (visible set
   vs resolved role) that must then be kept honest in every reader, forever.
2. **Make the doc match the code** — bindings are the whole set, all-or-nothing. Documents the cliff
   rather than removing it.
3. **Explicit-only — CHOSEN.** Bindings are the whole set *and* there is no union to fall back to, so
   the all-or-nothing cliff disappears because there is only one mode to be on either side of.

Why (3) over (1): the cliff is not a bug in the union, it is the *seam between two modes*. Option 1
keeps that seam and adds a second axis (per-role) to reason about; option 3 deletes it. It also makes
the KV registry and the serving path agree by construction rather than by discipline, and it is what
lets grid signals stop being a special case. The cost — an area serves nothing until bound — is
answered by the create-time command in step 4, and is cheap in practice: exactly one area per
environment relies on the union today.

The corresponding correction has been made in
[`../architecture/areas-and-dashboards.md`](../architecture/areas-and-dashboards.md) §3 and recorded in
its §7, so the doc now describes today's actual behaviour and names where it is going.

It also makes `replaceBindings`' unconditional `DELETE ... WHERE area_id = $1` quietly dangerous:
machine-written rows (`ensureHelperBindings`) survive only because callers happen to echo back every
row they fetched. That is a convention held in the client, not an invariant held by the server.

### The change

1. **Delete the union fallback** in `_resolvePointsForHandle`. An area's point set *is* its bindings.
2. **Make KV agree** — drop the member-union leg at `lib/kv-cache-manager.ts:369`.
3. **Backfill the one union-mode area** per environment: materialise what it resolves today as
   explicit bindings, asserted byte-identical before/after.
4. **A create-time command** so a new multi-device area is usable immediately — the same "bind the
   obvious things" logic, run once, on user action. **Must land in the same PR as step 1**, or
   onboarding produces an area that serves nothing.
5. **`ensureHelperBindings` becomes a command too**, or keeps a narrow, *stated* exemption. Once
   nothing else writes bindings, `replaceBindings`' full-replace is correct by construction.
   (Block-model increment 3 — the fold becomes a registered derivation with typed ports — may make
   it unnecessary altogether; decide which when sequencing.)
6. **One or zero wires per serving key**, enforced in `replaceBindings` (the only user-facing
   writer). Retire the chain: `lib/areas/binding-chain.ts`, `resolveChainFields` and
   `chainFallbackField` (`lib/latest-values-store.ts`), `CHAIN_FALLBACK_STALE_MS`, and the `#rank`
   fields the KV registry publishes. The comparator's active-first rule goes with it — a deactivated
   bound point is a dead port until a human or a command rebinds it, which is the consistent answer
   under "commands, not reconcilers".
7. **The OpenElectricity path rename** (stage 1.1, above) — first, before anything binds those points.
8. **The create-time command is loom-aware.** It matches a source's loom to the sink's loom shape,
   writes N wires atomically at a single moment, and on a port that is already taken it refuses or
   explicitly replaces — never "plugs at priority 1". Ambiguity (two candidate sources for one loom)
   is reported as absent-with-evidence, never guessed.

### What it buys

One resolution mode; the two paths stop disagreeing. The silent-narrowing trap becomes
unrepresentable. `devices.area_id` gets exactly one meaning — placement, plus the candidate set for
the picker. Grid signals need no reconciler, no `areas.config.gridSignals` opt-out and no
generated-vs-authored fight. And it is HA's actual model: the energy dashboard is configured by
explicitly naming statistic ids, not derived from area membership.

### Grid signals — the first consumer, and the path this deletes

This subsection absorbs `finish-grid-signals-retirement.md`, which is retired. Its diagnosis is
reproduced here because it is the only record of the evidence.

**The vocabulary half already shipped.** `grid-signals` is not a card type — it is absent from
`V4_CARD_TYPES` (`lib/dashboard/card-types.ts`). `oe-grid` is a first-class card type in its place,
registered as a tile plugin (`components/dashboard/registry.tsx:78`) and catalogued
(`lib/capabilities/catalog.ts:142-148`). The sibling rename `grid` → `house-to-grid` shipped too.

**The resolution half did not, and was ported forward twice rather than deleted.** config-v4 Phase 13
PR 5 re-pointed the area lookup at `legacy_handles` when `areas.legacy_system_id` was dropped; the
device→0..1-area change re-pointed it again at `devices.area_id` (2026-09-14), because stopping the
area-of-one mint would otherwise have left a newly onboarded device with no handle→area leg at all.
`resolveGridContextForDevice` (`lib/grid/context.ts`) still does the full walk: area location →
`nemRegionForLocation` → a grid-role point check → a lookup of the public OpenElectricity device
serving that region. Its own comment records that it "runs inline on the dashboard server render" and
must therefore swallow every DB fault so it can never 500 the dashboard.

**It is load-bearing in two places, both in the capability layer.** `lib/capabilities/server.ts:90`
mints the capability (`if (await resolveGridContextForDevice(handle)) caps.add("grid-signals")`) and
`:154` calls it a second time to resolve `gridDeviceSystemId`, which becomes the `ctx.gridDevice` the
strategy reads (`lib/capabilities/strategy.ts:45`) to emit the card (`:126-127`).

**It is the one deliberate exception to the capability model.** `lib/capabilities/registry.ts:26-27`
says so: compound capabilities are "a predicate over area config + external rows … not a
point-presence scan". `lib/capabilities/derive.ts:14` names the complete set of non-point-derived
capabilities as exactly two — `generator-running`, which is still a property of the area's own
configured contents, and `grid-signals`, which is the only one reaching outside the area entirely, to
a location and a globally-seeded public device.

🛑 **And the AREA half has never worked — measured, not inferred.** `devicePlaysGridRole` joins
`points → devices` on `devices.rid`, so a handle with no `devices` row matches nothing. Every area
handle therefore resolves its location and NEM region correctly and then fails the grid-role check.
On `liveone-dev`, handles 7, 8, 1000001, 1000002 and 1000003 all answer `grid-signals: false` — the
Local Grid card has only ever rendered on a DEVICE-addressed dashboard. That is a second, independent
reason to delete this path rather than repair it: the repair ("check the area's bindings") is a
product change dressed as a bug fix, since a card would newly appear on five dashboards that do not
have one today. **Treat that as a deliberate product decision when it happens, not a side effect.**

**The consumer side already stopped caring about location**, which is what makes this cheap: the tile
is bound to a device, not a place. `components/dashboard/tiles/oe-grid.tsx` reads the live
price/emissions/renewables from the device's `latest`, and the region label comes from the device's
own `vendorSiteId` payload. Only the *resolution* side still goes via location, so there is nothing
to rewrite downstream.

**What Unit 1 does about it.** An area names its grid feed by BINDING the ambient OpenElectricity
device's points (role `grid`; metrics `rate` / `intensity` / `proportion` — never `power`, where the
real site meters live). In loom terms: the OE device publishes a `market` loom and the area plugs it
into its `grid` role. An off-grid site plugs the *generator's* market loom into its `generator` role
instead (Unit 3) — **not** into `grid`, which an earlier draft of this plan suggested. The fold's
input is therefore not "grid/rate"; it is *"the market loom of whichever role feeds the site's
external source"*, with a port predicate of `market on role ∈ {grid, generator}`. `grid-signals` then derives from the presence of those bindings, with no
location lookup, no region derivation and no global device search at render time.
`lib/grid/context.ts` and `lib/grid/types.ts` are deleted along with both `resolveGridContextForDevice`
calls, and the three separate null-returns inside it collapse into "no binding".

The headline property survives intact, and it is why the shape is worth the work: **the absence of
the reference IS the off-grid rule.** An off-grid site binds no region device, so it offers no
`grid-signals` capability, so the strategy emits no card and the picker greys it out. There is no
conditional-render branch and no off-grid special case.

**Seeding is one-off and derived from what is already true**, not asked of the user: run today's
`resolveGridContextForDevice` over every area, bind what it resolves, and diff. An area whose
bindings match what the walk would have returned is behaviour-identical by construction — which is
the whole gate. Areas the walk declines become areas with no binding, i.e. off-grid, which is what
they already render as. Afterwards the binding is editable like any other, which is a small
improvement on its own: today an area in a state the postcode table maps wrongly has no override at
all.

Two risks specific to this consumer, both improved by using a binding rather than the `areas.config`
pointer the retired document proposed. **A jsonb ref can dangle; an FK cannot** — `area_bindings.point_uid`
is `NO ACTION`, so a bound point cannot be deleted out from under it, and the "treat an unresolvable
ref as an empty slot" handling the old plan needed does not arise. **Existing flow history must not be
disturbed** — and a binding to an ambient device cannot disturb it, because these are `rate`,
`intensity` and `proportion` metrics, which `classifyEnergyStem` never admits to the flow matrix.
Separately, confirm `lib/dashboard/access.ts`'s walk yields the intended share scope and nothing
wider: a shared dashboard rendering `oe-grid` reads a public ownerless device's points, which is fine,
but it should be checked rather than assumed.

### Risks

🛑 **The KV shrink is the one that can bite.** Today an area's live map carries every member point,
bound or not; after step 2 it carries only bound points. Any card reading an unbound path from an
area's `latest` map goes blank — in production, at render time, with no error. **Gate this on an
enumerated diff of the subscription registry before/after**; expect a strict subset and treat any new
entry as a bug.

**Kutis is a genuinely odd case.** Its one member is a retired helper with frozen provenance. Confirm
what it actually serves before materialising it — the honest answer may be "nothing, archive it".

🛑 **`priority` cannot simply be set to a constant.** `area_bindings_slot_priority_unique` is on
`(area, role, metric_type, priority)`, and Kinkora's `load/power` circuits sit at 0–3 *not because
they contend but because the writer numbered them*. Make priority constant and that index forbids a
second load circuit. So the column and the index go together, and that is a **schema change → Backlog,
needs approval**. Until it is approved: keep writing `priority` exactly as today, and enforce
one-per-serving-key in `replaceBindings`.

**Kinkora's SoC needs a human decision before stage 1.2** — Mondo or Fronius. It should have been a
decision all along; the chain let it not be. The right answer is whichever device is the battery's
own controller rather than an inverter's view of it.

### Stage order

| # | Stage | Ship | Revert |
| --- | --- | --- | --- |
| 1.1 | ✅ code / ⏳ data — OE path rename: `point-metadata.ts` (`OE_STEMS`), `lib/grid/latest.ts`, `lib/battery-provenance/load.ts`, the two `slots.ts` `exact()` stems, the `slots.ts` carve-out DELETED; then 6 `points.logical_path` rows on **prod** via `scripts/utils/rename-oe-grid-stems.ts --apply`; KV rebuild | code, then data | `--revert --apply` + rebuild |
| 1.2 | Kinkora SoC decision (one row), then retire the chain and enforce one-per-serving-key in `replaceBindings` | code + 1 row | revert |
| 1.3 | Backfill the union-mode area's bindings (prod `Kutis`; dev `Craig (legacy)`) | data | delete the rows |
| 1.4 | Loom-aware create-time binding command | code | revert |
| 1.5 | Delete the union fallback in `PointManager` | code | revert |
| 1.6 | Drop the KV member-union leg + registry rebuild (the `#rank` fields went in 1.2) | code | revert + rebuild |
| 1.7 | `ensureHelperBindings` → command, or defer to block-model increment 3; state the `replaceBindings` invariant | code | revert |

### Verification

- 🥇 The area point-set parity harness ([area-point-set-parity-harness.md](area-point-set-parity-harness.md)):
  every area's resolved point set byte-identical before/after, all 17.
- KV subscription-registry diff, pre/post — strict subset, every removed entry accounted for, and
  after 1.2 **no `#rank` field anywhere** in it.
- After 1.2, re-run the chain census (serving keys with >1 wire per area) — must return zero rows.
- After 1.1: `grep -rnE '(^|[^.])grid\.(price|renewables|emissionsIntensity)'` over tracked files
  returns nothing outside `docs/incidents/` and the Amber vendor key names (Amber's own `grid.*`
  strings are its VENDOR keys, not logical paths, and do not move); `grid.demand` is untouched; and
  `bindingShapeMatches("grid", "power", { logicalPathStem: "grid.demand" })` is false — pinned by a
  test, because that is the carve-out's deletion and not merely a rename.
- After 1.1's DATA leg, re-run `rename-oe-grid-stems.ts` with no flags: it must report 8 OE points,
  6 already renamed and `0 row(s)` to change. Then confirm the Local Grid card still shows price,
  emissions and renewables, and that a battery-provenance recompute for the day still produces
  emissions and renewable legs (the two readers keyed on the old paths).
- Re-run `scripts/area-builder-smoke.ts` and `scripts/utils/v4-surface-smoke.ts`.

---

## Unit 2 — The unit-class registry

This is [ha-parity-and-leapfrog.md](ha-parity-and-leapfrog.md) #6 made concrete, landed on the
`unit` axis of the block model's port type. The census that makes it urgent is under Measured facts.

**The rule.** Compatibility is same unit *class*, not same unit. An input port declares the unit it
computes in. A wire is valid iff source and sink units share a class, and the reader that follows a
wire into a port converts at the sink, on read. **Stored readings stay native, always** — the same
principle that protected history through the export-tariff cleanup. An unknown unit is in no class,
so the wire is refused at bind time rather than passed through unscaled at read time (which is what
#506's fix does today; this supersedes it).

**The registry** — `lib/point/units.ts`, beside `unit-typography.ts` (which disclaims the
dimensional job in its own header). Nine classes, from the data:

| class | units | note |
| --- | --- | --- |
| `power` | W, kW, MW | today MW passes through every converter unscaled |
| `energy` | Wh, kWh, MWh | |
| `energy-price` | c/kWh, $/kWh, $/MWh | |
| `emissions-intensity` | gCO₂/kWh, kgCO₂/kWh, tCO₂e/MWh | replaces `load.ts:44`'s blind ×1000 |
| `proportion` | %, fraction | the fold already does this implicitly for renewables |
| `temperature` | °C, °F | **affine** — offset, not just factor |
| `speed` | mph, mi/hr, km/h | `rpm` is NOT speed; `rate/mi/hr` on Tesla is a speed mislabelled as rate |
| `time` | epoch_s, epochMs | |
| categorical | bool, text | identity only |

Plus an **alias table** so `cents_kWh`, `c/kWh`, `boolean`, `mi/hr` resolve to canonical spellings —
without it the registry refuses valid wires.

**The change.**

1. `lib/point/units.ts`: classes, canonical units, factors (affine where needed), aliases, and ONE
   `convert(value, from, to)`.
2. Ports and the slot catalogue (`lib/areas/slots.ts`) gain a declared `unit` beside `metricType`.
3. `bindingShapeMatches` gains the class check. Unknown → refuse.
4. Replace the five converters with registry calls: `convertUnits` (`lib/site-data-processor.ts`),
   `convertToKw` (`lib/charts/lines-data.ts`), `toKw` / `toKwh` / `oeEmissionsToGPerKwh`
   (`lib/battery-provenance/load.ts`). The MW hole closes as a side effect.
5. The graph report (block-model increment 2) renders the factor on the edge — `×0.1: $/MWh →
   c/kWh` — never as a node.

**Lines to hold.** Accumulation is its own type axis — `transform: 'd'` is not a unit conversion and
must not be modelled as one. Display precision is a card concern even though #6 bundles it. And
convertible ≠ the same quantity: 70 $/MWh *is* 7 c/kWh and the wire should convert it; whether the
NEM spot is this site's tariff is a provenance judgement made visible by what you bind, not a units
problem to refuse.

**No schema change** — `points.unit` exists and stays native.

**Verification.** Unit tests per class including the affine case and every alias; a grep proving no
`/ 1000`-style scaling survives outside the registry; the five call sites replaced; an OE `MW`
series charting as MW, not as kW.

---

## Unit 3 — The generator publishes a market loom

`generatorSource` is the last `"a value over time" described in config` in the codebase, and it is
the same anti-pattern the export tariff retired. One site uses it: Daylesford,
`{pricePerKwh: 70, renewableFraction: 0, emissionsIntensity: 1000}`, on `Daylesford Selectronic` with
a mirror in `areas.config`. It has two consumers that were extracted into
`lib/battery-provenance/generator-source.ts` precisely so they could not disagree — and both still
read config where every other source is a bound point.

**First decision, to be stated rather than assumed: which device publishes.** The config sits on the
inverter because that is where the fold looked. The fact belongs to the genset — `Daylesford
Generator`, a DeepSea device pushed from the hub. Publishing from the inverter is the smaller change;
publishing from the genset is the truer one. Name the choice in the PR.

**Second decision, before any point is written: the sign convention.** `lib/battery-provenance/tariff.ts`
records what happens otherwise — Amber's export rate is negative when you are paid, a schedule plan's
was a positive receipt, and the resulting discriminator made the fold floor one site's solar
opportunity cost to zero and not another's. Decide "positive = cost to us" (or otherwise) first.

**The change.**

1. The publishing device emits three points from its config: `source.generator/rate` (c/kWh),
   `source.generator/intensity` (gCO₂/kWh), `source.generator/proportion` (%). Real points, real
   readings at the device's existing cadence — no "config point that materialises on read".
2. The area binds them to its **`generator`** role via the loom-aware command (Unit 1). Not to
   `grid`: Daylesford's external source is role `generator` by config, which is the block model's
   scope rule.
3. The fold's and run-provenance's input becomes *"the market loom of whichever role feeds the
   AC-input"* — port predicate `market on role ∈ {grid, generator}`. `resolveGeneratorIntensity`
   and its "fall back to the OE/Amber region signal" branch collapse into "read the bound loom".
4. **Retire**: `generatorSource` from `lib/capabilities/config.ts` and `parse-config.ts` (⚠️
   `parseDeviceConfig` is a WHITELIST rebuild and the PATCH REPLACES the column — run
   `liveone device config lint --all` then `config clean` after, and the `areas.config` mirror goes
   with it); the `config:` escape hatch on `grid/rate` in `lib/areas/slots.ts`;
   `lib/battery-provenance/generator-source.ts`; `oeEmissionsToGPerKwh` in `load.ts` (Unit 2's
   registry converts).
5. **The master gate survives as a loom rule.** Today `emissionsIntensity` being finite is the
   statement "this site's AC-input is a generator" and it gates all three factors, so price never
   applies without emissions. Restate it: a `market` loom on the `generator` role is present iff its
   `intensity` wire is bound; `rate` without `intensity` is refused at plug time.

**Behaviour change to state.** Today, editing `pricePerKwh` silently reprices all of Daylesford's
history. As a point, a config change takes effect from now on. That is strictly better and it is a
change; say so in the PR and decide whether the existing constant is backfilled as a series.

**Cross-references.** This retires block-model binding mode 3 ("config satisfies a port") — it had
exactly this one instance. It also makes the on-grid NEM region, the retailer and the off-grid
generator the same kind of block: a market-signal source, plugged by the same command.

**Verification.** Daylesford's fold output byte-identical before/after (the constant series must
reproduce the constant); `config lint` reports zero `generatorSource` keys after `clean`;
run-period provenance for a generator run prices identically; an intensity of 1000 gCO₂/kWh arrives
at the fold as 1000, not 1,000,000.

---

## Unit 4 — Area Settings and timezone behavior

### Dialogs and access

Create `components/areas/AreaSettingsDialog.tsx`, following Area Builder's portal, modal registration,
notification, loading and error conventions. Use the existing v4 area GET/PATCH routes.

Fields and actions:

- Area name and owner-scoped short name, using existing area alias normalization.
- AU state/postcode with the existing location merge behavior and a shared NEM-region preview
  component.
- Display timezone and read-only derived aggregation offset, formatted as signed minutes such as
  `+600m`.
- Existing archive confirmation, dependency blocking and relied-upon messages.
- Aggregation health warning, progress/error details, and the relevant CLI repair command.

Area Builder edit mode keeps Members and Bindings only, with a Settings action in its header. Remove
its General/Location editing and archive controls. Keep create mode's name/slug/member workflow;
derive its timezone/offset defaults using the rule below.

Add Settings and Devices actions to `AreaTable`, with dialog state in both owner and admin area
clients. Ensure edits refresh the table, open dialogs, membership information and affected dashboards.

In `DeviceSettingsDialog`:

- Save name/slug through the v4 device PATCH delivered by the separate naming work.
- Remove editable timezone and location, their dirty state, and device placement locking machinery.
- Show the area's timezone, the device's own aggregation offset, and compatibility/rebuild status. An
  unassigned device shows "No site".
- Open Area Settings only for an area owner/admin. Device ownership alone must not expose an area edit
  action.
- Thread the `dv_` ID from `DeviceLayout` and the admin device client; retain the integer handle for
  other tabs that still require it.
- Replace the legacy settings GET with v4 detail loading. Add `dayOffsetMin` and aggregation health to
  the response.

Fix the v4 detail-loading access regression as part of this work: owners and explicitly acting admins
must be able to fetch authorized inactive devices. Keep list/picker active filtering unchanged. Admin
entry points send explicit admin read context, and query keys include that context. Handle failed
loads without displaying an editable blank form.

Delete these routes after migrating all consumers:

- `app/api/admin/devices/[systemId]/settings/route.ts`
- `app/api/devices/[systemId]/location/route.ts`

Remove `DevicePatch.displayTimezone`, `DevicePatch.timezoneOffsetMin`, `describeDevicePlacement`,
`PlacementRefusedError`, and required-placement branches. Retain location, best-effort placement
outcomes/refusals, and Enphase reconnect's guarded location write. Document Enphase as the remaining
device-to-area location writer; do not claim there are no such writers.

### Standard-time derivation

Add one shared `standardOffsetMin(timezone)` mapping covering every accepted timezone. Commit its IANA
source version and effective date alongside the mapping. Use the applicable IANA base `STDOFF`,
excluding the daylight-saving adjustment; do not infer it from today's offset or a January/July
minimum — those shortcuts fail for negative-DST rules. Source semantics:
[IANA's timezone database guide](https://www.iana.org/time-zones/tz-how-to).

The mapping is stable until explicitly updated in code. Tests must cover fractional offsets and
negative-DST zones, not just Australian and northern-hemisphere seasonal examples. A mapping update is
an auditable boundary-policy change, not an automatic seasonal data rewrite.

- Display formatting and wall-clock schedules continue using the selected IANA timezone.
- Aggregation uses the fixed mapped offset throughout history, with 24-hour days; it does not follow
  historical or seasonal offset transitions.
- New areas derive `day_offset_min` and `timezone_offset_min` from the selected/defaulted display
  timezone.
- New devices placed in an area initialize their device offset from that area. Unassigned devices
  retain platform/vendor initialization behavior.
- Existing device offsets change through tracked repair, not immediately on moves or area edits.

Area PATCH derives both area offset columns whenever the timezone changes. For compatibility, an
explicitly supplied legacy `dayOffsetMin` is accepted only when it equals the offset derived from the
effective timezone; contradictions return 422. Metadata-only edits do not silently repair existing
mismatches.

Before saving a timezone change, show old/new timezones and offsets. If the aggregation boundary
changes, require explicit confirmation explaining that daily history needs an operator rebuild.
Explain that timezone also affects local scheduling/calendar interpretation; it is not a labels-only
preference.

---

## Unit 5 — Durable health state and repairs

### Storage and public health model

Add a dedicated `aggregation_rebuild_state` table with one row per device or area, nullable subject
foreign keys, an exactly-one-subject check, and subject uniqueness. Keep this state separate from
device lifecycle status, vendor adapter state and user configuration.

Persist: requirement revision and completed revision; previous/target offsets and reason codes;
`pending` / `running` / `failed` / `complete` status; phase, stable history bounds and next cursor;
lease token/expiry, timestamps and sanitized last error.

Expose two separate concepts:

- `boundaryCompatible`: a device's stored offset matches its current area's required offset.
  Unassigned devices are compatible by definition.
- `needsRebuild`: an outstanding durable requirement exists, or a boundary mismatch requires repair.

**Offset equality never proves a partially completed rebuild succeeded.** A device can already have
its target offset while still needing historical reconstruction.

Use a shared `aggregationHealth` serializer in device/area detail and affected daily-data responses,
carrying compatibility, requirement, status, reasons, offsets and progress. Area health includes its
own repair requirement and unresolved member prerequisites. Return only details the caller is
authorized to read.

### Invalidation and visible warnings

Record metadata changes and rebuild requirements in the same transaction:

- Area boundary change: mark the area for full repair and incompatible members for device repair.
- Device move: preserve its stored offset, compare with the destination, and mark necessary repair.
- Membership/binding changes that affect materialized area history: mark affected source/destination
  areas.
- Wire shared writers so rehome, member replacement, onboarding and binding edits cannot bypass
  tracking. **Unit 1 must land first** — see "Why these are one plan".
- Repeated unchanged requests do not advance revisions.
- A later relevant change advances the revision; an older worker cannot clear it.
- Returning to a compatible area may clear a never-started mismatch-only requirement, but must not
  clear partially rebuilt or independently invalidated history.

Keep daily data visible with persistent warnings in settings, tables and affected daily
dashboards/charts. During repair, explain that some days may temporarily be incomplete. Raw and
intraday data remain available. UI controls do not start automatic repair jobs.

### Operator API and CLI

```text
liveone device rebuild <device>
liveone area rebuild <area>
liveone area audit-boundaries [area]
```

All dry-run by default, requiring explicit apply flags to mutate. The audit without an area scans the
caller's owned areas; explicit admin context permits a fleet audit. Audit apply corrects stored area
offsets to the derived value and records requirements transactionally; it does not rebuild data.

Back commands with bounded POST endpoints under the existing v4 device/area namespaces, including a
reserved static boundary-audit route under `/api/v4/areas`. Verify CLI middleware allowlisting and
static route precedence.

Rebuild apply requests name the reviewed requirement revision. Persist cursors on the server:
re-running the CLI resumes without manually supplying a date. Changed revisions return 409 and require
a refreshed dry-run plan. Return phase, progress, completion and failure details using standard CLI
output/error conventions.

Authorize every subject being repaired. An area owner cannot rewrite another owner's device through
custody alone. Area repair preflights all prerequisite permissions before writing; inaccessible device
repairs are reported explicitly. An admin can perform the complete repair.

### Repair sequencing

Device repair:

1. Persist a full-history plan using source and existing aggregate extents, including boundary
   margins.
2. Update the device offset and persist initialization atomically.
3. Rebuild device daily aggregates in bounded retry-safe chunks.
4. Leave dependent areas marked until their repairs finish.

Area repair:

1. Finish required member-device repairs.
2. Force a full rebuild of battery daily inputs and learned parameters where a battery is bound.
3. Rebuild affected flow/provenance history, including stored blend and checkpoint outputs.
4. Refresh serving caches and complete only the current requirement revision.

Implementation anchors are `lib/aggregation/change-day-offset.ts`, `lib/aggregation/scoped-recompute.ts`
and `lib/areas/recompute-provenance.ts`. Reuse their domain calculations, but do not inherit unsuitable
success semantics:

- The existing bounded provenance request uses incremental learning when `start` or `last` is
  supplied. It cannot prove a historical boundary repair. Force full input reconstruction.
- Existing scoped helpers log some failures and continue. Add strict repair paths that fail and
  persist the error; swallowed failures cannot advance successful progress.
- Replacing aggregates must remove obsolete outputs as well as upserting new outputs. Shifted boundary
  days with no new data must not retain stale rows.
- Persist progress only after a chunk succeeds. Initialization/deletion and retry behavior must be
  idempotent across process death.
- Refactor full-history learning into resumable phases where necessary to stay within serverless
  request budgets. No unbounded job runs inside an ordinary settings PATCH.

Coordinate overlapping repairs, daily aggregation and boundary writers with per-subject locking and
revision checks at chunk commits. Expired leases allow retry. Superseded workers cannot commit
obsolete-boundary outputs or publish completion.

Missing source history is an explicit failure requiring operator attention. Retain the requirement and
report coverage gaps; do not silently discard unrecoverable aggregates and declare success.

Integrate the existing `device change-offset` with tracking. Assigned devices reject target offsets
incompatible with their area; unassigned devices retain explicit offset changes. Ordinary partial
recomputes never clear a full-history repair requirement.

### Environment isolation

Rebuild cursors, progress and leases are environment-local. Exclude the new table from wholesale
prod-to-dev copying.

When sync changes local boundaries, memberships or relevant bindings, invalidate local state rather
than copying prod completion. Extend ID-realignment and foreign-key handling for the new table. Synced
data is not declared repaired merely because prod reports completion. Test sync interruption and
replay alongside local pending work.

---

## Tests and acceptance

**Unit 1** — see its Verification section. The parity harness is the acceptance gate.

**Unit 2** — see its Verification section. The affine and alias cases are where a registry is
usually wrong.

**Unit 3** — see its Verification section. The byte-identical fold output is the gate.

**Units 4 and 5**

- Dialog loading/saving as owner and admin, including inactive devices and lack of area-edit
  permission.
- Location merge and NEM preview, archive dependencies, builder split, refresh behavior, and
  removed-route consumer search.
- Standard-offset mapping covers every selectable zone; fractional offsets, both hemispheres, negative
  DST, and seasonal transitions retain fixed 24-hour aggregation.
- Both area offset columns are asserted at the actual writer level. The route test currently mocks
  `updateAreaMeta`, so it cannot establish this coupling by itself.
- All boundary/member/binding writers record requirements atomically; no-op, compatible/incompatible
  move, unassignment, repeated changes, and zero-history subjects.
- Device-before-area ordering, full battery input reconstruction, obsolete-row removal, missing
  history, partial failures, restart, lease expiry, stale worker, and concurrent revision changes.
- Warnings and API health metadata persist until successful repair; offset equality alone does not
  clear them.
- Prod-to-dev sync and ID realignment preserve environment-local correctness.
- Existing calendar timezone validation and Enphase reconnect behavior remain green.

Run repository type checking for both app and scripts, lint, relevant Jest suites, knip and CLI
conformance. Use the running type watchers when available; do not restart the dev server or run a
conflicting build to check types. Regenerate CLI reference artifacts after the final command
definitions.

Use isolated dev fixtures for boundary changes and repair tests. **Do not experiment on the production
Amber areas.** A successful HTTP response or a saved offset is not evidence of completed repair:
verify persisted state and representative rebuilt outputs, including an interrupted-and-resumed run.

## Rollout

1. Ship Unit 1 by its stage order — 1.1 first, before anything binds the OE points — gated on the
   parity harness, the KV registry diff, and a zero-row chain census.
2. Ship Unit 2. No data change; verify the five converter call sites and the MW case.
3. Ship Unit 3, gated on Daylesford's fold output being byte-identical, then `config clean`.
4. Unit 4 may run in parallel with 1–3; deploy it, verify owner/admin settings.
5. Apply Unit 5's additive rebuild-state migration through repository procedures **before** deploying
   code that requires the table.
6. Deploy Unit 5; verify compatibility indicators and pending warnings.
7. Run the boundary audit as a dry run. Review exact targets, then explicitly apply marking and run
   scoped repairs. There is no automatic fleet repair at deploy.
8. Verify completion from durable state and rebuilt data. Failed repairs remain visible and resumable.

Update `docs/architecture/api.md`, `docs/architecture/data-model.md`, `docs/cli.md` and
`docs/outage-catchup.md`, plus generated CLI references. Document: removal of the legacy device
settings/location routes; area timezone ownership, derived fixed offsets and separately stored device offsets; the retained
Enphase location exception; durable health states, warnings, repair authorization, resume behavior and
missing-history failure handling; the audit/migration rollout and environment-local sync rules; and
that an area's point set is now exactly its bindings.

## Architecture handover — what survives this plan

🛑 **This plan is disposable; the architecture doc is not.** Every unit below names what it must write
into `docs/architecture/` **in the same PR that lands it**. A unit is not done when its code merges —
it is done when the invariant it establishes is recorded somewhere that outlives this file. When all
five have landed, delete this document; git is the archive.

**The survivor is [`../architecture/areas-and-dashboards.md`](../architecture/areas-and-dashboards.md)**,
not a new file. Its §3 "Semantic: areas, membership, bindings" already owns this territory, and a
second doc would duplicate and then drift. §7 "Decisions this doc used to assert — now overturned" is
the established place to record a superseded position rather than silently editing one away.

⚠️ One correction is already owed, independent of any unit: §3 describes role resolution as **per-role**
("if bindings exist for role R they define R"). `PointManager._resolvePointsForHandle` is not per-role —
it is **all-or-nothing over the whole area**: any binding at all, and the member union is skipped
entirely. Whichever of those is intended, the doc and the code currently disagree.

| Unit | Must be recorded in `areas-and-dashboards.md` when it lands |
| --- | --- |
| 1 Bindings | **The core invariant: an area's serving set IS its bindings.** Placement (`devices.area_id`) vs serving (`area_bindings`) as separate concepts; the slot `(area, role, metric_type)` vs the **serving key** `{logical_path}/{metric_type}` that actually contends; **one or zero wires per serving key — the chain is gone and `priority` is vestigial**; that an ambient device can be BOUND but never PLACED; that grid signals are a binding, not a location walk. Add the retired member-union AND the retired chain to §7 |
| 2 Unit classes | Compatibility is same unit class; ports declare units; wires convert at the sink; readings are stored native; unknown units are refused at bind. Where the registry lives and that it is the only converter |
| 3 Generator loom | The generator is a market-signal source of the same kind as OE and Amber; the fold's port predicate is `market on role ∈ {grid, generator}`; "config satisfies a port" no longer exists — add it to §7 |
| 4 Area Settings | Area owns timezone and location; the aggregation offset is DERIVED from standard time and is not independently editable; the device keeps its own offset; Enphase is the one remaining device→area location writer |
| 5 Rebuild tracking | `boundaryCompatible` vs `needsRebuild` as distinct states, and that offset equality never proves a rebuild completed; that repair is operator-initiated and resumable, never automatic |

Also owed on landing, per the Rollout section: `api.md` (route contracts and the deleted legacy
routes), `data-model.md` (the offset columns and the rebuild-state table), `cli.md` and the generated
CLI reference.

**Why not write it now.** The architecture doc describes what IS. Most of the invariants above
are not true yet — writing them today would produce a doc that is wrong until the code catches up,
which is precisely the rot the repo's conventions warn about. The exception is the §3 correction
flagged above, which describes today and can be fixed whenever.

## Backlog — not scheduled here

- **Archive the 13 empty areas-of-one.** Needs `liveone area archive <ar_>` plus a sweep of
  list/picker queries to filter on `status`. A hard `area delete` is possible but see the
  `legacy_handles` constraint above; deleting orphaned *data* needs no new verb, since
  `area purge flows` / `area purge provenance` already do it — the only gap is that `purge flows`
  demands `--start`/`--end`, which is meaningless for an area where nothing can recompute those rows.
- **`liveone area orphans`** — a read-only census (areas with data but no devices, bindings whose
  point's device has left, handle rows with a dangling area leg). Useful on its own for detecting the
  dev drift described above.
- **Drop `area_bindings.priority` and `area_bindings_slot_priority_unique`** — a schema change
  (needs approval). Not before Unit 1.2 has enforced cardinality in the writer, and see the Risks note
  on why the index cannot be left behind with a constant priority.
- **An explicit `switch` block** for failover, if it is ever wanted — N typed inputs, one output,
  declared in the graph and type-checked, which is what the retired chain was not.

## Guardrails

- No production rename, schema migration, audit apply or rebuild is performed merely by adding this
  document.
- **Any schema change needs explicit approval first.** Only Unit 5 requires one; the `priority` drop is a second, unscheduled one.
- **Do not purge anything on prod** — measured at zero; the orphans visible on dev are mirror
  artifacts, not defects.
- The retired `finish-grid-signals-retirement.md` proposed an `areas.config.gridSignals` jsonb
  pointer. Unit 1 uses a binding instead; do not reintroduce the pointer.
- **Never rewrite stored readings to change a unit.** Store native; convert at the sink. A migration
  that rescales `point_readings` is the wrong answer to every unit question.
- **No unified `edges` table.** One edge shape, several tables — the FK on `area_bindings.point_uid`
  is worth more than the uniformity.
- **Do not reintroduce a priority/fallback chain on bindings.** If failover is needed, it is a block.
