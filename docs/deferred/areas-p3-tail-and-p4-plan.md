# Areas — P3 destructive tail + P4 plan

> **Status:** scoped 2026-06-14 (against post-#66 code). P3's functional layer is live in prod + dev;
> this doc covers (1) the deferred **destructive tail** of P3 and (2) **P4** (per-dashboard sharing).
> Companion to `docs/architecture/areas-and-dashboards.md`. All DDL is gated by the "ask before
> modifying the schema" rule and the `docs/migrations.md` discipline (additive/forward-only, generated
> migrations only, `DO`/`RAISE EXCEPTION` row-count guard before any DROP, never `drizzle-kit push`).

---

> **✅ UPDATE 2026-06-15 (post #89–#92 — the composite retirement SHIPPED; supersedes the table + reframing below):**
> The composite-as-system retirement is **done**. PRs #89–#92 made `area_bindings` authoritative (#89),
> dropped the composite-related FKs and **DELETEd the composite `systems` rows** (migration `0014`, #90),
> **retired the `AREAS_TABLE` flag** + dead metadata fallbacks (#91), and moved composite CREATE/admin
> routes to areas-only while stripping `CompositeAdapter` (#92). The "LARGE, unstarted integer→area
> addressing prerequisite" the reframing below treats as the gate was **solved differently**: composites
> are now **areas-backed virtual systems** synthesized by `SystemsManager.synthesizeCompositeSystem`
> keyed on `areas.legacy_system_id`, so integer addressing is preserved with **no UUID rewrite** — the
> DELETE shipped without 404ing composite requests.
>
> **What actually remains (post-soak schema cleanup only, all gated on the soak + approval):** drop
> `areas.legacy_system_id` + its unique index (and re-key the remaining integer handles —
> `device_trackers.system_id`, `device_run_periods.system_id`, `dashboards.system_id`→`area_id`) once
> the synthesized-virtual-system path has soaked and call sites move off the integer handle. Schema
> source of truth: `lib/db/planetscale/schema.ts`. **The status table + "Headline reframing" below are
> retained for history but are no longer current.**

## ⟳ REFRESH 2026-06-15 (re-verified against `main` @ `3618de5`, post chart-generalization #80–#85)

> A multi-agent design pass re-checked every claim below against current code. **The sections from
> "## Dependency order" down predate the chart work — treat their file:line refs as approximate and
> this refresh as authoritative where they conflict.** Live numbers are from `liveone-dev`
> (re-verify on `sydney` before any DDL).

### Headline reframing (changes the whole picture)

**The destructive SQL is the last ~5% of the work, not the work.** Nothing in the serving/access
stack reads a composite **by `areas.id`** — everything addresses composites by integer `systemId`
(7=Craig, 8=Kinkora): `/api/data?systemId=`, `requireDashboardAccess(systemId)`,
`SystemsManager.getSystem(N)`, `PointManager`, `grid/context.ts` (`eq(areas.legacySystemId, N)`), KV
`latest:system:N`, the `dashboards(clerk_user_id, system_id)` unique. `area_id` is only a
forward-only annotation resolved **from** systemId (`getAreaForSystem`). **Deleting systems 7/8
before an integer→area addressing indirection ships + soaks would 404 every composite
dashboard/data/history/grid request.** That indirection is the LARGE, UNSTARTED prerequisite — it
gates the row delete; the DELETE itself is trivial by comparison.

### Status (corrected)

| Step                                                                                                             | State                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P3 read layer + areas/area_bindings/roles + `AREAS_TABLE` (#64)                                                  | ✅ landed                                                                                           |
| `dashboards.area_id` (#66)                                                                                       | ✅ landed                                                                                           |
| P3-tail-1 **Phase A** — recompute DELETEs flow_1d by `area_id`, route prefers `area_id` (#69)                    | ✅ landed                                                                                           |
| P3-tail-1 Phase A **"step 1"** (logical-system loud-error / non-null `areaId`)                                   | ✅ DONE (PR #87) — `resolveLogicalSystem` skips + logs on a null Area                               |
| P4 sharing MVP auth `requireDashboardAccess` (#72)                                                               | ◑ partially landed (out of scope; migration `0012` now applied dev + prod, as a side-effect of #87) |
| P3-tail-1 **Phase B** — drop `flow_1d.system_id`, re-key PK                                                      | ✅ DONE (migration `0013`, PR #87, 2026-06-15) — `area_id` is the sole PK                           |
| P3-tail-2 A/B/C — bindings authoritative → drop metadata shim → retire `AREAS_TABLE` + delete `CompositeAdapter` | ⬜                                                                                                  |
| Integer→area addressing prerequisite                                                                             | ⬜ **LARGE, unstarted — the real gate**                                                             |
| Destructive systems-row DELETE + KV cleanup                                                                      | ⬜ last                                                                                             |

### Critical ordering rules

- **`CompositeAdapter` removal (Phase C) MUST follow the systems-row DELETE** — the minutely cron
  `getAdapter` (`app/api/cron/minutely/.../route.ts:63`) returns null for an unknown vendor and hits
  its ERROR branch _before_ the push-skip, so removing it while rows 7/8 exist logs an error per
  composite every minute. (`supportsPolling` returns false for unknown, so render is non-regressing.)
- **NEXT-1 (logical-system loud-error) must precede dropping `flow_1d.system_id`** (else an
  unresolvable/new system writes a null `area_id` that violates the new NOT NULL in the daily cron).
- **Live FK graph (migration `0006` IS applied despite its "STAGED" header):** a naive
  `DELETE FROM systems` cascade-deletes the 1 composite dashboard + nulls 1 user `default_system_id`,
  and `areas.legacy_system_id`'s **no-action** FK _refuses_ the delete until those 2 Areas are cleared.

### Drift vs the sections below (don't trust their line refs)

- `DashboardClient.tsx` is now ~615 lines; `EnergyChart.tsx`/`SitePowerChart.tsx` are **deleted**;
  composite charts render via `components/SiteChartsCard.tsx` (gates on the string
  `vendorType==='composite'`, reads no metadata/bindings) — chart work added **zero** new composite
  coupling but invalidated the P3-tail-2/P4 line refs. The `metadata` field is `DashboardClient.tsx:65`,
  still unread by render (conclusion holds).
- Next migration is **0013** (disk has 0000–0012). Old PK name = `point_readings_flow_1d_system_id_day_source_path_load_path_pk`; index `prf1d_system_day_idx`.
- **`share_tokens` has no `system_id`** — the doc's "re-key share_tokens" is wrong; nothing to do.
- **Un-flagged metadata readers** missed by the doc: `lib/admin/get-systems-data.ts` + `/api/data` —
  Phase A must convert both or they silently empty when metadata mirroring stops.
- **Missing primitives** Phase A needs: a bindings→`{version:2,mappings}` **reverse converter**
  (`lib/areas/convert.ts` is forward-only) and `syncCompositeBindingsFromMappings` (current
  `syncCompositeBindings` still re-reads `metadata`).
- **Second column-skew surface:** `scripts/seed-preview-db.ts` COPYs flow*1d via `SELECT *`(column
\_position* sensitive) in addition to`sync-prod-to-dev.ts` — pause **both** across the 0013 window.

### Recommended next steps (the cheap, safe spine) — ✅ BOTH SHIPPED 2026-06-15 (PR #87)

1. **NEXT-1 ✅** — hardened `lib/aggregation/logical-system.ts`: `areaId: string` (non-nullable);
   `resolveLogicalSystem` logs + returns `null` on a null Area instead of `?? null`.
2. **NEXT-2 ✅** — P3-tail-1 Phase B: dropped `flow_1d.system_id` (migration `0013`, guarded DDL).
   The soak was **deliberately skipped** (sole user; `flow_1d` is a recomputable cache, not source
   data; guard + base backup + PITR cover rollback) — NEXT-1 + NEXT-2 shipped in one PR, dev-then-sydney
   in one window. Verified: `system_id` dropped, `area_id` NOT NULL + sole PK, 17,492 rows preserved,
   0 nulls, live read path 200 for identity (sys 1) + composite (sys 8) Areas.

**What's actually next** = P3-tail-2 (retire the composite `metadata` shim + pseudo-vendor) and, the real
bulk, the **integer→area addressing prerequisite** before the composite `systems`-row DELETE. P4 sharing
is independent. P3-tail-2 Phase A is parallel-safe but **off** the critical path to deleting the rows.

### Bottom line

~6 sequential, mostly soak-gated steps remain; realistically **2–4 weeks elapsed**, dominated by the
**integer→area addressing prerequisite (unstarted)**, not the DDL. Full enumerated re-key (every FK
reference, DO/RAISE gates, KV keyspace `latest:system:7/8`) is in `.context/areas-p3-tail-refresh.md`.

---

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
