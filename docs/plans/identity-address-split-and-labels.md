# Plan: two HA-borrowings — split identity from address + a Label tag dimension

> **Status:** proposed — not started (drafted 2026-06-15). Two _independent_ arguments,
> drawn from the [Home Assistant comparison](../architecture/home-assistant-comparison.md);
> either can be done alone. **No schema change has been made — get explicit approval before
> generating/applying any migration** (`CLAUDE.md` → Database Migrations). This doc is an
> argument for _why_, not an approved design.

## Why these two, and why now

The HA comparison flagged two places where Home Assistant's object model is cleaner and more
general than ours, and where the gap is _low-domain-risk_ to close (both are additive, neither
fights our durable-pipeline architecture):

1. **HA splits identity from address** (`unique_id` ≠ `entity_id`); we fuse them into one
   composite integer `(system_id, point_id)`.
2. **HA has a Label registry** — an orthogonal many-to-many tag on _any_ object; we have only
   the single Area tier and leak ad-hoc grouping into `metadata`/`alias`/naming.

Neither is urgent. The point of writing them down now is that **both become materially easier
the earlier they land** (before more code hard-codes `(system_id, point_id)` references, and
before more ad-hoc grouping accretes in `metadata`), and both directly de-risk roadmap items
already on the books (the areas **P5 HA export bridge**, and the **multi-tenant** growth that
P4 sharing assumes).

---

# Part 1 — Split identity from address

## Today

`point_info`'s primary key is `(system_id, index)` where `index` is the column `point_info.id`
— a _per-system sequential integer_. That pair, `(system_id, point_id)`, is the universal
handle: the hot time-series tables (`point_readings`, `point_readings_agg_5m`,
`point_readings_agg_1d`) FK to it, and so do the config tables (`area_bindings.(point_system_id,
point_id)`, `device_trackers` signal/energy points, `device_run_periods`, and dashboard card
bindings inside the descriptor). The only _stable, meaningful_ token a point owns is
`physical_path_tail` (e.g. `selectronic/solar_w`), unique per system via
`pi_system_physical_path_unique` — but it is **not** the addressing key.

So **the address _is_ the identity.** There is no "stable identity" distinct from "where it
lives," and no rename-safe handle. The comparison calls this our biggest object-model
weakness.

## What HA does

Three separate things:

- **`unique_id`** — durable identity, vendor-derived, never user-edited. It is what makes a
  registry entry _exist_ and persist across restarts/renames.
- **`entity_id`** (`domain.object_id`) — the renameable _address_ used in dashboards,
  automations, the API. Rename it and references that point at the registry entry still
  resolve.
- **device `identifiers` / `connections`** — device identity, with cross-integration dedup.

## Proposal (additive, non-destructive)

1. **Add a stable `point_uid`** (UUID) to `point_info` as _identity_ — minted at point
   creation, **deterministic from vendor identity where possible** (e.g. a UUIDv5 over
   `(vendor_type, vendor_site_id, physical_path_tail)`) so re-onboarding the same physical
   point reproduces the same uid.
2. **Keep `(system_id, point_id)` as the efficient physical _address_** on the append-only
   hot tables. Do **not** widen those keys — a narrow composite integer key is the right
   choice at ~13M `point_readings` rows; history is naturally tied to the physical address at
   write time.
3. **Migrate the _config layer_ to cite `point_uid`** instead of `(point_system_id,
point_id)`: `area_bindings`, `device_trackers`, and dashboard card bindings. These are
   small, read-mostly tables where a UUID reference costs nothing and buys rename/re-home
   safety.
4. _(Optional, later)_ add a renameable user-facing **`slug`** (the `entity_id` analog),
   distinct from both `point_uid` (identity) and `display_name` (label), for stable
   deep/share links and point-level API addressing.

## What it enables / simplifies

- **The HA export bridge (areas P5) becomes trivial.** `point_uid` _is_ HA's `unique_id` —
  export over MQTT Discovery / the HA API turns into a publish step, not an identity-synthesis
  step. Today we'd have to fabricate a `unique_id` from `physical_path_tail` per export.
- **Re-onboarding / vendor swap / re-homing a point stops orphaning config.** When a system
  is re-added under a new vendor, a composite collapses, or points are renumbered, bindings
  and trackers that cite `point_uid` survive — the physical address can change underneath
  them. Today any change to `(system_id, point_id)` breaks every reference, which is exactly
  the mass-rewrite hazard the migration incidents (0016 / 0035 / 0056) warn against.
- **Stable external addressing.** Share links, deep links, and a future `/api/points/<slug>`
  get a handle that doesn't move when internals change.
- **Removes the address≡identity coupling** the comparison flagged — bringing us in line with
  HA's proven identity hygiene without touching the time-series substrate.

## Honest scope & cost

- The win is concentrated in the **config / bridge / external** layers. The hot time-series
  tables stay int-addressed, so this is _not_ "replace the key with a UUID" — it's "add an
  identity column and rewire the small reference tables to it."
- Cost: one additive column + a deterministic backfill, then a reference migration on
  `area_bindings` / `device_trackers` / dashboard descriptors. All forward-only, row-count
  validated per `docs/migrations.md`. No hot-table rewrite.
- Risk: low. The biggest care item is the descriptor migration (card bindings live in
  `dashboards.descriptor` jsonb) and keeping the deterministic uid derivation truly stable.

## Start here (minimal first step)

Add `point_uid uuid` to `point_info` (nullable), backfill deterministically, add a unique
index — and expose it read-only in the API/bridge. That alone unblocks P5 export. Rewiring
config references to it is a separate, later migration.

---

# Part 2 — A Label-style orthogonal tag dimension

## Today

Grouping is **single-tiered**: `areas` (semantic role-set / site), the `roles` taxonomy, and
the nullable `point_info.subsystem` string. Anything that doesn't fit those gets hacked into
`systems.metadata` / `areas.metadata` jsonb, the `alias` field, or naming conventions. There
is **no many-to-many tag** attachable to arbitrary objects.

## What HA does

A **Label registry**: a free-form, owner-defined tag (name, color, icon) attachable to _any_
registry object — area, device, entity, automation, scene, script, dashboard. Labels are the
cross-cutting selection/filtering/targeting dimension that deliberately does **not** fit the
Floor→Area→device hierarchy. (HA also has **Floor**, a hierarchical tier above Area — out of
scope here; Labels are the higher-value borrowing for us.)

## Proposal (additive)

A `labels` registry (`id`, `owner_clerk_user_id`, `name`, `color`, `icon`) plus
label↔object membership. Two shapes, with an explicit trade-off to decide at design time:

- **One polymorphic junction** (`label_id`, `target_type`, `target_id`) — most HA-like (one
  label spans all object types), but no DB-level FK to the targets.
- **Typed per-target junctions** (`system_labels`, `area_labels`, `dashboard_labels`) — keeps
  FK integrity (our house style — cf. `area_bindings`), at the cost of a table per target
  type.

Start with the targets that have immediate use cases — **system, area, dashboard** — and add
**point** later.

## What it enables / simplifies

- **Cross-cutting grouping that doesn't fit Area or role** — `region:nsw`,
  `hardware-gen:selectronic-v2`, `support-tier:vip`, `beta-cohort`, `share-public`,
  `needs-review`. None of these is a _site_ (Area) or a _signal kind_ (role).
- **Multi-tenant ops slicing without schema churn.** As the tenant/site count grows, ops and
  admin want to slice across systems/areas/dashboards by arbitrary dimensions. Labels give
  **schema-stable extensibility** — the relational analog of HA's open-ended state-attributes
  dict (a generality win the comparison called out) — instead of adding a column or another
  `metadata` key each time.
- **Feature / rollout cohorts as data, not code.** Roll a feature out to labeled systems;
  the cohort lives in the DB, not in a hard-coded list or env flag.
- **Bulk ops & queries.** "Re-aggregate all `migrated-2026` systems", "list every dashboard
  tagged `share-public`", "alert on all `critical` areas" — indexed many-to-many instead of
  jsonb scans.
- **Future label-driven dashboards.** A dashboard (or card) whose membership is "all points
  labeled `solar-string`" — HA-style label targets — once `point` is a label target.
- **Stops grouping drift.** First-class labels with indexes + (optional) FK integrity stop
  ad-hoc grouping leaking into `metadata` / `alias` / naming conventions, where it's
  unqueryable and untyped today.

## Honest scope & cost

- **ROI scales with object count.** With a handful of systems the payoff is low; it grows
  with the multi-tenant footprint. So **tie the first cut to a concrete use case** — the most
  likely is ops tagging of systems for the multi-tenant rollout, or share-cohorts that pair
  with P4 sharing — rather than building it speculatively.
- Cost: 1 registry table + 1–3 junction tables, all additive; no migration of existing data
  (labels start empty). Low risk.
- Decision to make up front: polymorphic (HA-like, no FK) vs typed junctions (FK integrity).
  Given our house preference for FK-enforced bindings, typed junctions for the first 2–3
  target types is the likely call.

## Start here (minimal first step)

`labels` + `system_labels` only, with an admin UI to tag systems. That covers the ops/cohort
use case immediately; add `area_labels` / `dashboard_labels` / `point_labels` as use cases
appear.

---

## Relationship between the two

They're independent and can ship in either order. They _rhyme_: both close a generality gap
the [HA comparison](../architecture/home-assistant-comparison.md) identified, both are
additive, and both reduce overloading of existing fields (`(system_id, point_id)` as
identity; `metadata`/`alias` as grouping). Part 1 most directly unblocks the **P5 HA export
bridge**; Part 2 most directly supports **multi-tenant growth** and pairs with **P4 sharing**.

## Related docs

- [`../architecture/home-assistant-comparison.md`](../architecture/home-assistant-comparison.md)
  — the analysis these proposals come from.
- [`../architecture/areas-and-dashboards.md`](../architecture/areas-and-dashboards.md) — the
  Systems → Areas → Dashboards split, the role registry, and the P5 HA export milestone.
- [`../architecture/points.md`](../architecture/points.md) — the point model, paths, identity.
- [`../migrations.md`](../migrations.md) — forward-only, row-count-validated migration
  practice that any implementation here must follow.
