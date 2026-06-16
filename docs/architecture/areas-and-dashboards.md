# Areas & Dashboards

> Status: foundation live · Phase 1 (sharing hardening) done · Phase 2a (default dashboard + scope seam)
> done · Phase 2b-1 (multi-area cards) done · Phase 2b-2 (first-class composition dashboards) done (additive,
> legacy per-system path kept) · Phase 3 planned.
> Schema source of truth: `lib/db/planetscale/schema.ts` (Drizzle is authoritative — never hand-rolled
> SQL, never `drizzle-kit push`). This doc holds the _why_ and the invariants; columns and routes live in
> code.

## 1. Model

The initiative splits three concerns that the old `systems` table fused (a "composite system" mixed
physical collection, semantic grouping, and presentation). The split follows Home Assistant's vocabulary
and the Apple Home / Health model: **a good auto-generated default, customizable on top — not a blank
canvas.**

| Layer            | Tables                            | HA analogue          | Responsibility                                                                              |
| ---------------- | --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| **Physical**     | `systems`, `point_info`           | Device / Entity      | Where data is collected. A `system` is a vendor connection; a `point` is a measured signal. |
| **Semantic**     | `areas`, `area_bindings`, `roles` | Area / Energy config | What the data _means_. Typed role→point edges.                                              |
| **Presentation** | `dashboards`, dashboard cards     | Dashboard / View     | How a user sees it. Per-user layout.                                                        |

- **Points** are addressed by `(system_id, index)` but also carry a deterministic `point_uid` (uuidv5) —
  a stable identity that survives re-addressing.
- **Every system gets a 1:1 identity Area** (`areas.kind='identity'`). **Composites are areas-backed
  virtual systems** (`kind='composite'`) with no `systems` row — `SystemsManager.synthesizeCompositeSystem`
  reconstructs them on demand, keyed on `areas.legacy_system_id` (the old `systems.id`), preserving integer
  addressing with no UUID rewrite.
- **`area_bindings` is the sole role→point source**; **`roles` is the single source of truth for role
  semantics** (the HA `device_class`/`state_class`/unit/aggregability registry, projected from
  `lib/roles/registry.ts`).

**Invariants.** Identity is append-only — areas map 1:1 to a system or a former composite; we never re-key
an area in place. The flow matrix (`point_readings_flow_1d`) was _re-keyed_ from `system_id` to `area_id`
with byte-identical rows — never recomputed.

**Areas are organizational, not the access boundary.** Access is **area/system-granular** (a share's scope
is the union of its dashboard's card areas); point-level narrowing within an area is a future tightening.

## 2. Dashboards & sharing

A `dashboard` is **first-class** (Phase 2b-2): an owner-scoped, named, id/alias-addressable row whose
content is an **opaque `descriptor` JSONB** (parsed client-side) — an ordered list of cards, each bound to
its own Area (`cards[i].areaId`). A **composition dashboard** has **no home system/area** (`system_id` and
`area_id` are null); it's addressed by `/dashboard/{user}/id/{id}` or `/dashboard/{user}/{shortname}`
(`alias`, owner-unique). The **legacy per-system dashboards** (one row per `(clerk_user_id, system_id)`,
reached at `/dashboard/{systemId}`) **coexist** unchanged — they carry `system_id`/`area_id`; composition
dashboards leave both null (the additive `0017` schema makes `system_id` nullable so both live in one
table). See §3 for why the card — not a table — is the dashboard↔area junction.

**The dashboard is the unit of sharing** (shipped, no flag): `dashboard_share_tokens` (read-only public
links, expiry/revoke) and `dashboard_grants` (membership: `owner|admin|viewer`).

**Scope.** `resolveDashboardReadPoints` (`lib/dashboard/access.ts`) resolves a share's read scope as the
**union of the dashboard's card areas**: the dashboard's home area (`dashboards.area_id`, null for a
composition dashboard) ∪ each card's `areaId`, every area uuid → its `legacy_system_id` → points.
`requireDashboardAccess` enforces it: a token authorizes `?systemId=X` only when X is in that union — a
multi-area dashboard exposes exactly its card areas, a legacy single-area dashboard the singleton
`{systemId}`. This is **area/system-granular**: full point set per area. Point-level narrowing within an
area (a card binding a single role/point subset) is the remaining future tightening — `points[]` already
carries the exact refs.

**Invariant — scope is recomputed live, never snapshotted.** A token's scope is whatever the dashboard
binds _now_; consuming routes re-resolve on every read.

**Edge bypass (hardened, Phase 1).** A `?access=` share link can't be validated inside Clerk middleware
(the edge runtime has no Postgres), so the token is validated downstream by `requireDashboardAccess`. The
edge is fail-closed instead: middleware honours `?access=` **only** for GET/HEAD requests to
share-eligible routes (`isShareableRoute` in `lib/route-matchers.ts` — the dashboard page + the read-only
data APIs its cards fetch). A stray token on any other route (admin, test, mutations) still hits
`auth.protect()`. The area/system-level union is enforced in `requireDashboardAccess` (2a); per-card point
_narrowing_ within an area (returning less than the whole area's point set to a token holder) is the one
remaining future tightening.

## 3. The multi-area model (shipped, Phase 2b)

A dashboard **composes cards from multiple areas** on one screen (e.g. house, farm, EV, grid region) —
dashboard↔area is **many-to-many**. Each card self-fetches its own Area's data; there is no privileged
"home" system on a composition dashboard.

**The junction is the card, carried on the descriptor — not a `dashboard_areas` table, nor a normalized
`dashboard_cards` table:**

```
dashboard.descriptor.cards[i].areaId  →  1 area   (null/absent = the dashboard's default area)
```

A dashboard's areas are the distinct card `areaId`s (∪ its default `dashboards.area_id`). A direct
`dashboard_areas` junction is wrong because (1) it's redundant — you still need per-card area for
position/layout; (2) area is too coarse — a card often binds a single role or point subset;
(3) layout/order/visibility are already per-card.

**Why a descriptor field, not a normalized `dashboard_cards` table (Phase 2a decision):** a card's area is
_composition/presentation_ data that belongs with its layout — which already lives in the descriptor
JSONB. Normalizing cards into rows buys SQL-queryability that nothing needs (HA export, Phase 3, reads the
_semantic_ layer — `areas`/`area_bindings`/`roles` — not dashboards), and a _partially_-normalized table
(area in a row, layout in JSONB) is strictly worse — two sources of truth to sync. So `areaId` is an
optional field on `ModuleCardInstance`; `dashboards.area_id` stays the default/home area. This also
eliminated the descriptor→rows dual-read data migration.

**Design commitments (all shipped):**

- **Addressing decoupled from `systemId`.** A multi-area dashboard can't be keyed on one system, so
  dashboards are **first-class, id/alias-addressable** (`/dashboard/{user}/id/{id}` and
  `/dashboard/{user}/{shortname}`). Multi-area and dashboards-as-first-class were the same project.
- **Sharing scope is the live union across card areas.** An owner can only add a card for an area they can
  already read (the no-escalation authoring check, enforced server-side on save). _Deferred polish:_ a
  "shared dashboard exposes data from N areas" surface in the share UI.
- **The areas model is undisturbed** — every system keeps its identity area; composition dashboards are pure
  presentation-layer composition on top.
- **Default dashboard.** `users.default_dashboard_id → dashboards.id` (Phase 2a). `setDefaultDashboardById`
  (owner-only) points it at a composition dashboard (null `default_system_id`); the `/dashboard` landing
  resolves it via `resolveDefaultDashboardRoute` → `/dashboard/id/{id}` (composition) or
  `/dashboard/{systemId}` (legacy, lazily migrated from `default_system_id`).

## 4. Roadmap

Legend: ✅ shipped · ◑ in progress · ⬜ planned. Migration high-water mark: **0017**. All schema work
follows `docs/migrations.md` (additive/forward-only, `DO`/`RAISE` guards before any drop, never
`drizzle-kit push`).

> ⚠️ **Deploy gate (see `docs/incidents/2026-06-16-…`):** PG migrations are **manual**, not applied at
> deploy. Apply a schema-dependent PR's migration to prod `sydney` **before** merging the code, or prod
> 500s. `0017` is on `liveone-dev` + this branch only — apply it to `sydney` before 2b-2 merges.

### Foundation — ✅ shipped

Semantic schema (`areas`, `area_bindings`, `roles`); composite retirement (composite `systems` rows
deleted, synthesized as areas-backed virtual systems; `CompositeAdapter` + `AREAS_TABLE` flag retired);
flow matrix re-keyed to `area_id`; dashboards + sharing (`dashboard_share_tokens`, `dashboard_grants`,
shared view, `/api/dashboard-share/[token]`); point identity (`point_info.point_uid`); split admin pages.

### Phase 1 — Harden sharing — ✅ done

Scoped the `?access=` edge bypass: middleware now honours the share-link bypass **only** for GET/HEAD
requests to share-eligible routes (`isShareableRoute` — the dashboard page + the read-only data APIs its
cards fetch), so a stray/garbage token can no longer skip Clerk on admin/test/mutation routes (it closed,
e.g., `/api/test/cache`). The token is validated downstream by `requireDashboardAccess`. No schema change.
Edge token validation was rejected — the edge runtime has no Postgres. Per-card point narrowing is folded
into Phase 2 (it's a no-op until cards exist).

### Phase 2a — Default dashboard + multi-area scope seam — ✅ done

The forward-correct seams that made the multi-area UI (2b) purely additive, landed as one additive
migration (`0016`: `users.default_dashboard_id`) + code. Both were inert under the then-single-area UX by
design (now exercised by 2b). (1) **Default dashboard:** `users.default_dashboard_id → dashboards.id`, lazily migrated from (and
kept in sync with) the legacy `default_system_id`; the home redirect, preferences API, and settings dialog
are unchanged (they ride thin wrappers — `getValidDefaultSystemId`/`setDefaultSystem`). (2) **Multi-area
scope seam:** an optional `ModuleCardInstance.areaId` on the descriptor (no `dashboard_cards` table — see
§3); `resolveDashboardReadPoints`/`allowedSystemIds` (`lib/dashboard/access.ts`) widened to the union
across card areas; `requireDashboardAccess` authorizes `?systemId=X` by **membership in that union**
(covers `/api/data`, `/api/history`, `/api/energy-flow-matrix`). No `dashboard_cards`, no data migration.

### Phase 2b-1 — Multi-area cards (compose other Areas onto a dashboard) — ✅ done

The §3 keystone screen value on top of the 2a seams, **no schema change**. A user can **add a card from
another Area they can read** in the Customize dialog (pick a card type + an Area). Off-area cards carry an
`areaId` on the descriptor and render in a labelled multi-area section — each a self-contained component
that fetches its OWN area's data via the existing per-systemId query factories (the Local Grid (NEM) card's
proven cross-system pattern); v1 composes `tiles`, `chart`, `amber-timeline`, `generator-runs`
(`lib/dashboard/multi-area.ts`; sankey/grid-signals/amber-now stay page-scoped). Area enumeration is
`listReadableAreas` → `GET /api/areas/readable` (authed) / a server-resolved sidecar for the shared view.
The **no-escalation authoring check** is enforced at save (`PUT /api/dashboard/[systemId]` rejects a card
binding an Area the owner can't read); the runtime read scope was already the live union (2a), so a shared
multi-area dashboard's per-area fetches are token-authorized with no payload change. The page's own cards
still render via the existing template (off-area cards append below) — a full template→descriptor-iteration
re-layout (arbitrary interleave) is deferred.

### Phase 2b-2 — First-class, composition-first dashboards — ✅ done (additive; legacy path kept)

The full §3 model: a dashboard is a **named, owner-scoped composition** — `descriptor` is an ordered list
of cards, each bound to its OWN Area, with **no home system/area** (the renderer iterates cards and each
self-fetches; the 2b-1 `MultiAreaCards` mechanism generalized to be _the_ renderer). Addressed by id
(`/dashboard/{user}/id/{id}`) or `alias` (`/dashboard/{user}/{shortname}`); the legacy
`/dashboard/{systemId}` per-system view **coexists** (it was not retired — see the decision below).
Create = "New dashboard" in the header menu (seed from an Area's default cards _or_ start empty);
configure = add cards (any type, any readable Area) / reorder / rename / delete / set-default.
`users.default_dashboard_id` (2a) drives the landing redirect.

**Staged additively** so the app stays green at every step (the old per-system path keeps working):

- **Foundation — ✅ done.** Migration `0017` (additive): `dashboards` gains `display_name` + `alias`
  (owner-unique), `system_id` made NULLABLE so composition rows (null `system_id`) coexist with legacy
  rows. Composition descriptor helpers (`lib/dashboard/composition.ts`: `buildSeedDescriptor` /
  `emptyCompositionDescriptor` / `descriptorAreaIds`); CRUD store (`lib/dashboard/dashboards.ts`) + API
  (`/api/dashboards`, `/api/dashboards/[id]`) with the no-escalation authoring check; scope/auth
  (`allowedSystemIds`) generalized to a null home systemId.
- **Renderer + routing + create/manage UI — ✅ done.** `CompositionDashboard` renders the whole ordered
  descriptor for ALL card types, each area-bound + self-fetching (tiles, chart lines/stacked, sankey,
  amber-now, amber-timeline, generator-runs, grid-signals — the last via a server-resolved per-Area NEM
  region). Addressed by id (`/dashboard/id/{id}` and `/dashboard/{user}/id/{id}`) in the `[...slug]` route.
  `NewDashboardDialog` (name + optional seed-from-Area) is reachable from the header "New Dashboard…" item;
  `CompositionDashboardClient` wraps the renderer with Customize (the reused dialog in composition mode —
  no page tile grid / Reset) + Rename/shortname + Delete. CRUD via `/api/dashboards*`.
- **Addressing + default landing — ✅ done.** Pretty owner-scoped URL `/dashboard/{user}/{shortname}`
  (resolves username→owner via Clerk, then `getDashboardByOwnerAlias`; tried before the legacy system
  username/alias route and falls through when no owned composition dashboard matches). The `/dashboard`
  landing redirects via `resolveDefaultDashboardRoute` — a composition default → `/dashboard/id/{id}`, a
  legacy default → `/dashboard/{systemId}`. "Set as my default dashboard" (`setDefaultDashboardById`,
  owner-only) writes `users.default_dashboard_id` with a null `default_system_id`.

_Known low-severity follow-ups (from the 2b-2 adversarial review, all deferred):_ the
`/dashboard/{user}/{shortname}` path does a Clerk `getUserList` before falling through to the legacy
system-alias route (one extra round-trip on that path); `resolveDefaultDashboardRoute` re-reads prefs+dash
for the legacy-default case; the "exposes data from N areas" share surface; point-level narrowing within an
area.

**Decision (2026-06-16) — additive coexistence, NOT demolition.** The full retirement of the per-system
path (deleting `DashboardClient` + the `heatmap/generator/amber/latest` subpages + the systems dropdown +
`/api/dashboard/[systemId]` + migration `0018` dropping `system_id`/`area_id`) was **declined**: it is an
app-wide demolition that removes the system-viewing UX and is **not required** — the additive `0017` schema
lets composition dashboards (`display_name` rows) and legacy per-system customizations (`system_id` rows)
coexist in one table. The per-system `DashboardClient` view stays; composition dashboards are first-class
additions on top. `0018` and any deletion are deferred indefinitely (revisit only with a concrete driver).

### Phase 3 — Home Assistant export — ⬜

Export the semantic model (areas + bindings + role/device_class metadata) into HA-consumable config.
Read-only over the stable semantic layer; independent of Phase 2.

### Not planned — retiring integer system addressing

The old roadmap listed "drop `areas.legacy_system_id` + the integer `system_id` handles" as cleanup. It is
**not** cleanup: `legacy_system_id` is the **load-bearing integer addressing seam** for composites — it
backs `SystemsManager.getSystem(n)`, the `latest:system:N` KV keyspace, the `device_run_periods` /
`device_trackers` keys, and `dashboards.system_id`. Composites have no `systems` row, so this integer
handle (via `synthesizeCompositeSystem`) is _how they are addressed at all_. Removing it means moving every
caller to UUID (`area.id`) addressing and re-keying the KV space and those tables — a multi-week
rearchitecture with no current driver. Treat the integer handle as a deliberate, stable part of the design;
revisit only if a concrete need (not tidiness) appears.

### Dependencies

The foundation gates everything. Phase 2a (done) gates Phase 2b. Phase 3 is independent of Phase 2 and can
proceed in parallel.
