# Areas — P3 destructive tail + P4 plan

> **Status:** scoped 2026-06-14 (against post-#66 code). P3's functional layer is live in prod + dev;
> this doc covers (1) the deferred **destructive tail** of P3 and (2) **P4** (per-dashboard sharing).
> Companion to `docs/architecture/areas-and-dashboards.md`. All DDL is gated by the "ask before
> modifying the schema" rule and the `docs/migrations.md` discipline (additive/forward-only, generated
> migrations only, `DO`/`RAISE EXCEPTION` row-count guard before any DROP, never `drizzle-kit push`).

## Dependency order

```
P3-tail-1 (drop flow_1d.system_id)  ──┐
                                       ├─► P3-tail-2 destructive bit (drop composite systems shim, re-key off systems.id)
P3-tail-2 non-destructive (code)  ────┘
P4 (sharing)  ── independent of the tail; can proceed in parallel
```

The tail's two destructive endpoints both hinge on the `areas.legacy_system_id == systems.id` 1:1 seam,
so **P3-tail-1 must land before P3-tail-2's destructive migration.** P4 is independent — it builds on the
already-live `dashboards.area_id` seam and need not wait.

---

## P3-tail-1 — Drop `point_readings_flow_1d.system_id` (re-key fully onto `area_id`)

**Goal:** rebuild the PK to `(area_id, day, source_path, load_path)` and drop `system_id` + the obsolete
`prf1d_system_day_idx`. `area_id` is backfilled and **proven byte-identical** to the `system_id` keying
(`scripts/verify-areas-parity.ts`, PASS on prod + dev), so this is a pure re-key, not a data change.

**Coupling (verified):** the only `system_id` references to flow_1d are the schema
(`lib/db/planetscale/schema.ts:408-442`, PK + `prf1d_system_day_idx`), the write path
(`lib/db/planetscale/flow-matrix-pg.ts` — DELETE-by-`systemId` at `:74-78` and `:179-183`, INSERT stamps
both at `:158-170`), and the read path (`app/api/energy-flow-matrix/route.ts:78-81`, which already prefers
`area_id` and falls back to `system_id`). No other readers, no tests. **Crux:** `getAreaForSystem` returns
`null` when `AREAS_TABLE` is off (`lib/areas/resolve.ts:30`), so re-keying requires `areaId` to be reliably
non-null — i.e. `AREAS_TABLE` must be permanently on (it is, in prod + preview).

**Phase A (ship first, non-destructive, soak ~24–48h / ≥1 daily-cron cycle):**

1. `lib/aggregation/logical-system.ts` — make `LogicalSystem.areaId` `string` (not `string | null`);
   `resolveLogicalSystem` treats a null area as a **loud error / skip** (never a silent un-keyed write).
2. `lib/db/planetscale/flow-matrix-pg.ts` — switch the two DELETE filters to `eq(areaId, …)`. **Keep
   stamping `system_id` on INSERT** (harmless cushion; dropped in Phase B with the migration).
3. `app/api/energy-flow-matrix/route.ts` — drop the `system_id` fallback; filter solely on `area_id`.
   Rollback = revert the PR (column still present + written, old keying works instantly).

**Phase B (after soak — destructive migration `00NN`, re-check number after `git fetch origin main`):** 4. `lib/db/planetscale/schema.ts` — drop `systemId`, make `areaId` `.notNull()`, PK →
`(areaId, day, sourcePath, loadPath)`, remove `systemDayIdx` (keep `prf1d_day_idx`, `prf1d_area_day_idx`). 5. `lib/db/planetscale/flow-matrix-pg.ts` — drop the `systemId:` line from the INSERT. 6. `scripts/verify-areas-parity.ts` — check B (`system_id` vs `area_id` symmetric-diff) can't run once
`system_id` is gone; convert it to an "every row has area_id" smoke check. 7. Hand-edit the generated SQL to add the guard before the destructive DDL (verify actual
constraint/index names with `\d point_readings_flow_1d` first):

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM point_readings_flow_1d WHERE area_id IS NULL) THEN
    RAISE EXCEPTION 'flow_1d has NULL area_id — aborting before re-key';
  END IF;
END $$;                                                            --> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" ALTER COLUMN "area_id" SET NOT NULL;        --> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" DROP CONSTRAINT "<old_pk_name>";            --> statement-breakpoint
ALTER TABLE "point_readings_flow_1d"
  ADD CONSTRAINT "point_readings_flow_1d_area_id_day_source_path_load_path_pk"
  PRIMARY KEY ("area_id","day","source_path","load_path");                       --> statement-breakpoint
DROP INDEX "prf1d_system_day_idx";                                               --> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" DROP COLUMN "system_id";
```

Apply **`liveone-dev` first, then `sydney`** (short-TTL `pscale role` → reassign to `postgres` → delete;
table-ownership trap). PK rebuild is collision-safe because Areas are strictly 1:1 with `legacy_system_id`.

**Risks:** dropping `system_id` removes the `AREAS_TABLE=off` flow fallback (acceptable iff flag stays on);
`getAreaForSystem`-returns-null is the footgun (handle deterministically in step 1); `sync-prod-to-dev.ts`
COPYs the dest column list (`:152`) → migrate dev + prod in the same window and pause
`sync-prod-to-dev.yml` across it to avoid column-count skew.

---

## P3-tail-2 — Retire the composite `metadata` shim + pseudo-vendor

**Goal:** make `area_bindings` the **sole** source of truth for a composite's role→point mapping; retire
the `CompositeAdapter` pseudo-vendor + bogus `vendor_site_id`.

**Coupling (verified) + corrections to the architecture doc:**

- `systems.metadata` composite reads: point resolution (`lib/point/point-manager.ts:256/289`), live-value
  combine (`lib/vendors/composite/adapter.ts:66/95`), KV registry (`lib/kv-cache-manager.ts:247/211`),
  the editor (`app/api/admin/systems/[systemId]/composite-config/route.ts` GET `:48` / PATCH dual-write
  `:254/263`; create `app/api/systems/route.ts:48-72`), admin listing (`lib/admin/get-systems-data.ts:81`),
  and `/api/data` (`app/api/data/route.ts:56`).
- **Correction:** composites have **no** `polling_status` row (it's inserted lazily, poll-only —
  `lib/polling-utils.ts:67,144`; composites never poll). Nothing to retire there.
- **Correction:** `CompositeAdapter.getLastReading` is **orphaned** — composite live values reach the UI
  via the KV subscription-registry fan-out (child-system polls), not the adapter. Confirm with a grep +
  prod-log check before deleting.
- **Correction:** `/api/data`'s `metadata` field is **not** read by the live render
  (`DashboardClient.tsx:85` declares but ignores it); its only consumer is the editor seed
  (`CompositeTab.tsx:124`), which has its own `composite-config` GET.

**Phase A (now, no schema change):** editor writes `area_bindings` directly (add
`syncCompositeBindingsFromMappings(systemId, mappings)` to `lib/areas/sync.ts` that doesn't re-read
metadata); composite-config GET + `/api/data` **derive** the `{version:2, mappings}` blob from bindings
(frozen contract preserved); `get-systems-data.ts` reads source systems from bindings. **Keep mirroring
`systems.metadata` as a rollback cushion** through the soak.

**Phase B (after `AREAS_TABLE` soak):** delete the flag-off metadata fallbacks in `point-manager.ts`,
`composite/adapter.ts`, `kv-cache-manager.ts`; stop mirroring metadata; **retire the `AREAS_TABLE` flag**
(it has no off-path left — follow the #62 flag-retirement pattern).

**Phase C:** remove `CompositeAdapter` from `lib/vendors/registry.ts:34` + delete the file (once orphan
confirmed); replace the minted `vendor_site_id` (`systems/route.ts:51`) with a deterministic sentinel
(`vendor_site_id` is NOT NULL — no schema change in MVP).

**Later (blocked on P3-tail-1 + a longer soak):** the destructive migration — re-key
`user_systems`/`share_tokens`/`dashboards`/`users.default_system_id` + the KV keyspace from `systems.id`
onto `areas.id`, then DELETE the composite `systems` rows + retire the `legacy_system_id` seam, with
`DO`/`RAISE` count gates (composite systems == composite areas; no `flow_1d` row still references a
composite `system_id`). **The `systems.metadata` column is NOT dropped** — it's shared by Tesla / OE /
generic metadata; only its composite usage is retired.

---

## P4 — Per-dashboard sharing (+ dashboards-as-first-class groundwork)

**Goal:** make a Dashboard a first-class, addressable, shareable entity. Builds on the live
`dashboards.area_id` seam.

**Coupling (verified):** today exactly one dashboard per `(clerk_user_id, system_id)`
(`schema.ts:524-547`, `dashboards_user_system_unique`); store + API + query are all `system_id`-keyed
(`lib/dashboard/store.ts`, `app/api/dashboard/[systemId]/route.ts`, `lib/queries/dashboard.ts`); the
descriptor is opaque JSONB parsed client-side (`DashboardClient.tsx:256-264`). Access is system-granular
(`lib/api-auth.ts:117-175` `requireSystemAccess`). `share_tokens` is **owner-scoped, not dashboard-scoped,
and has no GET consumption** (`lib/share-tokens.ts`); the `?access=` middleware bypass is **presence-only,
not validated at the edge** (`lib/route-matchers.ts:27-33`) — only one labs page validates downstream.

### Recommended MVP — sharing on top of the existing descriptor (defer the big refactor)

Deliver the doc's headline P4 value (a read-only public link scoped to one dashboard, exposing exactly what
it shows) **without** the `dashboard_cards` split or multiple-dashboards-per-area:

- **Migration:** `dashboard_grants(dashboard_id, clerk_user_id, role)` + a **new**
  `dashboard_share_tokens(token PK, dashboard_id, *_at_ms)` table (do **not** overload the legacy
  `share_tokens`). Additive, no DROP.
- **Transitive point set:** `lib/dashboard/access.ts` → `resolveDashboardReadPoints(dashboardId)` resolves
  the dashboard's `area_id` → `area_bindings` (`lib/areas/bindings.ts`) → `(system_id, point_id)` set.
- **Consumption:** `requireDashboardAccess(request, dashboardId)` in `lib/api-auth.ts` (owner/admin/grant
  OR valid share token); a `GET /api/dashboard-share/[token]` that validates → returns the descriptor +
  the transitive point set; `/api/data` + history constrained to **only** that set for token holders.
  Wire the `?access=` edge bypass to actually validate for dashboard routes. Flag `DASHBOARD_SHARING`.

### Stage-A groundwork (later — the larger refactor)

- Relax the unique **atomically** (single tx): drop `dashboards_user_system_unique`, add partial
  `dashboards_user_default_unique ON (clerk_user_id, system_id) WHERE is_default` (+ new
  `is_default bool NOT NULL DEFAULT true`) + `dashboards_owner_alias_unique ON (clerk_user_id, alias)`;
  add `display_name`, `alias`. Guard with a `DO`/`RAISE` that asserts ≤1 row per `(user, system)` today
  (`dashboards` is a small table — `GROUP BY` is fine).
- `dashboard_cards(id, dashboard_id, card_type, position, area_id, config jsonb)` — typed split of the
  JSONB descriptor; **keep `dashboards.descriptor` during the soak** (dual-read: rows else descriptor);
  converter `lib/dashboard/cards-store.ts` (`descriptorToCardRows`/`cardRowsToDescriptor`, round-trip
  asserted). Per-card `area_id` override (null = dashboard's area).
- Id-keyed API (`app/api/dashboards/[id]` + `app/api/dashboards`) with the legacy
  `/api/dashboard/[systemId]` resolving to the system's **default** dashboard; addressable routing
  (`/dashboard/{user}/{dashboard-alias}`, **resolve system aliases first** to avoid shadowing). Flag
  `DASHBOARDS_FIRST_CLASS`.

**Risks:** transitive-access leak is the security boundary — the token path must serve **only**
`resolveDashboardReadPoints`, never `requireSystemAccess`'s whole-system grant; `?access=` is presence-only
today (don't extend it to new routes until validated); dashboard-vs-system alias collision (resolve
system-first); descriptor drift during dual-read (write both until the column is dropped).

---

## Suggested execution order

1. **P3-tail-1 Phase A** (read/delete by area, soak) — small, de-risks the rest.
2. **P3-tail-2 Phase A** (bindings authoritative, metadata mirrored) — parallel-safe with #1.
3. **P3-tail-1 Phase B** (drop `flow_1d.system_id`) once #1 has soaked.
4. **P4 MVP** (sharing) — independent; schedule whenever the product wants it.
5. **P3-tail-2 Phase B/C** (drop fallbacks, retire `AREAS_TABLE` + pseudo-vendor) after the AREAS_TABLE soak.
6. **Destructive re-key off `systems.id`** (P3-tail-2 "later") — last, after #3 + a measured soak.
