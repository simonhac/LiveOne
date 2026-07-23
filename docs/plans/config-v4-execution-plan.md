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
>
> **Phase-3 reader batches (PR-G onward) are being committed to one branch
> `simonhac/config-v4-phase3-pr-g` WITHOUT a per-phase PR** (Simon, 2026-07-23 — re-establishing context
> after each PR is expensive). The per-commit doc/ledger discipline is unchanged (each phase's commit still
> flips the progress note, appends its ledger row, and re-points ▶ NEXT ACTION); only the "open a PR per
> phase" step is deferred — the batch lands as one PR (or merge) later, at which point the ledger's `_batched_`
> markers get the real PR number.

## ▶ NEXT ACTION — paste this into a fresh workspace to do the next PR

> **Self-perpetuating handoff (maintenance rule).** This block always holds exactly ONE live prompt: the
> very next PR to build. The agent building that PR **must, as the FINAL step BEFORE opening the PR — in
> the same commit, NOT after merge** — (a) flip the Phase-3 progress note, (b) append the landed row to
> the § Readings-seam ratchet ledger, and (c) **replace this block** with the next PR's prompt (same
> structure, same closing instruction). Doing this before-merge is what keeps `main` never behind the
> baseline even if the merge is delayed — the doc that ships *in* the PR already reflects that PR. Keep the
> prose lengths and constraints; only swap the specifics (PR letter, scope, files, verify steps, baseline
> count, prior-PR/branch references).

```text
Continue config-v4 Phase 3 in this repo. Read docs/plans/config-v4-execution-plan.md §3 (Phase 3) and
config-v4-clean-sheet.md for the why. PR-A (DAO seam + ratchet, #214), PR-B (receiver, #215), PR-C
(aggregate-points-pg.ts writer, #218), PR-D (daily-points.ts, #221), PR-E (readings-pg.ts, #224), PR-F
(CLEAN-READER BATCH, #226 — 6 pure readers), PR-G (vendor 5m reads amber/client, enphase/adapter,
oe/scheduler), and PR-H (observability + coverage: coverage/find-gaps, admin/observations/stats,
cron/monitor-observations; added coverage COUNT-by-local-day + created_at fleet counters + helper-blend MAX;
byte-identical verified on liveone-dev under TZ=UTC) have LANDED. NOTE: PR-G onward are being committed to
ONE branch (simonhac/config-v4-phase3-pr-g) WITHOUT a per-phase PR (Simon, 2026-07-23) — see the handoff
note at the top of this file; the per-commit doc discipline is unchanged, only the PR-per-phase step is
deferred. lib/readings/dao.ts is the seam: PointId-keyed readRaw/read5m/read1d/latestForPoints/
latest5mForPoints/countAgg5mByLocalDay/countAgg5mForLocalDay + insertRaw/insert5m/upsert1d, PLUS
non-point-keyed maintenance delete1dRange/earliestAgg5mMs/systemIdsWithAgg5mSince/
latestAgg5mIntervalMsForSystem/countByCreatedAtSince/createdAtHistogramSince/
distinctSystemsByRawCreatedAtSince/latestRawCreatedAtMs/maxAgg5mIntervalMsForSystems. 15 modules remain on
the baseline (5 app_lib + 10 scripts). Phase 3 adds NO migration (reads Phase-2's point_uid/rid).

Reader PR (I) ships dark, no pause (still verify fully); writer PRs (J/K) PAUSE for Simon's go-ahead +
byte-identical/idempotent verification. Trajectory to app_lib=0 is in § Readings-seam ratchet ledger.

Do PR-I: admin point-readings pivot. Migrate app/api/admin/systems/[systemId]/point-readings/route.ts and
lib/db/planetscale/readings-read-pg.ts onto ReadingsDao. PROFILE each module's exact hot-table access first
(this is the wide-pivot admin viewer — expect raw point_readings/agg_5m reads with keyset pagination, a ±10
row window, session labels, and existence probes; it may touch BOTH raw and agg_5m). CONFIRM read-only with
a grep; if it writes a gated table, pull that into its own paused PR.

Scope (design the MINIMAL new DAO surface, additive, // SEAM:-tagged, unit-tested in dao.test.ts — reuse
groupBySystem + rev so Phase 8 re-keys only these methods; where a query is fleet-wide/system-keyed put it in
the non-point-keyed maintenance block // SEAM:-tagged like systemIdsWithAgg5mSince):
1. readings-read-pg.ts: the wide-pivot read (rows × points), keyset pagination cursor, ±10-row context
   window around a timestamp, and any existence/last-value probes. Reproduce each query's keys/ordering
   byte-identically; identity via RegistryCache.pointForAddr (skip UnknownIdError).
2. the route: session-label joins + whatever hot-table access it does directly.
3. Shrink the ratchet — remove both from .readings-boundary-baseline.json app_lib (+ .eslintrc override IF
   either statically imports the symbols) → 13 baselined (3 app_lib). No raw hot-table name left in a string
   literal (comment-stripped; JSDoc/comments fine — reword prose/alert strings that name a table, as PR-H did).

Verify: `npm run build:local && npm run type-check` clean; `node scripts/check-readings-boundary.mjs` green
at 13; `npx next lint --file <changed files>` clean; `npm test` green (incl. new DAO-method tests); then a
throwaway scripts/temp diff script on liveone-dev proving each new DAO query == the old direct query
byte-for-byte for real systems — RUN IT UNDER TZ=UTC (drizzle parses timestamp-without-tz tz-invariantly;
raw db.execute parses in the machine tz, so a non-UTC dev box shows a spurious offset — prod is TZ=UTC).
Delete the script before committing.

IMMEDIATELY BEFORE COMMITTING (no per-phase PR — batched on this branch) — in the SAME commit, NOT a
post-merge chore: update this doc — (1) flip the Phase-3 progress-table note (PR-I landed / N modules remain
/ name the next); (2) append the PR-I landed row(s) to the § Readings-seam ratchet ledger (module | app_lib |
scripts | remaining; the new `remaining` MUST equal `npm run check:readings`); (3) REPLACE this "▶ NEXT
ACTION" block with the next prompt — writer PRs J = battery-provenance/recompute + battery-provenance-pg
(+per-point latestAgg5mIntervalMsForPoints, maxAgg5mUpdatedAt) → 1/10/11, K = hws/recompute → 0/10/10, each
PAUSES for Simon's go-ahead + byte-identical/idempotent verification (they WRITE agg_5m). Keep this same
self-perpetuating closing instruction — including the "immediately before committing" timing, the
no-per-phase-PR batching note, and the TZ=UTC verify caveat — in the new block.
```

## Progress

| Phase | State | Notes |
|---|---|---|
| 0 — Governance (doc) | ✅ DONE | prefixes corrected to `dv/pt/ar/db/dx/bn`; `retire-implied-areas.ts` annotated abandoned |
| 1 — `lib/ids/` TypeID codec | ✅ DONE | 33 tests incl. TypeID-spec base32 vectors + compile-time brand checks |
| 2 — `point_uid` NOT NULL + global `points.rid` | ✅ DONE | PRs #212/#213 (migration 0030) applied + verified on prod `sydney` + `liveone-dev`; `rid` backfilled 1..130 in `(system_id, id)` order, `point_rid_seq` reassigned to `postgres`. Prod was a migration behind, so 0029 (drop `point_readings_flow_1d`) was applied in the same pass — its guard required the bindingless synthetic area Kuti House / legacy `1000001` materialised in `flow_attr_1d` first. |
| 3 — uuid↔rid DAO seam + registry cache + lint ratchet | 🔨 IN PROGRESS ← **next** | highest-leverage strangler. **No new migration** (reads Phase-2's `point_uid`/`rid`). PR-A (dark foundation + ratchet, #214) + PR-B (receiver adoption — dual-grammar + publisher payload v2) + PR-C (first materialization writer `aggregate-points-pg.ts`; added DAO `insert5m` `preserveVendorMeta` value-only-upsert mode; byte-identical + idempotent verified on `liveone-dev`, prod `measurement_time` confirmed ms-granular) + PR-D (daily 1d agg `lib/aggregation/daily-points.ts` → DAO `delete1dRange`/`earliestAgg5mMs`/`systemIdsWithAgg5mSince`; byte-identical + idempotent verified on `liveone-dev`; #221) + PR-E (serving-path reader `lib/history/readings-pg.ts` → DAO `read5m`/`read1d`; identity via `RegistryCache.pointForAddr` with `UnknownIdError` skip-and-continue; `avgCache` reconstructed byte-identical; NO new DAO surface; pure reader, no pause) + PR-F (**CLEAN-READER BATCH** #226 — 6 pure readers `flow-series-pg`/`labs/kinkora-hws`/`enphase-history`/`battery-provenance/load`/`battery-provenance-daily-pg`/`run-periods-pg` → `read5m`/`read1d`/`readRaw`; added `ReadWindow.toInclusive` half-open upper bound + pure `upperBoundOp` helper; byte-identical verified on `liveone-dev` incl. half-open boundary + multi-point batch reverse-map; no pause) landed; **21 modules remain** (11 app_lib + 10 scripts). Readers profiled this session are NOT uniform → **6-PR trajectory** (§ Readings-seam ratchet ledger): 6 clean (done), 8 need new DAO surface (reader PRs G/H/I), 2 agg_5m writers (paused PRs J/K). PR-G (vendor 5m reads `amber/client`/`enphase/adapter`/`oe/scheduler`; added `createdAtMs`/`latest5mForPoints`/`latestAgg5mIntervalMsForSystem`) + PR-H (observability + coverage `coverage/find-gaps`/`admin/observations/stats`/`cron/monitor-observations`; added coverage COUNT-by-local-day `countAgg5mByLocalDay`/`countAgg5mForLocalDay` + created_at fleet counters `countByCreatedAtSince`/`createdAtHistogramSince`/`distinctSystemsByRawCreatedAtSince`/`latestRawCreatedAtMs` + `maxAgg5mIntervalMsForSystems`; both routes' raw `point_readings` counters moved behind the seam too; byte-identical verified on `liveone-dev` under `TZ=UTC`) landed; **15 modules remain** (5 app_lib + 10 scripts). PR-I = next (admin pivot: `admin/systems/[systemId]/point-readings` route + `readings-read-pg`). |
| 4 — additive v4 config schema + roles→CHECK | ⬜ TODO | all dark/nullable |
| 5 — v4 dashboard doc model + dual renderer | ⬜ TODO | |
| 6 — `/api/v4/*` route surface | ⬜ TODO | writes go live at cutover |
| 7 — cutover rehearsal harness | ⬜ TODO | prod snapshot branch only |
| 8 — THE CUTOVER | ⬜ TODO | single windowed op; pauses materialization, not pollers |
| 9 — post-cutover teardown | ⬜ TODO | |

Phases 0–6 all ship **dark**, behind the unchanged v3 app — each independently mergeable and reversible.

## Readings-seam ratchet ledger

Phase 3's boundary gate (`scripts/check-readings-boundary.mjs`, run via `npm run check:readings`;
`.eslintrc.json` `no-restricted-imports`) is a **monotonic ratchet**: each adoption PR moves one
module behind `ReadingsDao` and removes its `.readings-boundary-baseline.json` entry, so the baseline
only shrinks. **Live source of truth for the *remaining* set is `.readings-boundary-baseline.json`** —
this ledger records the *trajectory* the JSON can't self-record (which PR moved which module), not the
current list, so it never drifts.

| PR | Module moved behind `ReadingsDao` | `app_lib` | `scripts` | remaining |
|---|---|---|---|---|
| A · #214 | — (installed the baseline) | 21 | 10 | 31 |
| B · #215 | `app/api/observations/receive/route.ts` | 20 | 10 | 30 |
| C · #218 | `lib/db/planetscale/aggregate-points-pg.ts` | 19 | 10 | 29 |
| D · #221 | `lib/aggregation/daily-points.ts` | 18 | 10 | 28 |
| E · #224 | `lib/history/readings-pg.ts` | 17 | 10 | 27 |
| F · #226 | **batch of 6 clean readers** (`flow-series-pg`, `kinkora-hws` page, `enphase-history`, `battery-provenance/load`, `battery-provenance-daily-pg`, `run-periods-pg`) | 11 | 10 | 21 |
| G · _batched_ | **vendor 5m reads** (`amber/client`, `enphase/adapter`, `oe/scheduler`) | 8 | 10 | 18 |
| H · _batched_ | **observability + coverage** (`coverage/find-gaps`, `admin/observations/stats`, `cron/monitor-observations`) | 5 | 10 | 15 |

**Trajectory (readers batched — DECIDED this session):** the 8 remaining app_lib readers need new DAO
surface (grouped by shared surface), the 2 writers pause:
- **PR-G** ✅ vendor 5m reads (`amber/client`, `enphase/adapter`, `oe/scheduler`; +`createdAtMs`/`latest5mForPoints`/`latestAgg5mIntervalMsForSystem`) → 8 / 10 / **18**.
- **PR-H** ✅ observability + coverage (`coverage/find-gaps`, `admin/observations/stats`, `cron/monitor-observations`; local-day COUNT + `created_at`-axis fleet counters + helper-vendor blend MAX) → 5 / 10 / **15**.
- **PR-I** admin pivot (`admin/systems/[systemId]/point-readings` route + `readings-read-pg`; wide-pivot + keyset pagination + ±10 window + session-label + existence probes) → 3 / 10 / **13**.
- **PR-J** *(writer, PAUSES)* `battery-provenance/recompute` + `battery-provenance-pg` (+per-point `latestAgg5mIntervalMsForPoints`, `maxAgg5mUpdatedAt`) → 1 / 10 / **11**.
- **PR-K** *(writer, PAUSES)* `hws/recompute` → 0 / 10 / **10**.

**End state:** `app_lib` reaches **0** → delete `.readings-boundary-baseline.json` + the `.eslintrc.json`
override → the seam becomes a hard wall. The `scripts` lane is the slower / possibly-permanent-allow track
(per the baseline JSON's own `_doc`), so the hard-wall milestone keys off `app_lib`, not the combined total.

> **Maintenance:** every adoption PR appends one row here (the row for the PR *itself* — not the forecast
> row for the next one) and deletes its baseline entry **in the same commit, as the final step before the
> PR is opened** (never a post-merge chore); the newest `remaining` must equal `npm run check:readings`.

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
>
> **PR-C landed** (first materialization writer): `lib/db/planetscale/aggregate-points-pg.ts` (5m + 1d
> recompute) now speaks only `PointId` through `ReadingsDao` (`readRaw`/`insert5m` for 5m under the
> unchanged per-system `pg_advisory_xact_lock` tx; `read5m`/`upsert1d` for 1d), points enumerated from
> `point_info` `point_uid` → `Point.encode`, `UnknownIdError` caught per-interval/day (never-throw kept).
> Added the DAO's value-columns-only 5m upsert mode `insert5m(rows, {upsert:true, preserveVendorMeta:true})`
> (on-conflict SET = 7 value cols + `updated_at`) so the recompute never clobbers the vendor-meta columns a
> 5m-native queue write owns — byte-identical **by construction**, not by an emergent invariant. The
> half-open lower bound is reproduced with `readRaw` `fromMs=prevStart` + a JS `tMs > prevStart` guard
> (exact for ms-granular data; prod `measurement_time` confirmed 0 sub-ms). Removed from both ratchet lists
> (**29 remain**). Verified: `build:local`/`type-check`/lint/`npm test` (1015) green, boundary green at 29,
> and a real 5m + 1d recompute on `liveone-dev` (raw-vendor system 1) reproduced the pre-change rows
> byte-for-byte + idempotent.
> **Next: PR-D — writer `lib/aggregation/daily-points.ts` (needs a new DAO delete surface), pauses for go-ahead.**
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
