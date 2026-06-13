# Areas & Dashboards — separating the logical layer from the physical layer

> **Status:** plan — proposed 2026-06-13. A forward-looking design/direction-of-travel doc, not yet
> implemented. The **proposed schema below is not approved** — it is illustrative; any DDL is gated by
> the "ask before modifying the schema" rule. Schema source of truth remains
> `lib/db/planetscale/schema.ts`.

## TL;DR

Today one table — `systems` — carries three different concerns: a **physical** device we poll, a
**logical** role-set ("composite system"), and, implicitly, a **presentation** layout (a `vendor_type`
if/else ladder). This doc proposes splitting them into three first-class layers and adopting Home
Assistant vocabulary so an HA export bridge is a near-term milestone, not a rewrite:

- **Physical** — **System** (a device) + **Point** (an atomic signal ≈ HA _entity_). Unchanged.
- **Semantic** — an **Area**: a named role-set that binds physical points into a coherent energy site
  (solar/battery/load/grid…). Replaces `vendor_type='composite'`.
- **Presentation** — a **Dashboard** of **Cards**: ordered, typed widgets bound to roles/points.
  Replaces the render ladder; layout becomes data.

UX follows **Apple Home / Apple Health**: a great auto-generated default you lightly curate
(pin/reorder/hide favorites + an "Add Card" gallery), never a blank canvas. **Sharing is per-Dashboard**
— a dashboard is the unit of both membership and public links, and a viewer gets read access to exactly
the points that dashboard's cards bind.

---

## Why (the problem)

`systems` is the physical layer — one row per real, pollable installation (credentials, polling health,
timezone). A **composite system** reuses that exact row to mean a _logical_ combination across devices.
Stacking a logical (and presentation) concept onto the physical row produces five concrete symptoms:

1. **A composite is a fake `systems` row.** `vendor_type='composite'`, but it never polls, holds no
   credentials, and owns no points. It still mints a bogus `vendor_site_id` (`uuidv7()` in
   `app/api/systems/route.ts`), gets an unused `polling_status` row, and registers as a pseudo-vendor
   (`lib/vendors/registry.ts`, `lib/vendors/composite/adapter.ts`). It carries irrelevant columns
   (`model`/`serial`/`ratings`/`solar_size`/`battery_size`).

2. **The role→point mapping is untyped JSON, and different code paths read different shapes of it.**
   `systems.metadata` has no FK and no DB-level validation, and there isn't even one format:
   - `{ version:2, mappings:{ solar:["1.5"], … } }` — written by `app/api/systems/route.ts` and the
     `composite-config` PATCH; read by `PointManager` when resolving a composite's points.
   - `{ base_system, overrides }` — what `lib/vendors/composite/adapter.ts` (`getLastReading`) actually
     reads to combine live values.
   - a v1 path-string form (`"liveone.system1.source.solar…"`) — appears in older docs only, implemented
     nowhere.
     So point _resolution_ and live-value _combination_ consume different shapes of the same field.

3. **The role taxonomy is a hardcoded 4-role schema** (`solar`/`battery`/`load`/`grid`[/`ev`])
   duplicated across four files — add a role (EV, hot water, pool, generator, tariff) and you edit all
   four:
   - `lib/aggregation/logical-system.ts` (`isCompleteRoleSet`)
   - `lib/vendors/composite/adapter.ts`
   - `lib/system-summary-store.ts` (`aggregateSummaryReadings`)
   - `components/CompositeTab.tsx`

4. **Presentation is a `vendor_type` if/else ladder, not data.** `components/DashboardClient.tsx`
   branches `amber` / `mondo`|`composite` / else; which cards appear is implicit — each renders **iff**
   the matching point exists (`app/components/cards/SystemPowerCards.tsx`:
   `solarValue !== null`, `hasTeslaData = latest['ev.battery/soc'] !== null`). Layout is fixed per
   type; there is no user customization.

5. **Access is system-granular only.** `requireSystemAccess` (`lib/api-auth.ts`) + `user_systems`
   (owner/admin/viewer) + `share_tokens` (scoped to an owner's systems) + `users.default_system_id`. A
   viewer gets all-or-nothing; share-token _consumption_ (`GET /api/share-tokens/[token]`) isn't even
   built.

**What's already right.** `point_info` cleanly separates `physical_path_tail` (vendor identity) from
`logical_path_stem` + `metric_type` (semantic identity); `resolveLogicalSystem`
(`lib/aggregation/logical-system.ts`) already unifies "composite" and "single system" into one shape;
and `point_readings_flow_1d.system_id` is already documented as a "logical system / view id." The
semantic vocabulary exists at the _point_ level — this design lifts it to first-class Areas and
Dashboards.

---

## The three layers + vocabulary

| Concept                | LiveOne                                             | Home Assistant       | Apple                       |
| ---------------------- | --------------------------------------------------- | -------------------- | --------------------------- |
| Physical installation  | **System** (a device)                               | Device               | hub / bridge                |
| Atomic signal          | **Point** (`device_class` / `state_class` / `unit`) | **Entity**           | Health data type            |
| Semantic role-set      | **Area** (`kind: identity \| composite`)            | Area + Energy config | Home / Room                 |
| Presentation container | **Dashboard**                                       | Dashboard            | Health _Summary_ / Home tab |
| Tab (future)           | View                                                | View                 | —                           |
| Widget                 | **Card**                                            | Card                 | Favorite card               |
| Role→point edge        | **Binding**                                         | entity → energy role | —                           |

Naming notes: HA already uses **"View"** for a _tab inside a dashboard_, so the semantic layer is an
**Area**, not a "view." We keep **Point** internally (deeply established: `point_info`,
`point_readings`, `PointReference`, `docs/architecture/points.md`) and map Point → HA _entity_ at the
export bridge rather than renaming.

### Physical (unchanged)

`systems` + `point_info`. `(system_id, point_id)` stays the atomic binding target everywhere (reuse
`PointReference`, `lib/identifiers/types.ts`). Going forward `point_info` should carry HA-aligned
metadata (`device_class`, `state_class`) so the export bridge is config, not rework — proposed, gated.

### Semantic = Area

An **Area** is a named role-set binding physical points into a coherent energy site. Two kinds:

- `identity` — a 1:1 wrapper over a single physical system (its bindings are its own typed points).
  This makes "a single system" and "a composite" the _same_ shape (which `resolveLogicalSystem`
  already does today), removing the composite/non-composite fork.
- `composite` — bindings drawn from points across ≥2 systems.

An Area's **bindings** are typed rows (`role`, `metric_type`, `point_ref`, `ordinal`) — the single
representation that subsumes all three legacy JSON formats. Binding resolution is two-tier (generalizing
today's `base_system`/`overrides` to point granularity): **auto-bind** (a role resolves to the point
whose `logical_path_stem` matches — zero stored config, the default case) with optional **explicit
binding** (a user-pinned `(system_id, point_id)`, for ambiguity or cross-system composites).

### Presentation = Dashboard of Cards

A **Dashboard** is an ordered set of **Cards** with a layout and an owner, referencing an Area for its
default data context. Each **Card** is a typed widget instance bound to roles/points. The
`vendor_type` ladder collapses to: load the dashboard's cards in order and render each — there is no
`amber`/`mondo`/`composite`/`else` branching.

#### Card contract + auto-generated default

Each `card_type` ships a code-side **contract** — `{ requiredRoles, optionalRoles, requiredMetricTypes }`
— plus a `canRender(ctx)` predicate. This is the typed replacement for the
`hasTeslaData = latest['ev.battery/soc'] !== null` heuristics: a card is eligible iff its required roles
resolve against the Area. Today's Solar/Load/Battery/Grid cards become **instances of one `power-card`
type** with different bindings, not four hardcoded branches.

A `buildDefaultDashboard(area, latest)` generator inspects available roles/points and emits the default
dashboard — reproducing today's ladder + "render iff point exists" + the `synthesizeMasterLoad` /
`synthesizeRestOfHouse` / `isCompleteRoleSet` logic, but run **once** as a generator instead of
re-derived inline in every component and render.

---

## Product principle (Apple Home / Apple Health)

Most users want a good dashboard with **zero** configuration; only power users want to tinker. So:

1. The **auto-generated default** is the primary surface and is good enough that 95% never edit it.
2. **Customization is opt-in and curated, not a blank canvas:** **favorites** (pin / reorder / hide
   cards — Apple Health's _Summary_) plus an **"Add Card" gallery** (Apple Home's "Add Accessory" / the
   HA card picker). The gallery greys out card types whose required roles the Area can't satisfy.
3. **"Reset to default"** throws away the fork; an empty/broken dashboard falls back to the generator
   rather than showing nothing.

This is the Home Assistant ("auto default vs. take control") and Apple model, deliberately _not_ a
freeform Grafana grid in v1.

---

## Sharing & access (per-Dashboard)

A **Dashboard is the unit of both membership and public links.** Access resolves
**Dashboard → its cards' bindings → points**, so a shared dashboard exposes exactly what it shows and
nothing more (true point-level scoping, derived — a viewer never needs access to the underlying
physical systems). Two mechanisms:

- `dashboard_grants` — invite a person to a dashboard with a role (owner/admin/viewer), à la Apple
  Home "Invite People."
- `dashboard_share_tokens` — a read-only public link scoped to one dashboard (finally implementing the
  not-yet-built `GET /api/share-tokens/[token]` consumption).

Areas stay purely organizational; they are not the access boundary.

---

## Home Assistant interoperability (near-term milestone)

HA models every signal as an **entity** carrying `device_class` (`power`/`energy`/`battery`/…),
`state_class`, and `unit_of_measurement`; its **Energy dashboard** is configured by assigning entities
to roles (grid in/out, solar, battery) — essentially our Area bindings. The bridge maps cleanly:

| LiveOne       | →   | Home Assistant                                   |
| ------------- | --- | ------------------------------------------------ |
| System        | →   | Device                                           |
| Point         | →   | Entity (`device_class` / `state_class` / `unit`) |
| Area          | →   | Area                                             |
| Area bindings | →   | Energy dashboard configuration                   |

First bridge: **export** over **MQTT Discovery** (the standard auto-discovery path) and/or HA
REST+WebSocket. This is why the **role registry encodes HA's `device_class`/`state_class` taxonomy from
P0** — so export is a publish step, not a remodel. **Two-way ingest** (consuming HA entities as a data
source/vendor) is a possible future, out of scope for the first bridge.

---

## Proposed schema (illustrative — NOT approved)

```text
roles                  -- HA-device_class-aware role registry (removes the 4-file duplication)
  role            PK   -- 'source.solar' | 'bidi.battery' | 'load' | 'bidi.grid' | 'ev.battery' | 'load.hvac' ...
  category             -- 'source' | 'load' | 'bidi' | 'store'   (Sankey side + default color)
  ha_device_class      -- 'power' | 'energy' | 'battery' ...     (HA export)
  ha_state_class       -- 'measurement' | 'total_increasing' ...
  default_unit, default_label, default_icon, is_aggregable

areas
  id              PK
  owner_clerk_user_id
  kind                 -- 'identity' | 'composite'
  source_system_id     -- set for kind='identity' → systems(id)
  display_name, alias
  timezone_offset_min, display_timezone, status
  UNIQUE (owner_clerk_user_id, alias)

area_bindings          -- replaces ALL composite JSON formats
  id              PK
  area_id              -- → areas(id) ON DELETE CASCADE
  role                 -- → roles(role)
  metric_type          -- 'power' | 'soc' | 'energy' | 'rate' ...  (one role can bind power AND soc)
  point_system_id      -- the CHILD physical system
  point_id             -- (point_system_id, point_id) → point_info
  ordinal              -- ordering + many points per role (the v2 array)
  transform            -- per-binding override (e.g. invert), nullable
  UNIQUE (area_id, role, metric_type, point_system_id, point_id)
  INDEX  (point_system_id, point_id)   -- reverse lookup = the KV subscription registry, in SQL

dashboards
  id              PK
  owner_clerk_user_id
  area_id              -- default data context (a card may override) → areas(id)
  display_name, alias, layout(jsonb)
  UNIQUE (owner_clerk_user_id, alias)

dashboard_cards
  id              PK
  dashboard_id         -- → dashboards(id) ON DELETE CASCADE
  card_type            -- 'power-card' | 'site-power-chart' | 'energy-sankey' | 'amber-price' | 'tesla-control' | 'energy-chart'
  position
  config(jsonb)        -- role bindings + per-card options (period, title, …)

dashboard_grants       (clerk_user_id, dashboard_id, role)   -- members, per-dashboard
dashboard_share_tokens (token PK, dashboard_id, …)           -- public links, per-dashboard
```

How the 4-role hardcoding dissolves: `isCompleteRoleSet` joins `area_bindings.role → roles.category` and
checks "≥1 source/bidi and ≥1 load/bidi"; `aggregateSummaryReadings` becomes a generic reduce over
bindings keyed by `role` with `is_aggregable` deciding sum-vs-single; the composite adapter iterates
bindings grouped by `(role, metric_type)`; `CompositeTab`/`SystemPowerCards` read labels/icons from
`roles`. New roles need only a `roles` row.

---

## Migration / delivery roadmap (flag-gated, history-preserving)

Each phase is independently valuable. **P0–P1 are pure frontend/refactor — most of the "modules from
the physical layer" value with no schema change.**

- **P0 — HA-aware role registry.** `lib/roles/registry.ts` as the single source of truth; encodes HA
  `device_class`/`state_class`/unit + source/load/bidi + `isCompleteRoleSet`. Replace the four
  duplications with imports. No flag, no schema; covered by existing tests. _Scope discipline:
  role-vocabulary extraction only — do not move `synthesizeMasterLoad`/the card catalog in this PR._

- **P1 — Card registry + descriptor-driven dashboard** (flag `DECLARATIVE_DASHBOARD`, frontend only).
  Introduce the card registry + `buildDefaultDashboard`; `DashboardClient` becomes a generic renderer;
  `SystemPowerCards`' point-presence checks become per-card `canRender`. Descriptor is **computed, not
  stored** — no migration. Flag off = current path verbatim. Risk: reproduce the ladder's subtle
  conditionals (removed-system banner, "unconfigured composite" warning, sidebar-vs-full-width,
  `POINT_READINGS_NO_CHARTS`) — render both paths in dev and diff per vendor type before flipping.

- **P2 — Persist dashboards + favorites/Add-Card gallery** (`dashboards`/`dashboard_cards`; flag
  `DASHBOARD_PERSISTENCE`). Opt-in editing; default stays auto-generated; saving forks the descriptor
  into rows. Apple-Home-style: pin/reorder/hide + add from gallery.

- **P3 — First-class `areas` + `area_bindings` + `roles`; retire composite-as-system** (flag
  `AREAS_TABLE`). Normalize the metadata JSON into typed rows; point `resolveLogicalSystem`, the
  composite adapter, the summary store, and the KV registry builder at `area_bindings`.
  **Identity-Area seam (history):** every system gets a 1:1 identity Area; each composite `systems.id`
  maps 1:1 to an `areas.id`; add `area_id` to `point_readings_flow_1d` and backfill **forward-only —
  never rekey in place** (a migration-0016/0056-class hazard; see `docs/migrations.md`), with
  row-count validation in a `DO`/`RAISE EXCEPTION` block before dropping `system_id`. Keep a systems-row
  **shim** for composites through a measured soak so `point_readings_flow_1d`, the KV subscription
  registry (a rebuildable cache — migrate it **last**), and `share_tokens` keep working. The converter
  must handle all three legacy formats and **round-trip-assert on the real composite rows** (e.g.
  system 7, Kinkora) before migrating.

- **P4 — Per-Dashboard sharing.** `dashboard_grants` + `dashboard_share_tokens`; transitive
  point-level read; implement share-token GET consumption.

- **P5 — HA export bridge.** MQTT Discovery / HA API: System→Device, Point→Entity, Area→Area, Area
  bindings→Energy config.

**API stability:** freeze the `/api/data` response shape through the cutover (it returns
`system.metadata` raw); expose Areas/Dashboards via **new** endpoints rather than mutating the existing
payload.

### Riskiest couplings (de-risk first)

- `point_readings_flow_1d.system_id` + `app/api/energy-flow-matrix` key on the composite id → identity
  Areas + 1:1 id map + forward-only rename (gates P3). See `docs/architecture/energy-flow-matrix.md`.
- `components/SitePowerChart` / `lib/site-data-processor.ts` / `lib/queries/siteData.ts` assume
  `composite == system` (`isSiteVendor = vendorType==='mondo'||'composite'`). See also
  `docs/deferred/history-api-unification-plan.md`.
- KV keyspaces are system-id-keyed (`latest:system:{id}`, `subscriptions:system:{id}`,
  `system-summaries`; `lib/kv-cache-manager.ts`, `lib/system-summary-store.ts`) and the subscription
  registry is on the hot ingest path — refactor it last and watch summary freshness post-deploy. See
  `docs/architecture/kv-store.md`.
- `user_systems`, `share_tokens`, `users.default_system_id`, the `alias` unique index reference
  system ids.

---

## Open / deferred questions

- **Multi-tab Dashboards** (HA "Views") — defer past v1.
- **Dashboard templates** that bind by role and reuse across Areas (Grafana/Figma-component style) —
  later phase.
- **HA two-way ingest** (HA entities as a data source) — future; first bridge is export-only.
- **Rename `point` → `entity` internally?** Recommend keeping `point` and mapping at the bridge.

## Related docs

- `docs/architecture/points.md` — point model, paths, current composite rules (superseded here).
- `docs/architecture/energy-flow-matrix.md` — the logical-system / flow-matrix seam (P3 dependency).
- `docs/architecture/kv-store.md` — KV keys + subscription registry (P3 dependency).
- `docs/deferred/history-api-unification-plan.md` — unify composite/non-composite history paths.
- `docs/architecture/data-model.md` — invariants; schema source of truth is the Drizzle schema.
