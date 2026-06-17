# Plan: Replace "composite areas" with first-class areas that contain multiple devices

> **Status: Phases A–C + tail DONE and merged (#105 + #106). Phase D pending.** This is the original
> planning doc, kept for detail; the live summary + invariants now live in
> [`../architecture/areas-and-dashboards.md` §5](../architecture/areas-and-dashboards.md). Shipped: Phase A
> (unified resolver), Phase B (`area_devices` + migration `0018`, applied to dev + `sydney` prod), Phase C
> (membership + override / union-default, lazy areas, `kind` reads collapsed), and the tail (admin
> one-Areas list, KV fan-out generalization). **Only Phase D remains** — drop the `areas.kind` column (via
> expand-contract) + the create-UX reframe; needs schema approval + a soak. See §5 of the canonical doc for
> the precise Phase-D steps.

## Context

Today the semantic layer carries an `areas.kind` distinction with two parallel mechanisms:

- **identity area** — auto-created 1:1 with every `system` at create-time (`ensureIdentityArea`), owns its
  roles _implicitly_ via the device's own `point_info.logical_path_stem`, has **no** `area_bindings`.
- **composite area** — a multi-system grouping with **no `systems` row** (deleted in migration 0014),
  synthesized into a _virtual_ `system` on demand (`SystemsManager.synthesizeCompositeSystem`) keyed on an
  integer handle (`areas.legacy_system_id`, allocated from 100000+), with roles resolved _explicitly_ via
  `area_bindings`. Its "member devices" are **implicit** — the distinct `point_system_id` values across its
  bindings.

The insight: **a "composite area" and "an area with multiple devices" are the same thing** semantically —
`area_bindings.point_system_id` is already per-edge, so an area can already span systems. The "composite"
machinery adds no semantic value; it's a _representation_ (a multi-device area masquerading as a single fake
system) plus a redundant `kind` split. The goals:

1. **Eliminate the composite concept** → an area is uniformly "a grouping of 1..N member devices."
2. **Make areas optional** → stop force-creating an identity area for every system.

### Decisions locked

- **Role model = membership + override.** Add an explicit `area → devices` junction. An area's roles
  **default** from each member device's own `point_info` stems; `area_bindings` becomes an **override** layer
  (select/pick/aggregate only when the union is ambiguous, or to relabel/transform). Most HA-aligned; no
  duplication of point metadata into bindings.
- **Areas optional = lazy / on-demand.** Stop creating an area at system-create. Keep the self-heal in
  `resolveLogicalSystem` as the on-demand path (a system that becomes a complete flow view, or gets a
  dashboard, gets an area minted then). Existing areas untouched; the flow matrix stays area-keyed.
- **Sequencing = after 2b-2.** Finish/merge the in-flight composition-dashboard work (Phase 2b-2) first;
  this lands as a separate follow-on. **Keep the integer serving handle** (`legacy_system_id`) — do **not**
  re-key the live serving path to UUID (that's the unrelated multi-week rearchitecture).

### Non-negotiable invariants

- **`point_readings_flow_1d` is byte-identical and area-keyed — never recompute, never re-key, never let its
  `area_id` FK cascade.** Its `NO ACTION` FK is the data-loss firewall (it _refuses_ to delete an area that
  still has flow rows). Leave this table entirely alone.
- **Keep `legacy_system_id`** and its unique index throughout — the serving path
  (`/api/data`, `/api/history`, `/api/energy-flow-matrix`, KV `latest:system:N` + the fan-out registry,
  `device_run_periods`/`device_trackers`) and the 2b-2 renderer all key on the integer handle.
- **Migrate-before-deploy.** PG migrations are manual; shipping schema-dependent code ahead of its migration
  caused the 2026-06-16 outage. Every migration is additive first; column drops come last, behind
  `DO`/`RAISE EXCEPTION` guards; never `drizzle-kit push`; no rollback migrations (undo = new forward
  migration).

## Target model

| Concept    | What it is                                                                                           | Key                                                | Serving                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Device** | a `systems` row that owns `point_info` points (today's non-composite system)                         | integer `systems.id`                               | `/api/data?systemId=N` over its own points (unchanged)                                                                       |
| **Area**   | an _optional_ grouping of 1..N member devices; roles default from members' points, bindings override | uuid + integer serving handle (`legacy_system_id`) | same integer-keyed path; multi-device areas served via the synthesized virtual system + KV fan-out (as composites are today) |

- **No `areas.kind`.** A single-device area == today's identity area (zero overrides → all roles default). A
  multi-device area == today's composite (overrides where the union needs curation).
- **`vendorType === 'composite'` (the _runtime_ property of the synthesized virtual system) is KEPT** — it
  still means "areas-backed virtual system, not a polling device," which is a real, surviving distinction
  (no polling, no vendor actions). Only the **stored `areas.kind` column** and its readers are removed. This
  keeps the blast radius far smaller than "remove every composite branch."

### Role resolution (the one unified path)

For an integer handle H:

```
area = getAreaForHandle(H)                       // by legacy_system_id
if area:
    memberSystemIds = area_devices(area)         // explicit membership
    points  = ⋃ point_info(memberSystemIds)      // union of members' points
    roleOf(p): if area has a binding for that role → bound points (override)
               else → default from p.logical_path_stem
else:                                            // bare device, no area
    points = point_info(H)                       // its own points (unchanged)
```

This collapses `PointManager._loadPointsWithCompositeSupport` (the `vendorType === 'composite'` branch) and
`_resolveCompositeSystemPoints` into one "resolve viewable" method. It is correct for all three cases — bare
device, 1-device area (union of {device} == the device's points), and multi-device area — so identity and
composite stop being special.

### The critical correctness gate

Reinterpreting an existing **composite** under "union-default + override" risks _broadening_ it: a member
device may have a typed point that was never bound, which union-default would now include. **Gate every
schema/semantics step with a per-area parity assertion:** `getActivePointsForSystem(handle)` must return a
**byte-identical resolved point set** before vs after, for every existing area. Where it differs, pin it with
an explicit binding (or exclusion) so behavior is preserved. Identity areas resolve to pure default with zero
bindings — inherently identical.

## Phased plan

> Migration numbers below are placeholders — `git fetch origin main` and take the next free number after the
> current high-water (0017) to avoid the parallel-workspace collision documented in CLAUDE.md.

### Phase A — Unify the resolver in code (no schema, no behavior change)

Refactor to a single "resolve viewable" path that **dispatches identically to today** (identity → own
points; composite → bound points only — no union-default yet). Proves the unified code path before any data
moves.

- `lib/point/point-manager.ts` — merge `_loadPointsWithCompositeSupport` / `_resolveCompositeSystemPoints`
  into one `_resolvePointsForViewable(handle)`; dispatch on "does a real `systems` row exist for H" rather
  than `vendorType === 'composite'`.
- `lib/aggregation/logical-system.ts` — `resolveLogicalSystem` consumes the unified path; no functional
  change yet.
- Guardrails: existing `lib/__tests__/synthesize-composite-system.test.ts`,
  `lib/aggregation/__tests__/logical-system.test.ts`, and the multi-area tests.

**Risk:** low (pure refactor). **Schema:** none.

### Phase B — Add `area_devices` membership (additive migration + backfill)

Migration (additive only — no drops, no `NOT NULL` on existing columns):

```sql
CREATE TABLE IF NOT EXISTS area_devices (
  area_id   uuid    NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  system_id integer NOT NULL,        -- plain int, like legacy_system_id: members may be child
                                     -- systems whose rows could be absent; do NOT FK to systems
  ordinal   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (area_id, system_id)
);
```

Backfill (idempotent, `ON CONFLICT DO NOTHING`, inside one transaction):

- **Composite areas** → one row per _distinct_ `area_bindings.point_system_id`.
- **Identity areas** → one row, `system_id = source_system_id`.

Guards (`DO`/`RAISE EXCEPTION`, using `EXISTS` — never `COUNT(*)` the big tables): every composite area has
≥1 member; every identity area's single member == its `source_system_id`.

Then switch the resolver to read membership from `area_devices` (still bindings-authoritative for
composites — union-default not yet relied on). `area_devices.area_id` cascade is safe: the table is
fully rederivable; it does **not** loosen `flow_1d`'s protection.

**Apply order:** PITR + base backup → apply to a throwaway branch + run guards → apply to `sydney` prod →
verify (`n_live_tup` for presence; per-kind `EXISTS` checks; `/api/health`) → **only then** deploy code that
reads `area_devices`, with a fallback to the bindings-derived set so a migration/deploy skew can't blank an
area.

**Risk:** low–medium (backfill correctness; the parity gate is the regression guard). **Rollback:**
non-destructive — `DROP TABLE area_devices` in a forward migration; redeploy prior build.

### Phase C — Membership + override semantics + lazy areas + collapse `kind` in code

- **Override semantics:** introduce union-default + per-role binding override in the resolver. Run the
  **per-area parity gate** across all prod areas; pin any broadened composite with an explicit binding.
- **Lazy areas:** remove the eager `ensureIdentityArea(newSystem)` call in `SystemsManager.createSystem`.
  **Keep** the self-heal in `resolveLogicalSystem`, but gate it so only systems that form a complete role
  set (or get a dashboard) mint an area — so bare monitoring-only systems (e.g. public grid-region systems)
  stop accruing pointless area rows. Verify the grid-region-derivation and share-scope paths (which the
  `sync.ts` header notes also depend on `getAreaForSystem`) tolerate an area-less monitoring system.
- **Collapse `kind` _reads_** (the column stays physically present through the soak):
  - `lib/areas/bindings.ts` — drop the `kind='composite'` filter in `getCompositeBindingRefs` /
    `getAllCompositeBindings` (identity areas have no bindings, so unaffected).
  - `lib/areas/resolve.ts` / `lib/areas/sync.ts` — collapse `getCompositeAreaId` into the generic
    handle lookup; stop writing `kind`; `createCompositeArea` → `createArea` (+ writes `area_devices`).
  - `lib/systems-manager.ts` `loadSystems` — select areas to synthesize by "handle with **no** `systems`
    row" (`legacy_system_id NOT IN (SELECT id FROM systems)`) instead of `kind='composite'`; keep
    `synthesizeCompositeSystem`.
  - `lib/grid/context.ts` `systemPlaysGridRole` — drop the `areaKind` branch; resolve grid role uniformly.
  - `lib/admin/get-areas-data.ts` + `app/admin/areas/AdminAreasClient.tsx` — derive identity-vs-composite
    from **member count**, render one "Areas" list instead of two sections.
- **KV fan-out:** generalize `buildSubscriptionRegistry` (`lib/kv-cache-manager.ts`) to build subscriptions
  from each area's **resolved point set** where `sourceSystem != areaHandle` (identity areas' own points
  need no fan-out — already in `latest:system:handle`; composites fan out as today). Behavior-preserving.

**Risk:** medium (the parity gate + lazy-heal edge cases are the sharp edges). **Schema:** none (column
drop deferred). **Rollback:** redeploy prior build; backfilled `area_devices` + the still-present `kind`
column keep old code working.

### Phase D — Drop the dead columns + the grouping UX (guarded, after soak)

- Migration: `ALTER TABLE areas DROP COLUMN kind;` behind a guard that no reader remains; **keep
  `source_system_id`** (cheap, documents a single-device area's primary device). Forward-undo = re-add +
  re-derive from `area_devices` cardinality.
- **Create/edit UX:** replace "create composite system with mappings" (`POST /api/systems` with
  `vendorType='composite'`) with "create area → add member devices (`area_devices`) → optional role
  overrides." Preserve the existing `{version:2, mappings}` editor as the **override** editor
  (`convertCompositeToBindings` stays).
- Optional cosmetic (defer unless desired): rename `legacy_system_id` → `serving_system_id` and the
  synthesized `vendorType: 'composite'` value → `'area'`. Both touch 2b-2-adjacent code; keep names +
  update comments for now.

**Risk:** medium. **Rollback:** forward migration re-adds `kind`.

## What we explicitly do NOT do

- **No re-keying the serving path or `flow_1d` to UUID** — out of scope, no driver, high risk.
- **No `connection`/`device` split of `systems`** — the clean HA end-state, but orthogonal and XL; defer.
- **No deletion of existing identity areas** — "lazy" only stops _new_ eager creation; existing areas stay
  (deleting them would require a `flow_1d` re-key — the firewall table).
- **No `ON DELETE CASCADE` on `point_readings_flow_1d.area_id`**, ever. Any future "delete area" path must
  pre-check `SELECT 1 FROM point_readings_flow_1d WHERE area_id=$1 LIMIT 1` and refuse if present.

## Verification (end-to-end)

1. **Parity gate (the key regression test):** for every prod area, `getActivePointsForSystem(handle)` returns
   the identical point set pre/post each of Phases B and C. Add a script/test that diffs the resolved set.
2. **Flow matrix unchanged:** `/api/energy-flow-matrix?systemId=N` returns identical JSON for a known
   single-device system and a known multi-device area, pre/post. `point_readings_flow_1d` row presence
   verified by `ORDER BY area_id LIMIT 1` (never `COUNT(*)`).
3. **KV fan-out:** `buildSubscriptionRegistry` produces the same `subscriptions:system:*` keys for
   multi-device areas; no spurious self-subscriptions for single-device areas.
4. **Bare device:** create a new system → confirm **no** area row is created; `/api/data?systemId=N` serves
   its own points; it appears in the daily recompute (and gets a lazily-healed area) only once it forms a
   complete role set.
5. **2b-2 intact:** a composition dashboard whose cards carry `areaId` still resolves
   `area.legacySystemId → systemId → dashboardDataQuery` unchanged.
6. **Admin:** `/admin/areas` renders one unified list with member counts; creating an area + adding devices
   - overrides round-trips.
7. `npm run build:local && npm run typecheck`; `npm test` (resolver + areas + kv-cache + logical-system
   suites) green.

## Critical files

- `lib/point/point-manager.ts` — unify the resolver (Phase A).
- `lib/aggregation/logical-system.ts` — viewable resolution + lazy self-heal gating (A, C).
- `lib/areas/sync.ts` — `ensureIdentityArea` (stop eager create), `createCompositeArea` → `createArea` +
  `area_devices` writes, drop `kind` writes (B, C, D).
- `lib/areas/bindings.ts`, `lib/areas/resolve.ts` — drop `kind` filters; generic handle lookup (C).
- `lib/systems-manager.ts` — synthesize by "handle with no systems row"; keep `synthesizeCompositeSystem` (C).
- `lib/kv-cache-manager.ts` — fan-out from resolved area points (C).
- `lib/grid/context.ts`, `lib/admin/get-areas-data.ts`, `app/admin/areas/AdminAreasClient.tsx` — collapse
  `kind` readers / UI (C).
- `lib/db/planetscale/schema.ts` — `area_devices` (B); drop `areas.kind` (D).
- New migrations under `drizzle-planetscale/` (B: create+backfill+guards; D: drop `kind`) and a backfill/parity
  script under `scripts/`.
- Reconcile with `app/api/systems/route.ts` + the composite admin routes (settings/status/metadata/location)
  — their `vendorType === 'composite'` branches are **kept**; only the create UX changes (D).

## Doc follow-up

Once built, fold this into `docs/architecture/areas-and-dashboards.md` (the consolidated areas doc): areas
become "groupings of 1..N devices, membership + override," `kind` retired, and the "Not planned — retiring
integer system addressing" note updated (the integer handle stays; only the _composite fiction_ is removed).
Related prior plan: [`identity-address-split-and-labels.md`](./identity-address-split-and-labels.md).
