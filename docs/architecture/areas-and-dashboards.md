# Areas & Dashboards

> **Status:** current — **rewritten 2026-07-28 for config-v4.** This doc holds the _why_ and the
> invariants of the three-layer split (physical / semantic / presentation). Columns, types and routes
> live in code: `lib/db/planetscale/schema.ts` is the schema source of truth (Drizzle is
> authoritative — never hand-rolled SQL, never `drizzle-kit push`).
>
> **Config-v4 supersedes this doc on design decisions.** Where the two disagree,
> [`../plans/completed/config-v4-clean-sheet.md`](../plans/completed/config-v4-clean-sheet.md) wins; three decisions this
> doc used to assert have been **overturned** and are recorded as such in §7. This describes the v4
> model as designed and delivered; config-v4 **completed 2026-08-01**, so everything below is live. For
> the record of how it was built and the traps it taught, see
> [`../plans/completed/config-v4-execution-plan.md`](../plans/completed/config-v4-execution-plan.md).

## 1. The three layers

The initiative splits three concerns that the old `systems` table fused (a "composite system" mixed
physical collection, semantic grouping, and presentation). The split follows Home Assistant's
vocabulary and the Apple Home / Health model: **a good auto-generated default, customizable on top —
not a blank canvas.**

| Layer            | Tables                                                  | HA analogue          | Responsibility                                                                                   |
| ---------------- | ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| **Physical**     | `devices`, `points`, `device_state`                     | Device / Entity      | What exists and what it measures. A device is a vendor connection; a point is a measured signal. |
| **Semantic**     | `areas`, `devices.area_id`, `area_bindings`, `derivations` | Area / Energy config | What the data _means_ (roles) and where it is.                                                   |
| **Presentation** | `dashboards`, `dashboard_grants`, `share_tokens`        | Dashboard / View     | What people see and share.                                                                       |

Two rules hold across all three:

- **Capabilities are derived at runtime, never stored.** What an area can show is computed from its
  points, not persisted and kept in sync.
- **Store choices and structure only.** Display names, headers, default layout, availability and
  timezone are resolved at render. This is what keeps documents small and rename-proof.

See [`home-assistant-comparison.md`](home-assistant-comparison.md) for how each layer scores against
HA — including where HA is ahead.

## 2. Physical: devices and points

- **Identity is deterministic.** `points.id` is `uuidv5(vendor : vendor_site_id : physical_path)`, so
  re-onboarding a device reproduces the same point ids (v7 fallback on collision). The public wire
  form is a TypeID (`pt_…`); `devices` are `dv_…`. The old per-device `(system_id, index)` address
  and its allocator are gone.
- **`rid` is internal only.** `points.rid` / `devices.rid` are compact integers for the hot
  time-series tables (`point_readings(point_rid, measurement_time)` and the aggregates). The seam
  rule is absolute: **uuids above, rids below**, with `lib/registry/registry-cache.ts` the only owner
  of the translation and a prebuild gate enforcing it.
- **A device is in 0 or 1 area** (`devices.area_id`, nullable) — Home Assistant's shape, and the
  only device→area edge since migration 0074 dropped `primary_area_id` and `area_members`. NULL is
  AMBIENT: a real state, not a broken one. Timezone and location live on the area, resolved through
  `lib/areas/placement.ts` so an ambient device still has both.

## 3. Semantic: areas, membership, bindings

**An Area is a grouping of 0..N member devices**, and a device is in at most one of them
(`devices.area_id`). There is no "composite" concept and no `kind` column — the single-vs-multi
distinction is purely structural (membership), and a zero-device area is legal.

🛑 **Membership is therefore a MOVE.** Putting a device in your area takes it out of whoever else's
it was in, deleting that area's bindings onto its points. Both the area-side verb
(`PUT /api/v4/areas/{id}/members`) and the device-side one (`PATCH /api/v4/devices/{id} { areaId }`)
go through `assertDevicesRehomable`, which asks ownership **or custody** rather than mere
readability — read access was a sufficient firewall only while membership was additive.

**The area-of-one is gone; onboarding places a device instead.** Until migration 0072 every device
minted a private area solely because `devices.primary_area_id` was NOT NULL — 14 of prod's 17 areas
were such shells. Those existing shells are **never deleted** (they key uuid-addressed history:
`point_readings_flow_attr_1d`, `battery_provenance_daily`) but nothing mints new ones. A newly
onboarded device is placed by `resolveOnboardingArea` (`lib/areas/onboarding.ts`): an **owned**
device goes to `users.default_area_id`, or to a site created for this connection and recorded as
their default if it is their first; an **ownerless** one is never placed. The reason it is placed
at all rather than left unassigned, HA-style, is that the area is the sole home of the display
timezone and the location, so an ambient onboarding would silently discard the site address the
vendor supplies at the one moment it offers it.

🛑 **An area's served point set is all-or-nothing, and this doc used to claim otherwise.** The rule
`PointManager._resolvePointsForHandle` actually implements is: **if the area has ANY binding, the
bound points are the ENTIRE set** — in every role — and the member union is skipped; only an area
with zero bindings falls back to the union of its members' points. It is not per-role, and the
visible set is not "always the union".

Two consequences worth stating plainly, because both are live today:

- **Adding a first binding NARROWS an area**, silently, from everything its devices produce to that
  one point. There is no warning and no error.
- **The live map disagrees with the charts.** `buildSubscriptionRegistry` (`lib/kv-cache-manager.ts`)
  unions bindings *and* member points, always — so a bound area's KV `latest` map carries points its
  history and Sankey do not serve. Nothing reconciles the two.

**This is decided, not merely noted: the union fallback is being retired** in favour of explicit
bindings only — one mode, where an area's point set simply *is* its bindings — which also makes the
KV and serving paths agree. Until that lands, the behaviour above is what the code does. See
[`../plans/20260914-bindings-and-area-settings.md`](../plans/20260914-bindings-and-area-settings.md).

**Within a role, resolution is explicit and ordered.** Each `(role, metric)` slot resolves through
one deterministic chain:

```
explicit binding (lowest `priority` wins) → auto shape-match (exactly ONE candidate)
  → area config producer (areas.config: generatorSource, …) → absent
```

Two candidates with no explicit binding is a **"needs your choice"** state surfaced in the editor,
never a silent pick; `GET /api/v4/areas/{id}/resolution` reports what resolved and how. Binding a
point whose `(logical_path, metric_type)` doesn't fit the role is **rejected at bind time**, not
flagged with an advisory dot.

**`priority` is a fallback chain, and what it orders is the SERVING KEY — not the slot.** A slot
legitimately holds several points with different logical paths (`load.hvac/power`, `load.pool/power`,
…): those are separate circuits and all of them serve. Two bindings sharing
`{logical_path}/{metric_type}` are two instruments measuring one quantity, and that string is
simultaneously the latest-hash field name and the middle of the series id — so exactly one can be the
area's answer. `lib/areas/binding-chain.ts` is the single definition, ordering by
(`points.active`, `priority`, `ordinal`, uuid); an inactive point cannot hold rank 0, because the
chain exists precisely to survive that.

Rank 0 serves history, charts and the Sankey: a stored series has one provenance, and stitching two
instruments under one series id would make that id a lie. The **live** map is where the chain moves —
fallbacks publish alongside the winner under `"{path}#{rank}"`, and `resolveChainFields`
(`lib/latest-values-store.ts`) promotes the best-ranked one whose measurement is within
`CHAIN_FALLBACK_STALE_MS`. Precedence is settled at READ time on purpose: it keeps the ingest path
free of a read-modify-write, and staleness can only be judged honestly at the moment it is asked.

Until this existed, only `resolveSlotsFromData` — reachable solely through the read-only
`/resolution` report — read `priority` at all. Every serving path took the bindings as an unordered
set, so binding two points to one slot produced a coin flip: Kinkora's `bidi.battery/soc` answered
both "304/304 days" and "81/304 days" to the same request, depending on which of two identical series
ids landed last.

⚠️ What this replaced was the **coin flip inside one slot**, not the all-or-nothing cliff above. An
earlier revision of this doc claimed the chain work retired that cliff too; it did not, and the two
are independent. The cliff is still there (see the top of this section), and `resolveChainFields`
only decides *which* of several instruments answers for one serving key.

**Role vocabulary lives in code** (`lib/roles/registry.ts`), enforced in SQL by
`area_bindings_role_check`. The `roles` table was a SQL projection of that registry — two sources of
truth — and is deleted.

**Derived signals have one mechanism.** `derivations` is config that computes a new signal from
existing points: `output='point'` produces a derived point in the normal readings pipeline (the HWS
thermal model), `output='intervals'` produces run/event periods in `derived_intervals` (generator
run-tracking, which also accumulates per-run cost / emissions / renewable). The old
`device_trackers` / `device_run_periods` pair is gone.

**Areas are organizational, not the access boundary.** Access is dashboard-scoped (§5).

## 4. Presentation: the dashboard document

A dashboard is a **named, owner-scoped composition**: `dashboards.doc` is a **recursive node tree**
(`db_…` public id, owner-unique `slug` for pretty URLs, frozen `legacy_id` backing the
`/dashboard/id/{n}` 301). There is no home system or area — every node carries its own context.

Two node kinds, and **card and tile are one primitive**:

- **`group`** — `{id, kind:'group', area?, device?, direction?, wrap?, heading?, size?, children[]}`,
  a first-class flex layout node.
- **`card`** — `{id, kind:'card', type, area?, device?, hidden?, size?, config?}`, the leaf. A "tile"
  is simply a small card; the split tile/card registries merge into one.

**Context inherits downward.** `area`/`device` on any node is inherited by descendants; a card
consumes the nearest binding. "Sections" stop being special — a group bound to an area _is_ a
section and renders the area header by default, so mixed-area composition falls out for free at any
depth.

**Layout is order + size**, on a 12-column grid, with group flex semantics — no `(x, y)`
coordinates. Absolute coordinates rot across breakpoints; order+size is where HA's sections view
landed after years of grid-layout pain, and it makes programmatic edits trivial ("move the chart
above the sankey" is one splice). Validation caps depth at ~4: HA's lesson is that arbitrary
nesting of cards-as-containers is what broke their visual editor.

**Why one JSONB document rather than normalized card rows.** Nothing queries cards in SQL; saves stay
atomic; a document is trivially copyable and exportable; and normalization would create two sources
of truth. What normalization would have bought — granular edits — is delivered more cheaply by
revisions plus a whole-document PUT.

**Editing is whole-doc PUT with optimistic concurrency.** `GET` returns an ETag of the revision;
`PUT` with `If-Match` returns 412 on a stale revision and echoes the normalized canonical document so
client state can't drift. `dashboard_revisions` keeps the edit history for cross-session undo (post-image rows, written since 2026-08-30 — the table predates its writers);
restore copies forward, never rewinds. `POST …/validate` is a dry-run for live linting.

**Validation posture.** The envelope is strict (zod; malformed ⇒ 422, never persisted, `id` assigned
when absent). Card `type` is an open string — unknown types persist with their `config` intact and
render a labelled placeholder, so a newer client or agent never has its config destroyed by an older
validator. Known types get strict per-type `config` schemas. References are always strict.

## 5. Sharing, scope and access

**The dashboard is the only unit of sharing.** There are no device or area ACLs: a device is readable
by its owner or platform admin (`owner_user_id IS NULL` means platform-public, e.g. the
OpenElectricity region devices), and everything else shares through a dashboard —
`dashboard_grants` (admin/viewer) or a `share_tokens` row (one token → one dashboard). The legacy
owner-scoped token system was folded into this one at the cutover; token strings survived verbatim,
so no shared URL broke.

Three invariants make that safe:

1. **Scope is recomputed live, never snapshotted.** A token's scope is whatever the dashboard binds
   _now_ — Dashboard → its nodes' refs → exactly those points. Consuming routes re-resolve on every
   read (`resolveDashboardReadPoints`, `lib/dashboard/access.ts`).
2. **Scope-bearing references live only in envelope fields** (`node.area`, `node.device`) — never
   inside a card's `config`. Share-scope derivation and the authoring no-escalation check are one
   type-agnostic tree walk over fixed positions, so a future or unknown card type can never smuggle
   in a reference the resolver doesn't see. Worst case a card 403s on fetch.
3. **The edge is fail-closed.** A `?access=` share link can't be validated inside Clerk middleware
   (the edge runtime has no Postgres), so middleware honours `?access=` **only** for GET/HEAD on
   share-eligible routes (`isShareableRoute`, `lib/route-matchers.ts` — the dashboard page plus the
   read-only data APIs its cards fetch). Anything else still hits `auth.protect()`; the token is
   validated downstream.

**No-escalation on authoring:** an owner can only add a node bound to an area or device they can
already read, enforced server-side on save.

**Remaining tightening:** scope is area-granular — a token holder gets the full point set of each
area the dashboard binds, not just the points its cards display. Point-level narrowing is a known
future tightening; the refs needed to do it are already in the document.

## 6. Rendering principles

These survived the v3→v4 transition and still govern the renderer.

- **One render path per card, no special cases.** Every card — whole-area or device-bound — goes
  through the same cell, self-fetches through the same query factory (React Query dedupes by key, so
  N cards on one area share one request), shows its own skeleton, then renders. When `oe-grid` was a
  bespoke self-fetching component beside the shared path, it loaded differently and popped in late;
  folding it in as a _view case_ removed a whole parallel path.
- **The skeleton count must equal the rendered count.** A seed that emits cards the device can't
  support produces a visible reflow when the grid collapses to what's available. Seeding filters to
  supported views; capability is derived, never stored.
- **Gates are data-driven, not vendor-driven.** The Sankey is not a "site vendor" feature — the whole
  pipeline is keyed on logical paths (`source.solar*`, `load`, `bidi.battery`, `bidi.grid`), so any
  area with both sources and loads qualifies. The renderer is the authority: when generation or load
  is missing, the flow selector returns null and the card renders nothing.
- **Resolver changes are gated by point-set parity.** Every change that touches point resolution
  asserts the per-area resolved point set is byte-identical pre/post. This caught real defects through
  three waves of composite retirement and the cutover itself, and for all of that time it was done BY
  HAND and left no artefact. It is a real gate now: `scripts/utils/area-point-set-parity.ts`
  (`snapshot` / `diff`, exit 1 on any change) drives the real `PointManager._resolvePointsForHandle`,
  so it exercises device-first dispatch, the bindings override and the membership union exactly as a
  request would. See
  [`../plans/area-point-set-parity-harness.md`](../plans/area-point-set-parity-harness.md).

## 7. Decisions this doc used to assert — now overturned

Recorded explicitly, because they were stated confidently here and people remember them.

| Was                                                                                                                                     | Now                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **"Not planned — retiring integer system addressing."** `areas.legacy_system_id` was called load-bearing addressing, kept deliberately. | **Overturned.** The integer handle is the clean sheet's _headline deletion_ — a polymorphic address where `≥1,000,000` meant "synthetic area" and nothing in the type system knew. It dies in Phase 13; `legacy_handles` resolves `?systemId=N` forever as a thin compat shim. |
| **"Areas are lazy"** — no area-of-one at create time, minted on demand.                                                                 | **Overturned (Option A, 2026-07-22), then RE-OVERTURNED (2026-09-14).** Existing areas-of-one are still never deleted — they key uuid-addressed history, so `retire-implied-areas.ts` is abandoned and must not run. But nothing mints new ones: migration 0072 dropped `primary_area_id`'s NOT NULL, which was the only thing forcing it, and 0074 dropped the column. Onboarding now PLACES a device (`resolveOnboardingArea`) rather than wrapping it — which is lazier than Option A for the second device of a site and eager-ish for the first, because the area is the sole home of timezone and location and dropping the vendor's address is worse than an extra area. |
| **"Ours is more general than HA — a device can belong to several areas."** `area_members` was many-to-many. | **Overturned (2026-09-14).** A device is in **0 or 1** area (`devices.area_id`), which is exactly HA's shape. The generality was never used for anything a human authored — it existed so a device could sit in both its area-of-one and its real site — and it cost two real defects: every Kutis EV run read $0.00 for two months because something had to GUESS which of a device's areas priced it, and the flow-eligibility guard exists only to stop a child area claiming its parent's Sankey. `area_members` was dropped by migration 0074. |
| **"An area must have at least one member."** Enforced in `replaceMembers`, `removeMember`, the create route and the builder dialog. | **Overturned (2026-09-14).** A zero-device area is first-class. The rule protected nothing — an area with no devices resolves to no points and drops out of flow eligibility on its own — and it is what forced "hide areas-of-one" to be a render-time convention instead of the structural "hide areas with no devices". |
| **"A device's own area cannot take a second member."** `PUT …/members` refused with `409 AREA_OF_ONE_CANNOT_ADD` whenever the Area's `legacy_system_id` also named a device. | **Overturned (2026-09-09).** A verbatim carry-over from the legacy `POST /devices` handler that protected nothing still relied on: `?systemId=N` resolves **device-first** (`lib/dashboard/subject.ts`, locked) so growing such an Area cannot widen the legacy alias, and `lib/kv-subjects.ts` already reads BOTH legs of a colliding handle and unions them. The state it forbade already existed — `liveone-dev` handle 13 is a real Sigenergy device AND a 3-member Area with 12 bindings — because server-managed writers never passed through the route. Retiring the integer handle itself is scoped in `docs/plans/retire-the-integer-handle.md`. |
| **"An area's visible point set is always the union of its members' points, and role resolution is per-role."** Stated in §3, together with the claim that the priority-chain work had retired v3's all-or-nothing cliff. | **Never true (corrected 2026-09-14).** This described an intent, not the code. `PointManager._resolvePointsForHandle` has always been all-or-nothing across the whole area: any binding, in any role, and the member union is skipped entirely. The chain work retired the *coin flip within one slot*, which is a different thing. The doc also contradicted itself — §6 correctly described the parity harness as exercising "the bindings override and the membership union". The fix is to remove the union rather than the cliff: bindings become the only mode. |
| **"Additive coexistence, NOT demolition"** — legacy per-system dashboards coexist with composition dashboards indefinitely.             | **Overturned.** Config-v4's definition of done is _one shape, not two_: no runtime branch on dashboard shape, no adapter, no rewriter, one card registry, one write surface. Phase 14 **dropped** `descriptor` (migration 0054).                                               |
| Points addressed by `(system_id, index)` with `point_uid` as a secondary stable identity.                                               | **Superseded.** `points.id` _is_ the identity and the address; the separate index and its allocator are gone.                                                                                                                                                                  |
| `dashboard_share_tokens` + legacy owner-scoped `share_tokens` as two systems.                                                           | **Unified** into one `share_tokens` table, one semantics.                                                                                                                                                                                                                      |
| `point_readings_flow_1d` as the flow matrix.                                                                                            | **Superseded** by `point_readings_flow_attr_1d`, which carries the attributed emissions / renewable / cost legs alongside energy.                                                                                                                                              |

## 8. What's next

- **HA export bridge (still open).** Export the semantic layer — areas + bindings + role
  `device_class` / `state_class` / `unit` metadata — as HA-consumable config. Read-only over the
  stable semantic layer, so it is additive: the role registry (`lib/roles/registry.ts`) already
  carries the metadata for exactly this purpose. ⚠️ **No export endpoint exists yet** — a
  `GET /api/v4/export` is the proposed shape, not a route you can call today. See
  [`../plans/ha-parity-and-leapfrog.md`](../plans/ha-parity-and-leapfrog.md) #9 for the more ambitious version, which
  pushes recomputed history _into_ an HA instance rather than just describing config.
- **The v4 dashboard configurator** — the largest remaining capability gap. The model supports
  adding, removing, reordering and hiding cards; there is **no UI** for it, only a hand-written
  whole-doc `PUT`. See [`../plans/v4-dashboard-configurator.md`](../plans/v4-dashboard-configurator.md).
- **Explicit bindings only (decided, not built).** Retire the membership-union fallback described in
  §3, so an area's point set simply *is* its bindings — one resolution mode instead of two that
  disagree, and the silent-narrowing cliff becomes unrepresentable. Also deletes
  `lib/grid/context.ts`: grid signals become an ordinary binding to the ambient OpenElectricity
  device rather than a location walk run inline on the dashboard server render. See
  [`../plans/20260914-bindings-and-area-settings.md`](../plans/20260914-bindings-and-area-settings.md).
- **Point-level share narrowing** (§5) — the one remaining access tightening.
- **Nobody consumes the resolver yet.** `GET /api/v4/areas/{id}/resolution` serves the deterministic
  per-slot resolution described in §3, but the battery-provenance fold still picks its inputs by
  `ordinal`, so reordering sources in the Bindings tab changes the report while the fold consumes a
  different point. See [`../plans/fold-on-the-resolver.md`](../plans/fold-on-the-resolver.md).
- **Twelve ranked enhancements** measured against Home Assistant:
  [`../plans/ha-parity-and-leapfrog.md`](../plans/ha-parity-and-leapfrog.md).

## 9. History

The v3 road to here — composite `systems` rows deleted and synthesized as areas-backed virtual
systems, the resolver unified on membership, the `kind` column dropped, sharing hardened, the
multi-area keystone, composition-first dashboards, the unified tile model, the generalized Sankey —
was documented phase-by-phase in earlier revisions of this file. That narrative is superseded and
lives in git; the surviving rationale has been folded into the sections above. The config-v4 story
from the clean sheet onward is in
[`../plans/completed/config-v4-clean-sheet.md`](../plans/completed/config-v4-clean-sheet.md) and
[`../plans/completed/config-v4-execution-plan.md`](../plans/completed/config-v4-execution-plan.md).

## Related docs

- [`home-assistant-comparison.md`](home-assistant-comparison.md) — the scorecard against HA.
- [`../plans/ha-parity-and-leapfrog.md`](../plans/ha-parity-and-leapfrog.md) — twelve ranked enhancements.
- [`data-model.md`](data-model.md) — data semantics & invariants, including point paths, metric
  types and identity.
- [`energy-flow-matrix.md`](energy-flow-matrix.md) — the directional Sankey matrix.
- [`battery-provenance.md`](battery-provenance.md) — the attributed metric legs.
- [`authentication.md`](authentication.md) — Clerk, roles, API auth functions.
