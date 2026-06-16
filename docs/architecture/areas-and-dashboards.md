# Areas & Dashboards

> Status: foundation live · Phase 1 (sharing hardening) done · Phase 2a (default dashboard + multi-area
> scope seam) done · Phase 2b (multi-area composition UI) + Phase 3 planned.
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

**Areas are organizational, not the access boundary.** Access is **area/system-granular** (Phase 2a: a
share's scope is the union of its dashboard's card areas); point-level narrowing within an area is a future
tightening (Phase 2b/3).

## 2. Dashboards & sharing

A `dashboard` is per-user, per-system today (`(clerk_user_id, system_id)` unique). Its content is an
**opaque `descriptor` JSONB** parsed client-side. `dashboards.area_id` (nullable) is a forward seam: the
dashboard's **default/home area** (see §3).

**The dashboard is the unit of sharing** (shipped, no flag): `dashboard_share_tokens` (read-only public
links, expiry/revoke) and `dashboard_grants` (membership: `owner|admin|viewer`).

**Scope.** `resolveDashboardReadPoints` (`lib/dashboard/access.ts`) resolves a share's read scope as the
**union of the dashboard's card areas** (Phase 2a): the dashboard's default area (`dashboards.area_id`) ∪
each card's `areaId` (a descriptor field — see §3), every area uuid → its `legacy_system_id` → points.
`requireDashboardAccess` enforces it: a token authorizes `?systemId=X` only when X is in that union
(today's single-area dashboards → the singleton `{systemId}`, so it's inert until multi-area cards exist).
This is **area/system-granular**: full point set per area. Point-level narrowing within an area (a card
binding a single role/point subset) is the future tightening — `points[]` already carries the exact refs.

**Invariant — scope is recomputed live, never snapshotted.** A token's scope is whatever the dashboard
binds _now_; consuming routes re-resolve on every read.

**Edge bypass (hardened, Phase 1).** A `?access=` share link can't be validated inside Clerk middleware
(the edge runtime has no Postgres), so the token is validated downstream by `requireDashboardAccess`. The
edge is fail-closed instead: middleware honours `?access=` **only** for GET/HEAD requests to
share-eligible routes (`isShareableRoute` in `lib/route-matchers.ts` — the dashboard page + the read-only
data APIs its cards fetch). A stray token on any other route (admin, test, mutations) still hits
`auth.protect()`. Per-card point _narrowing_ (returning less than the whole system to a token holder) is a
no-op today — a dashboard's scope already equals its whole system — and lands with the multi-area cards
(Phase 2b/3); Phase 2a already enforces the area/system-level union in `requireDashboardAccess`.

## 3. The multi-area future

The end-state is a dashboard that **composes cards from multiple areas** on one screen (e.g. house, farm,
EV, grid region), making dashboard↔area conceptually **many-to-many**.

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

**Design commitments this implies:**

- **Addressing decouples from `systemId`.** A multi-area dashboard can't be keyed on one system, so
  dashboards become **first-class, id/alias-addressable**. Multi-area and dashboards-as-first-class are the
  same project.
- **Sharing scope becomes the live union across card areas.** An owner can only add a card for an area
  they can already read (no escalation), and a shared multi-area dashboard is a capability bundle — surface
  "exposes data from N areas".
- **The areas model is undisturbed** — every system keeps its identity area; multi-area dashboards are pure
  presentation-layer composition on top.
- **Default dashboard.** `users.default_system_id` is the wrong concept here; it becomes
  `users.default_dashboard_id → dashboards.id` (Phase 2a — shipped). `default_system_id` is kept as a
  legacy fallback that `getValidDefaultDashboardId` lazily migrates + keeps in sync; the home redirect
  still resolves to `/dashboard/{systemId}` (single-area), so it's inert until a dashboard can differ from
  a system (Phase 2b).

## 4. Roadmap

Legend: ✅ shipped · ◑ in progress · ⬜ planned. Migration high-water mark: **0016**. All schema work
follows `docs/migrations.md` (additive/forward-only, `DO`/`RAISE` guards before any drop, never
`drizzle-kit push`).

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

The forward-correct seams that make the multi-area UI (2b) purely additive, landed as one additive
migration (`0016`: `users.default_dashboard_id`) + code. Both are inert under today's single-area UX by
design. (1) **Default dashboard:** `users.default_dashboard_id → dashboards.id`, lazily migrated from (and
kept in sync with) the legacy `default_system_id`; the home redirect, preferences API, and settings dialog
are unchanged (they ride thin wrappers — `getValidDefaultSystemId`/`setDefaultSystem`). (2) **Multi-area
scope seam:** an optional `ModuleCardInstance.areaId` on the descriptor (no `dashboard_cards` table — see
§3); `resolveDashboardReadPoints`/`allowedSystemIds` (`lib/dashboard/access.ts`) widened to the union
across card areas; `requireDashboardAccess` authorizes `?systemId=X` by **membership in that union**
(covers `/api/data`, `/api/history`, `/api/energy-flow-matrix`). No `dashboard_cards`, no data migration.

### Phase 2b — Multi-area composition UI (keystone) — ⬜

The pivot that unlocks §3 and the bulk of the remaining value, on top of the 2a seams. Add
`alias`/`display_name` to `dashboards` (the `id` PK already exists); relax the `(clerk_user_id, system_id)`
uniqueness so a user can hold multiple dashboards; address dashboards by id/alias; build the card-picker UI
to add cards from other readable areas (with the **no-escalation authoring-time check** — an owner can
only add a card for an area they can already read — and the "exposes data from N areas" surface); widen the
shared-view `latest` fetch to union across card areas; optional point-level narrowing. Depends on 2a.

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
