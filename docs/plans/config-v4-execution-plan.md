# Config v4 — execution plan

> **Status: ACTIVE (started 2026-07-22).** The *rationale* is [config-v4-clean-sheet.md](config-v4-clean-sheet.md)
> (the canonical design doc); this file is the *execution* plan — phasing, decisions locked with
> Simon, current-state reality, and per-phase progress.
>
> **Handoff / continuing in a new workspace:** this file is the single source of truth for "what's
> next." A fresh agent should read (1) this file, (2) [config-v4-clean-sheet.md](config-v4-clean-sheet.md)
> for the why, then start the first phase marked TODO in **Progress** below. Each phase is a separate
> branch/PR off `main`; the branch that ships a phase is archived, but this doc lives on `main`, so
> the next workspace always has the current plan.

## ▶ NEXT ACTION — paste this into a fresh workspace to do the next PR

> **Self-perpetuating handoff (maintenance rule).** This block always holds exactly ONE live prompt: the
> very next PR to build. Whoever lands that PR **must replace this block** with the following PR's prompt
> — same structure, same closing "when landed, write the next prompt here" instruction — so the chain
> keeps itself current. Keep the prose lengths and constraints; only swap the specifics (PR letter,
> scope, files, verify steps, baseline count, prior-PR/branch references).

```text
Continue config-v4 Phase 3 in this repo. Read docs/plans/config-v4-execution-plan.md §3 (Phase 3) and
config-v4-clean-sheet.md for the why. PR-A (DAO seam foundation + ratchet, PR #214) and PR-B (receiver
adoption) have LANDED. The observations receiver (app/api/observations/receive/route.ts) now writes
through ReadingsDao, dual-grammar: v2 payload `pointUid` → Point.encode; buffered/in-flight old
"{systemId}.{index}" refs → RegistryCache.pointForAddr(systemId, index); UnknownIdError propagates
(matches the old FK-abort). The publisher payload carries `pointUid` (lib/observations/types.ts +
publisher.ts; surfaced on PointInfoRow in lib/point/point-manager.ts). The receiver is off the ratchet
baseline (30 modules remain). Phase 3 adds NO migration (reads Phase-2's point_uid/rid).

Do PR-C: migrate the FIRST materialization WRITER — lib/db/planetscale/aggregate-points-pg.ts (the 5m +
1d recompute) — onto ReadingsDao. This is a prod-write-path change: build and verify fully, but PAUSE for
Simon's explicit go-ahead before committing/merging.

Scope:
1. Replace this module's raw hot-table access with the DAO: reads via ReadingsDao.readRaw / read5m (the
   recompute reads raw point_readings over (prevStart, intervalEnd] per interval, and for 1d reads agg_5m
   over the day span + prev-day 00:00), writes via ReadingsDao.insert5m({upsert:true}) / upsert1d.
   Semantics VERBATIM — same conflict targets/sets, same per-system pg_advisory_xact_lock tx, same
   interval math (lib/aggregation/point-aggregates.ts). point_info meta (transform/metricType) still
   comes from point-manager, not the readings DAO.
2. CRITICAL — keep the best-effort skip-missing-meta guard (aggregate-points-pg.ts ~228-232): a point
   absent from the point_info mirror is SKIPPED, never throws. The DAO/registry THROW UnknownIdError on
   unknown points, so resolve identity defensively — skip a missing point BEFORE any PointId resolution
   that could throw; recompute5mForRawObservationsBestEffort / recompute1dForDayBestEffort must stay
   never-throwing (each is wrapped in a swallowing try/catch — don't rely on that, keep them clean).
3. Shrink the ratchet — remove lib/db/planetscale/aggregate-points-pg.ts from BOTH .eslintrc.json's
   override AND .readings-boundary-baseline.json app_lib (the STALE check enforces it) → 29 baselined.

Verify before asking for go-ahead: `npm run build:local && npm run type-check` clean; `node
scripts/check-readings-boundary.mjs` green with 29 baselined; `npm test` green; and drive a REAL raw poll
→ receiver → post-commit 5m recompute (and a daily 1d recompute) on liveone-dev, then read the agg rows
back via ReadingsDao AND raw SQL and confirm identical rows to the pre-change recompute. Then stop and
report; Simon gives the go-ahead to land.

WHEN PR-C IS LANDED: update this doc — flip the Phase 3 progress notes, then REPLACE the "▶ NEXT ACTION"
block at the top with the PR-D prompt (next module lib/aggregation/daily-points.ts, then the readers
history/readings-pg.ts, flow-series-pg.ts, battery-provenance/load.ts, coverage/find-gaps.ts, then the
admin/cron raw-SQL routes — each PR migrates one module AND deletes its baseline entry; writer PRs pause
for go-ahead). Keep this same self-perpetuating closing instruction in the new block.
```

## Progress

| Phase | State | Notes |
|---|---|---|
| 0 — Governance (doc) | ✅ DONE | prefixes corrected to `dv/pt/ar/db/dx/bn`; `retire-implied-areas.ts` annotated abandoned |
| 1 — `lib/ids/` TypeID codec | ✅ DONE | 33 tests incl. TypeID-spec base32 vectors + compile-time brand checks |
| 2 — `point_uid` NOT NULL + global `points.rid` | ✅ DONE | PRs #212/#213 (migration 0030) applied + verified on prod `sydney` + `liveone-dev`; `rid` backfilled 1..130 in `(system_id, id)` order, `point_rid_seq` reassigned to `postgres`. Prod was a migration behind, so 0029 (drop `point_readings_flow_1d`) was applied in the same pass — its guard required the bindingless synthetic area Kuti House / legacy `1000001` materialised in `flow_attr_1d` first. |
| 3 — uuid↔rid DAO seam + registry cache + lint ratchet | 🔨 IN PROGRESS ← **next** | highest-leverage strangler. **No new migration** (reads Phase-2's `point_uid`/`rid`). PR-A (dark foundation + ratchet, #214) + PR-B (receiver adoption — dual-grammar + publisher payload v2) landed; receiver off the baseline (30 remain). PR-C = first materialization writer `aggregate-points-pg.ts`, pauses for go-ahead. |
| 4 — additive v4 config schema + roles→CHECK | ⬜ TODO | all dark/nullable |
| 5 — v4 dashboard doc model + dual renderer | ⬜ TODO | |
| 6 — `/api/v4/*` route surface | ⬜ TODO | writes go live at cutover |
| 7 — cutover rehearsal harness | ⬜ TODO | prod snapshot branch only |
| 8 — THE CUTOVER | ⬜ TODO | single windowed op; pauses materialization, not pollers |
| 9 — post-cutover teardown | ⬜ TODO | |

Phases 0–6 all ship **dark**, behind the unchanged v3 app — each independently mergeable and reversible.

## Context

Persistence for dashboards/areas/device-config/wiring was reached by iteration (per-system
dashboards → composite systems → areas-backed virtual systems → v3 composition). It works but
carries: the polymorphic integer handle (`areas.legacy_system_id` as the universal address,
≥1,000,000 = synthetic area) — a standing type-confusion bug factory; duplicated placement
(tz/location on both `systems` and `areas`); two sharing systems; free-text spec columns; a SQL
projection of a code registry; a hidden binding mode-switch; and two unrelated "derive a signal"
mechanisms (run-tracking vs HWS model).

Config v4 is the agreed clean sheet: one TypeID public ID space with the integer handle retired,
`systems`→`devices`, eager areas owning tz/location, unified sharing (dashboards only), trackers +
HWS generalized to `derivations`, and a recursive dashboard node tree (card/tile unified). A
one-time cutover is acceptable; hot time-series tables stay compact via an internal integer `rid`
behind a single data-access seam.

**Posture:** push as much value as possible through *reversible, ships-behind-the-unchanged-app*
dark prep before the single irreversible cutover, so the risky window is small, rehearsed, and
deterministic. The seam contract — **uuids above, rids below** — is made true the moment
`points.rid` exists (even while hot tables are still composite-keyed); the cutover then flips only
the DAO's internal SQL, changing nothing above the seam.

## Locked ID scheme (confirmed with Simon)

Public IDs are TypeIDs: `prefix_` + Crockford-base32(UUIDv7) (26-char suffix). DB stores the raw
`uuid`; the prefix is wire/URL only. Confirmed 2-letter prefixes:

| Entity | Prefix | | Entity | Prefix |
|---|---|---|---|---|
| device | `dv` | | dashboard | `db` |
| point | `pt` | | derivation | `dx` |
| area | `ar` | | binding | `bn` |

The codec (`lib/ids/`) is the single source of truth. Owner-scoped human **slugs** remain for pretty
URLs. Share tokens stay 3-word phrases (no prefix); dashboard-doc nodes keep local `n_…` ids (not
scope-bearing TypeIDs, §8.3); `users` keep Clerk ids.

## Current-state reality (where the codebase diverges from the proposal's sketch)

Verified during planning — start from these facts, not the proposal's idealized DDL:

- **Postgres**, despite the `lib/db/planetscale/` path. Schema `lib/db/planetscale/schema.ts`.
  Migrations are **manual** drizzle-kit (`db:pg:generate`/`db:pg:migrate`), **never at deploy** —
  every migration must hit prod `sydney` *and be verified* before the code PR that reads it merges.
- **`lib/ids/` now exists** (Phase 1). `lib/identifiers/` holds handle-era string ID classes
  (`SystemIdentifier`, `PointReference` `"sys.pt"`, `SeriesPath`) + `point-uid.ts` (server-only
  uuidv5 via `node:crypto`) — leave those alone; do NOT fold them into `lib/ids`.
- **`point_uid` is present but NULLABLE and only partially backfilled** (`scripts/utils/
  backfill-point-uid.ts`, idempotent, `--commit`). Hot tables FK on the renameable *address*
  `(system_id, id)`, not the uid.
- **`point_info` PK is `(system_id, index)` where the TS field `index` maps to DB column `"id"`.**
  Per-device index allocator in `point-manager.ts ensurePointInfo` = read `max+1`, no txn.
- `point_readings` (~13M): surrogate serial PK + unique `(system_id, point_id, measurement_time)`,
  composite FK →`point_info`. `agg_5m` (~3M) PK `(system_id, point_id, interval_end)`; `agg_1d` PK
  `(system_id, point_id, day text)`. `sessions` (~870K) text PK; `observations_outbox` bigserial.
- **No single time-series DAO** — reads scattered across ~40 modules; the receiver
  (`app/api/observations/receive/route.ts`) extracts the point index from
  `observation.debug.reference.split(".")[1]`. The "one seam" (§5) is net-new.
- The integer handle resolves **structurally** via `SystemsManager.isAreaHandle` (a DB lookup), not
  a numeric threshold; `synthesizeAreaView` fabricates a virtual system.
- **`areas` has no `day_offset_min` and no `config` column today**; `area_bindings` has **no
  `priority` column** (ordinal only) and **no stem/role enforcement on write** (advisory `●` dot in
  `BindingsTab.tsx` only). Source selection folds **last-wins** (`lib/aggregation/flow-series.ts`).
- The `roles` SQL table has **no committed full-set seeder** (only the generator row is upserted;
  the original was deleted) → v4 replaces it with CHECK constraints generated from
  `lib/roles/registry.ts` (`ROLES` = all 6, incl. `generator`, which is absent from `ROLE_IDS`).
- Dashboards: serial id PK; descriptor in jsonb column **`descriptor`** (not `doc`); **no revisions
  table**. v3 descriptor `{version:3, sections:[…]}` in `lib/dashboard/v3.ts`; `normalizeDescriptor`
  assigns ids for `sankey` only.
- **SSR seeding is hard-coded to v3 shapes** (`app/dashboard/[...slug]/page.tsx`
  `renderCompositionDashboard` walks `sections[].cards[].tiles[].deviceSystemId`).

## Reconciliation: eager areas vs the "explicit areas only" model on main — DECIDED (Option A)

The "explicit areas only" model already landed on `main` (commit `42a24fa0` #189): it deleted the
eager-mint/lazy-heal (`lib/areas/sync.ts`), stopped `createSystem` minting an area-of-one, and
added `scripts/cleanup/retire-implied-areas.ts` (**A2**, dry-run by default, **never run**) which
would DELETE the implied areas-of-one `{1,2,3,4,5,6,9,10,11,12,14,1000001}` and keep `{7,8,13,
1000002}`. v4 decision 3 (eager areas; tz+location live only on the area) reverses this.

**Option A (locked):**
1. **Do NOT run `retire-implied-areas.ts` (A2)** — now annotated abandoned. Deleting those
   areas-of-one destroys their uuid-keyed `flow_attr_1d` / `battery_provenance_daily` history.
2. **The cutover mints uniformly and idempotently:** every device ends with exactly one
   `primary_area_id`; an area-of-one is minted where missing; `day_offset_min`/`location` copied
   verbatim from the device. Because `devices` no longer carries tz/location, the area-of-one is the
   sole home for placement, not a duplicate — dissolving A1/A2's motivation rather than contradicting it.
3. **`devices.primary_area_id` → NOT NULL** (staged nullable in Phase 4, flipped in the cutover).
4. **Bare-device rendering:** the `synthesizeAreaView`/`isAreaHandle` path dies; every device
   resolves through its area-of-one. Regression net exists:
   `lib/point/__tests__/point-manager-area-of-one-parity.test.ts` — keep/extend it as the cutover
   parity assertion. Areas-of-one just shouldn't clutter the user-facing area picker (a render filter).
5. A2's one useful act — dropping the empty synthetic composite `1000001` — folds into the cutover
   transform (don't carry forward a synthetic composite with zero members).

## Phased execution plan

Ordering is a hard dependency chain (migrations lead code to prod).

### Phase 0 — Governance (doc-only)  ✅ DONE
- Corrected proposal §5 prefixes to `dv/pt/ar/db/dx/bn`; annotated `retire-implied-areas.ts` as
  abandoned (Option A). Confirmed: Simon, 2026-07-22.

### Phase 1 — `lib/ids/` TypeID codec  ✅ DONE
- New `lib/ids/` (`base32.ts`, `uuid.ts`, `types.ts`, `typeid.ts`, `index.ts`), client-safe. Six
  codecs `Device/Point/Area/Dashboard/Derivation/Binding`; branded `TypeId<P>` so cross-entity misuse
  is a compile error. 33 tests: round-trip, `ParseError` codes, TypeID-spec `valid.yml`/`invalid.yml`
  vectors, `@ts-expect-error` brand checks. No migration, no wiring — inert until a consumer imports it.
- **Deferred:** the optional `no-restricted-imports` ban on `uuidv7` outside `lib/ids/**` (cleaner
  once real callers exist).

### Phase 2 — Point identity hardening: `point_uid` NOT NULL + global `rid` (dark, additive)  ✅ DONE
> Shipped as PR #212 (mint `point_uid` in all writers) + PR #213 (migration 0030: `point_uid` NOT NULL +
> `point_rid_seq` + `point_info.rid`, backfilled 1..130 in `(system_id, id)` order). Applied + verified on
> prod `sydney` and `liveone-dev`; `point_rid_seq` reassigned to `postgres`. Prod was a migration behind,
> so 0029 (drop `point_readings_flow_1d`) was applied in the same pass — its partial-materialisation guard
> first required the bindingless synthetic area (Kuti House / legacy `1000001`) present in `flow_attr_1d`.
- **B1** run `scripts/utils/backfill-point-uid.ts --commit` on prod to 100% (`WHERE point_uid IS
  NULL` count = 0 gates the next step).
- **B2** `point_uid` → NOT NULL (migration; `ALTER … SET NOT NULL` fails loud if any NULL remains).
- **B3** `CREATE SEQUENCE point_rid_seq`; add `point_info.rid int`, backfill `nextval` ordered by
  `(system_id, index)` for determinism, `SET NOT NULL` + unique + column `DEFAULT nextval` —
  **global, not per-device**.
- **B4** `rid` allocated by the sequence default (kills the `max(index)+1` race for the hot key);
  `ensurePointInfo` keeps allocating `index` only to satisfy the composite FK until cutover.
- Reversible: drop constraint/column/sequence. Deps: none (B1 gates B2).

### Phase 3 — Time-series DAO seam + registry cache + lint ratchet (dark strangler — highest leverage)  🔨 IN PROGRESS
> **No new migration** — reads Phase-2's `point_uid`/`rid` + the existing composite address. Pure code.
> Landing as a sequence of PRs on `simonhac/config-v4-phase3-dao-seam`; PR-A (below) is dark (no prod
> writes → mergeable); adoption PRs that touch a prod write path pause for Simon's go-ahead.
>
> **PR-A landed** (dark foundation + ratchet): `lib/registry/` + `lib/readings/schema-internal.ts` +
> `lib/readings/dao.ts` + tests + the two-tool ratchet (`.eslintrc.json` `no-restricted-imports` +
> `scripts/check-readings-boundary.mjs` + `.readings-boundary-baseline.json`, 21 `app_lib` + 10
> `scripts`). Build-verified no-op (`build:local` green; both gates fail on a new violator). No adoption.
>
> **PR-B landed** (receiver adoption — first prod-write change): publisher payload v2 adds `pointUid`
> (`Observation` + `buildObservations`; surfaced on `PointInfoRow`/`pgPointInfoToServed`), the receiver
> (`app/api/observations/receive/route.ts`) resolves dual-grammar (v2 `pointUid` → `Point.encode`;
> legacy `{systemId}.{index}` → `RegistryCache.pointForAddr`, `UnknownIdError` propagates = old FK-abort)
> and writes through `ReadingsDao.insertRaw`/`insert5m` inside the existing tx; removed from both ratchet
> lists (30 remain). Verified: type-check/lint/`npm test` green, `build:local` clean, and a real
> receiver→DAO E2E on `liveone-dev` (both grammars, DAO read == raw SQL).
> **Next: PR-C — first materialization writer `aggregate-points-pg.ts` (5m/1d recompute), pauses for go-ahead.**
- `lib/registry/registry-cache.ts` — the ONLY owner of uuid↔rid↔address, branded `PointRid`/`DeviceRid`
  (number brands), `UnknownIdError`. `globalThis`-memoized, 60s per-entry TTL, `invalidate()` on writes;
  batch `addrsForPoints`/`ridsForPoints`/`addrsForRids` + `pointForAddr` (old-grammar / backlog map).
  **No negative caching** (a miss always hits the DB — a just-minted point must resolve immediately);
  positive entries are safe stale because rid/address/uuid are write-once (TTL is a memory bound only).
- `lib/readings/schema-internal.ts` — the ONLY importer of `point_readings`/`agg_5m`/`agg_1d` (and
  post-cutover the `rid` columns); **not** re-exported from the main schema barrel.
- `lib/readings/dao.ts` — the DAO: **uuids in, rids internal**. `readRaw/read5m/read1d/
  latestForPoints/insertRaw/insert5m/upsert1d`, all `PointId`; epoch-ms at the boundary; `SeriesByPoint`
  per-point results. Pre-cutover expands `PointId→(system_id,index)` via the registry and issues today's
  composite SQL (semantics verbatim); the two `// SEAM:` sections are what Phase 8 reimplements as
  `point_rid` SQL. **Public signatures don't change across the cutover** (a design property, not a live
  dead `rid` branch — those columns don't exist on the hot tables yet).
- Adopt incrementally: (1) land DAO **[PR-A]**; (2) migrate the **receiver first** — dual-grammar
  (payload **v2** carries `point_uid`; buffered old `{systemId}.{index}` refs → `pointForAddr`); device
  identity stays `systemId` (no device uuid column yet) **[PR-B, pauses]**; (3) `point-manager`/materialisation
  writers; (4) the ~27 reader modules one per PR.
- **Lint ratchet** = `no-restricted-imports` (`.eslintrc.json`, static/aliased imports — editor + husky
  feedback) **+** `scripts/check-readings-boundary.mjs` (authoritative `prebuild` gate: also catches
  dynamic `import()`, raw-SQL strings, and `scripts/`+`packages/`). Installed with a full **baseline**
  (`.readings-boundary-baseline.json`, 21 `app_lib` + 10 `scripts`) that shrinks one module per adoption
  PR; NEW and STALE violators both hard-fail (monotonic). Fixture: `scripts/__tests__/check-readings-boundary.test.ts`.
- Deps: Phase 2 (needs `point_uid` NOT NULL + `rid`) — met.

### Phase 4 — Additive v4 config schema, empty/nullable + roles→CHECK (dark)
Create FK targets before referrers:
- `areas.day_offset_min` (backfill = `timezone_offset_min`), `areas.config` jsonb.
- `systems` dark columns: `rid UNIQUE` (= `id`), `config`, `adapter_state`, `primary_area_id`
  (nullable for now), `slug`.
- `dashboards`: `doc jsonb`, `revision int`, `slug`; `dashboard_revisions` table; `legacy_id` (frozen).
- `derivations` + `derived_intervals`; unified `share_tokens` twin; `dashboard_grants`;
  `legacy_handles (handle int PK, device_id uuid NULL, area_id uuid NULL)`.
- **roles → CHECK** generated from `lib/roles/registry.ts` (all 6); add to `area_bindings.role` /
  `derivations.role` alongside the FK; drop the `roles` table only at cutover (grep every FK first).
- Deps: Phase 2/3. Each migration applied to prod ahead of any reader.

### Phase 5 — v4 dashboard doc model: types, validator, rewriter, dual renderer (dark)
- `lib/dashboard/v4.ts` + `card-types.ts` — unified `group`/`card` node tree; branded
  `AreaRef`/`DeviceRef` **only** in the envelope (§8.3 invariant baked into the shape). The v3
  `"tiles"` container disappears (→ row group); every `TileView` becomes a first-class `CardType`.
- `lib/dashboard/v4-validate.ts` — zod layering (envelope strict/422; `type` open-string
  warn-not-reject; known-type strict config; refs always strict + readable), depth cap ~4, and
  `normalizeDocV4` that assigns every node a local `n_…` id idempotently.
- `lib/dashboard/v3-to-v4.ts` — pure `rewriteV3ToV4(v3, resolver)` behind a `LegacyRefResolver`:
  `areaRef(uuid)` pure (ships dark); `deviceRef(legacyId)` needs minted `devices` + `legacy_handles`
  (rehearsal-only until cutover). Round-trip + **scope-equivalence** validation.
- Merged registry: `cards/registry.tsx` + `tiles/registry.tsx` → one `CARD_RENDERERS` keyed by
  `CardType`; `group` is structural via a recursive `<NodeView>` (threads `NodeContext`
  area/device inheritance; moves the chart+sankey→`SiteChartsGroup` collapse into the group
  renderer). `catalog.ts` `TILE_CATALOG`+`CARD_CATALOG` → one `NODE_CATALOG`. **Dual-shape render
  window** (accepts both v3 and v4 for one release) retires the "rewrite breaks a live dashboard" risk.
- `lib/dashboard/resolve-shell.ts` — pure in-process `resolveDashboardShell(doc, viewer)` +
  `collectRefs(doc)` (one type-agnostic envelope walk). Refactor `renderCompositionDashboard` to use
  them; cache key `(dashboard_id, revision)`.
- Deps: Phase 1.

### Phase 6 — `/api/v4/*` route surface (dark; writes go live at cutover)
- Full route table (proposal §9.2). Whole-doc `PUT` in one txn: `SELECT … FOR UPDATE`; `If-Match`
  mismatch → **412**; validate+normalize → **422** (nothing persisted); else insert
  `dashboard_revisions`, bump `revision`, invalidate the `(dashboard_id, revision)` shell cache, echo
  normalized doc + new ETag. `If-Match` optional. Restore copies forward, never rewinds.
- **Coexist vs replace:** single write surface (replace v3 descriptor PATCH at cutover), a brief
  dual-shape *render* window, permanent `?systemId=` data-fetch compat alias via `legacy_handles`.
- Deps: Phases 1, 4, 5.

### Phase 7 — Cutover rehearsal harness (prod snapshot branch only)
- Full cutover script + parity checks, end-to-end on a throwaway snapshot branch. Two outputs: all
  parity checks pass, and the 13M+3M rewrite fits the window (else pre-copy + delta-catchup). Iterate
  to green, then schedule the real window. Deps: Phases 1–6 live and burned-in.

### Phase 8 — THE CUTOVER (single irreversible window)
1. **Pause materialization only** — `POST /api/admin/observations/info {action:"pause"}` freezes
   QStash delivery→receiver→hot-table writes (hot tables go static). **Keep `CRONS_ENABLED=true`** so
   poll+push collection and the relay keep buffering into the outbox + the paused queue. No poller
   pause, no drain-to-zero.
2. Mint registries: `devices` (`rid` = old `systems.id`; seed `device_rid_seq` at `max+1`); `points`
   (`id` = `point_uid` PK, `rid` PK); `areas` carried over (uuids preserved), `day_offset_min` set;
   mint area-of-one for area-less devices (tz/location copied up); `primary_area_id` → NOT NULL. Drop
   empty synthetic composites (`1000001`).
3. Freeze `legacy_handles` (every old `systems.id` + `areas.legacy_system_id`).
4. Rewrite hot tables: JOIN-insert `(point_rid, time)`-keyed twins → rename-swap (keep `_old`);
   `sessions`/`outbox` column rename `system_id`→`device_rid` (no rewrite); the DAO's internal SQL
   flips to rid-keyed, but the `(system_id,index)→point_rid` addr map is **retained** for the
   receiver's backlog drain; the receiver becomes **dual-grammar** (uuid payload-v2 + old int refs).
5. Transform config: bindings → `pt_` uuids + `priority`; trackers + HWS → `derivations` +
   `derived_intervals`; grants; unified `share_tokens` (dashboard tokens 1:1; live legacy owner
   tokens re-pointed at auto-created dashboards); dashboards get uuids + frozen `legacy_id`, docs
   rewritten v3→v4; `users.default_dashboard_id` re-pointed.
6. KV: delete `latest:system:*` / `subscriptions:system:*`; rebuild under `latest:area:{ar_…}` /
   `latest:device:{dv_…}`; warm from PG or accept ≤1 poll cycle cold.
7. Deploy the cutover build (`systems`→`devices` rename; delete `synthesizeAreaView`/`isAreaHandle`
   + `AREA_HANDLE_BASE`; dual-grammar receiver live); run parity checks; then `{action:"resume"}` →
   the buffered backlog drains into the new rid-keyed tables. **Resume-after-green is the one-way door.**

### Phase 9 — Post-cutover teardown
- After the backlog drains and a validation window passes: drop `_old` hot tables; drop the
  `(system_id,index)→point_rid` backlog-drain map; drop `systems`/`point_info`/`roles`/
  `user_systems`/legacy token tables; delete dead handle-era code. Keep **permanently**:
  `legacy_handles`, `dashboards.legacy_id` (`/dashboard/id/{n}` 301), `?systemId=N` alias, slug URLs,
  share-token strings.

## Collection continuity (no ingest freeze — verified)

Collection is durably buffered and fully decoupled from materialization, so pollers never stop and no
data is lost — only materialization latency that catches up on resume.

- **One publish seam for every vendor (poll AND push).** All ingest funnels through
  `insertPointReadingsRaw` → collector → `publishPoll` (`lib/observations/poll-collector.ts`), which
  writes each `QueueMessage` to `observations_outbox` (durable, `onConflictDoNothing`) **before** the
  best-effort QStash enqueue. Collection **no longer writes `point_readings` directly**
  (`point-manager.ts:731`). Push vendors (`fusher`/`fronius`/`gush`) share that seam **and** carry a
  second durable client-side spool (`packages/usher/core/spool.ts`).
- **A materialization pause already exists — no code change.** `POST /api/admin/observations/info
  {action:"pause"}` → `queue.upsert({paused:true})`: a paused queue keeps *accepting* enqueues but
  stops *delivery*. Keep `CRONS_ENABLED=true` (poller + relay keep filling the outbox). **Do NOT set
  `CRONS_ENABLED=false`** — that stops the relay too.
- **The one requirement — a dual-grammar receiver.** Buffered messages carry the OLD
  `"{systemId}.{pointIndex}"` int reference (`publisher.ts:79`; receiver `split(".")[1]`). Messages
  drained *after* the cutover must be translated to `point_rid` via a frozen `(system_id, index) →
  point_rid` map (retained until the backlog drains, dropped in Phase 9). `device_rid = system_id`
  makes the systemId half trivial.

## Cross-cutting mechanics

- **Migrations lead code to prod.** Every Phase 2/4 migration is applied to `sydney` and verified
  before the reader PR merges.
- **Buffer, don't freeze** (see Collection continuity) — replaces any drain-to-zero step.
- **KV is a disposable cache** — the old build rebuilds `latest:system:N` from PG, keeping the KV
  step reversible right up to the deploy.
- **The cutover build is all-or-nothing** (the `systems`→`devices` rename admits no half-deploy).

## Rollback (irreversibility boundary = "the new build accepts a reading")
- Steps 1–3 fully reversible — abort = `{action:"resume"}` on the still-live old build (drains the
  int-keyed backlog into the old int tables), drop new.
- Step 4 reversible while `_old` retained — abort = rename `_old`→live, drop twins.
- Step 5 writes only new config tables — abort = discard them.
- Step 6 destructive but KV is a cache — abort = redeploy old build, re-warm from PG.
- Step 7: abort **before** resuming = redeploy previous build + `_old`→live + resume. Abort **after**
  resume lands a reading on rid-keyed tables = forward-fix only. Hold the pause until parity is green.

**Parity checks (all must pass before resume):** per-table row counts old vs twin; per-point last
value; per-area point-set vs a pre-freeze snapshot; `agg_1d` day boundaries; `flow_attr_1d` sums
unchanged; **per-area series-set equality** (binding-order must not alter sankey/series enumeration).

## Decisions
- **Eager-areas / A2: DECIDED — Option A** (abandon `retire-implied-areas.ts`, keep areas-of-one,
  cutover mints uniformly, `primary_area_id` NOT NULL).
- **§15 opens (bake as recommended, non-blocking):** `oe-grid` → area-level; `/api/v4` → replace not
  coexist; depth cap = 4; group `direction` default `column`.

## Verification (per phase)
- **Phase 1 (done):** `npx jest lib/ids` (33 pass) — round-trip, `ParseError` codes, spec vectors,
  compile-time brand checks.
- **Phase 2:** backfill `count=0` gate; migration applies clean on a snapshot; `rid` uniqueness +
  ordered-backfill determinism.
- **Phase 3:** `jest lib/registry lib/readings` (uuid↔rid↔addr round-trips, miss-fill,
  `UnknownIdError`, insert semantics preserved); drive a real poll → receiver → read back via the DAO,
  identical rows; lint fixture fails on a banned hot-table import.
- **Phase 5:** rewriter round-trip + scope-equivalence over fixtures of every prod dashboard shape;
  dual-shape renderer matches v3 output; area-of-one parity test extended.
- **Phase 7/8:** full rehearsal on a prod snapshot branch — all parity checks green + rewrite fits the
  window — before scheduling the real cutover.
- Throughout: `npm run build:local && npm run type-check` before each commit; migrations applied to
  prod and verified before the dependent PR merges.
