# Areas & Dashboards

> **Status:** current — **rewritten 2026-07-28 for config-v4.** This doc holds the _why_ and the
> invariants of the three-layer split (physical / semantic / presentation). Columns, types and routes
> live in code: `lib/db/planetscale/schema.ts` is the schema source of truth (Drizzle is
> authoritative — never hand-rolled SQL, never `drizzle-kit push`).
>
> **Config-v4 supersedes this doc on design decisions.** Where the two disagree,
> [`../plans/config-v4-clean-sheet.md`](../plans/config-v4-clean-sheet.md) wins; three decisions this
> doc used to assert have been **overturned** and are recorded as such in §7. This describes the v4
> model as designed and delivered — for what is live today vs. still finishing, see
> [`../plans/config-v4-execution-plan.md`](../plans/config-v4-execution-plan.md).

## 1. The three layers

The initiative splits three concerns that the old `systems` table fused (a "composite system" mixed
physical collection, semantic grouping, and presentation). The split follows Home Assistant's
vocabulary and the Apple Home / Health model: **a good auto-generated default, customizable on top —
not a blank canvas.**

| Layer            | Tables                                                  | HA analogue          | Responsibility                                                                                   |
| ---------------- | ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| **Physical**     | `devices`, `points`, `device_state`                     | Device / Entity      | What exists and what it measures. A device is a vendor connection; a point is a measured signal. |
| **Semantic**     | `areas`, `area_members`, `area_bindings`, `derivations` | Area / Energy config | What the data _means_ (roles) and where it is.                                                   |
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
- **A device belongs to exactly one primary area** (`devices.primary_area_id`, NOT NULL) and may be a
  member of others. Timezone and location live **only** on the area.

## 3. Semantic: areas, membership, bindings

**An Area is a grouping of 1..N member devices** (`area_members`). An **area-of-one** wraps a single
device; a **multi-device area** groups several. There is no "composite" concept and no `kind` column
— the single-vs-multi distinction is purely structural (membership).

**Areas are eager.** Every device gets or joins an area at onboarding, and the area is the sole home
for `day_offset_min` / `display_timezone` / `location` / site-level `config`. Areas-of-one are
filtered out of the user-facing area picker at render time, never deleted — they hold the tz/location
and they key uuid-addressed history (`point_readings_flow_attr_1d`, `battery_provenance_daily`).

**Role resolution is per-role and explicit.** An area's _visible point set_ is always the union of
its members' points. Its _role resolution_ is per-role: if bindings exist for role R they define R;
otherwise R derives from members' points by stem match. Each `(role, metric)` slot resolves through
one deterministic chain:

```
explicit binding (lowest `priority` wins) → auto shape-match (exactly ONE candidate)
  → area config producer (areas.config: generatorSource, exportTariff, …) → absent
```

Two candidates with no explicit binding is a **"needs your choice"** state surfaced in the editor,
never a silent pick; `GET /api/v4/areas/{id}/resolution` reports what resolved and how. Binding a
point whose `(logical_path, metric_type)` doesn't fit the role is **rejected at bind time**, not
flagged with an advisory dot.

This replaced v3's all-or-nothing cliff, where adding one binding silently switched an area from
"union of members' points" to "bindings select everything".

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
client state can't drift. `dashboard_revisions` keeps the recent history for cross-session undo;
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
- **Resolver changes are gated by parity assertions.** Every change that touches point resolution
  asserts the per-area resolved point set is byte-identical pre/post. This caught real defects
  through three waves of composite retirement and the cutover itself.

## 7. Decisions this doc used to assert — now overturned

Recorded explicitly, because they were stated confidently here and people remember them.

| Was                                                                                                                                     | Now                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **"Not planned — retiring integer system addressing."** `areas.legacy_system_id` was called load-bearing addressing, kept deliberately. | **Overturned.** The integer handle is the clean sheet's _headline deletion_ — a polymorphic address where `≥1,000,000` meant "synthetic area" and nothing in the type system knew. It dies in Phase 13; `legacy_handles` resolves `?systemId=N` forever as a thin compat shim. |
| **"Areas are lazy"** — no area-of-one at create time, minted on demand.                                                                 | **Overturned (Option A, 2026-07-22).** Areas are **eager**: every device gets one at onboarding, because the area is the sole home for tz/location and keys uuid-addressed history. `retire-implied-areas.ts` is abandoned and must not run.                                   |
| **"Additive coexistence, NOT demolition"** — legacy per-system dashboards coexist with composition dashboards indefinitely.             | **Overturned.** Config-v4's definition of done is _one shape, not two_: no runtime branch on dashboard shape, no adapter, no rewriter, one card registry, one write surface. Phase 14 drops `descriptor`.                                                                      |
| Points addressed by `(system_id, index)` with `point_uid` as a secondary stable identity.                                               | **Superseded.** `points.id` _is_ the identity and the address; the separate index and its allocator are gone.                                                                                                                                                                  |
| `dashboard_share_tokens` + legacy owner-scoped `share_tokens` as two systems.                                                           | **Unified** into one `share_tokens` table, one semantics.                                                                                                                                                                                                                      |
| `point_readings_flow_1d` as the flow matrix.                                                                                            | **Superseded** by `point_readings_flow_attr_1d`, which carries the attributed emissions / renewable / cost legs alongside energy.                                                                                                                                              |

## 8. What's next

- **HA export bridge (still open).** Export the semantic layer — areas + bindings + role
  `device_class` / `state_class` / `unit` metadata — as HA-consumable config. Read-only over the
  stable semantic layer, and `GET /api/v4/export` is most of the payload already. See
  [`../plans/ha-parity-and-leapfrog.md`](../plans/ha-parity-and-leapfrog.md) #9 for the more ambitious version, which
  pushes recomputed history _into_ an HA instance rather than just describing config.
- **Config-v4 Phases 12–14** finish the model: drop `systems` / `point_info` / `roles`, kill the
  handle, collapse the two dashboard shapes, build the v4 editor and the remaining mutation routes.
  Tracked in [`../plans/config-v4-execution-plan.md`](../plans/config-v4-execution-plan.md).
- **Point-level share narrowing** (§5) — the one remaining access tightening.
- **Twelve ranked enhancements** measured against Home Assistant:
  [`../plans/ha-parity-and-leapfrog.md`](../plans/ha-parity-and-leapfrog.md).

## 9. History

The v3 road to here — composite `systems` rows deleted and synthesized as areas-backed virtual
systems, the resolver unified on membership, the `kind` column dropped, sharing hardened, the
multi-area keystone, composition-first dashboards, the unified tile model, the generalized Sankey —
was documented phase-by-phase in earlier revisions of this file. That narrative is superseded and
lives in git; the surviving rationale has been folded into the sections above. The config-v4 story
from the clean sheet onward is in
[`../plans/config-v4-clean-sheet.md`](../plans/config-v4-clean-sheet.md) and
[`../plans/config-v4-execution-plan.md`](../plans/config-v4-execution-plan.md).

## Related docs

- [`home-assistant-comparison.md`](home-assistant-comparison.md) — the scorecard against HA.
- [`../plans/ha-parity-and-leapfrog.md`](../plans/ha-parity-and-leapfrog.md) — twelve ranked enhancements.
- [`points.md`](points.md) — the point model, paths, and identity.
- [`data-model.md`](data-model.md) — data semantics & invariants.
- [`energy-flow-matrix.md`](energy-flow-matrix.md) — the directional Sankey matrix.
- [`battery-provenance.md`](battery-provenance.md) — the attributed metric legs.
- [`authentication.md`](authentication.md) — Clerk, roles, API auth functions.
