# Areas & Dashboards

> Status: foundation live · Phase 1 (sharing hardening) done · Phases 2–3 planned.
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

**Areas are organizational, not the access boundary.** Access is **system-granular today**; point-level
granularity arrives with the dashboard card split (Phase 2).

## 2. Dashboards & sharing

A `dashboard` is per-user, per-system today (`(clerk_user_id, system_id)` unique). Its content is an
**opaque `descriptor` JSONB** parsed client-side. `dashboards.area_id` (nullable) is a forward seam: the
dashboard's **default/home area** (see §3).

**The dashboard is the unit of sharing** (shipped, no flag): `dashboard_share_tokens` (read-only public
links, expiry/revoke) and `dashboard_grants` (membership: `owner|admin|viewer`).

**Scope — today vs target.** `resolveDashboardReadPoints` (`lib/dashboard/access.ts`) resolves a share's
read scope. _Today_ it resolves **Dashboard → its Area → `area_bindings` → points**, which for an identity
dashboard equals the whole system (matching "system-granular today"). The _target_ — once cards carry
their own scope (§3) — is **Dashboard → its cards' bindings → points**, so a share exposes exactly what
the dashboard shows, never a whole system.

**Invariant — scope is recomputed live, never snapshotted.** A token's scope is whatever the dashboard
binds _now_; consuming routes re-resolve on every read.

**Edge bypass (hardened, Phase 1).** A `?access=` share link can't be validated inside Clerk middleware
(the edge runtime has no Postgres), so the token is validated downstream by `requireDashboardAccess`. The
edge is fail-closed instead: middleware honours `?access=` **only** for GET/HEAD requests to
share-eligible routes (`isShareableRoute` in `lib/route-matchers.ts` — the dashboard page + the read-only
data APIs its cards fetch). A stray token on any other route (admin, test, mutations) still hits
`auth.protect()`. Per-card point _narrowing_ (returning less than the whole system to a token holder) is a
no-op today — a dashboard's scope already equals its whole system — and is enforced in the data routes
when cards land (Phase 2).

## 3. The multi-area future

The end-state is a dashboard that **composes cards from multiple areas** on one screen (e.g. house, farm,
EV, grid region), making dashboard↔area conceptually **many-to-many**.

**The junction is the card — not a `dashboard_areas` table:**

```
dashboard 1 --< dashboard_cards >-- 1 area   (dashboard_cards.area_id; null = the dashboard's default area)
```

A dashboard's areas are the distinct `area_id`s across its cards (∪ its default area). A direct junction
is wrong because (1) it's redundant — you still need per-card area for position/layout; (2) area is too
coarse — a card often binds a single role or point subset; (3) layout/order/visibility are already
per-card. So `dashboard_cards.area_id` is a per-card override; `dashboards.area_id` stays the default/home
area.

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
  `users.default_dashboard_id → dashboards.id`, landing _with_ first-class dashboards (a standalone swap
  has no effect until a dashboard can differ from a system).

## 4. Roadmap

Legend: ✅ shipped · ◑ in progress · ⬜ planned. Migration high-water mark: **0015**. All schema work
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

### Phase 2 — First-class & multi-area dashboards (keystone) — ⬜

The pivot that unlocks §3, and the bulk of the remaining value. Add `dashboard_cards` (normalizing the
descriptor into rows) with per-card `area_id`; add `alias`/`display_name` to `dashboards` (the `id` PK
already exists); relax the `(clerk_user_id, system_id)` uniqueness so a user can hold multiple dashboards.
Address dashboards by id/alias; widen `resolveDashboardReadPoints` to the union across card areas and
**enforce that scope in `/api/data` + `/api/history`** for token holders (the no-escalation and
broadest-card invariants, server-side). Land `users.default_dashboard_id` here. Largest phase —
descriptor→cards is a dual-read data migration. Depends only on the foundation.

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

The foundation gates everything. Phases 2 and 3 are independent of each other and can proceed in parallel.
