# Config v4 — execution plan

> **Status: ACTIVE (started 2026-07-22; Phases 0–9 shipped).** The _rationale_ is
> [config-v4-clean-sheet.md](config-v4-clean-sheet.md) — the canonical design doc, and the source of the
> finish-line checklist (§4.8 "What dies"). This file is the _execution_ plan: what has landed, what is
> still legacy, and the phases that finish the job.
>
> **Handoff / continuing in a new workspace:** read (1) this file, (2) the clean-sheet for the why, then
> start the first phase marked TODO. Each phase is one branch/PR off `main`; branches are archived but this
> doc lives on `main`, so the next workspace always has the current plan. Each future phase below is
> deliberately one page — the owning agent develops the detail.

## ▶ NEXT ACTION — Phase 11 PR 2: apply migration 0041. **Phase 10 COMPLETE; Phase 11 PR 1 LIVE.**

Phase 9's PR 1 + PR 2 merged as [#250](https://github.com/simonhac/LiveOne/pull/250). **PR 3 ("aesthetic
changes") is SCRAPPED** (Simon, 2026-07-27) — aesthetic work waits until the migration is 100% complete
(i.e. after Phase 14), so it is not part of this plan at all.

**✅ PHASE 10 COMPLETE (2026-07-27).** Both halves, on both environments, with both Phase-9 loose ends
settled:

- **Code half** ✅ (#251) — cutover scaffolding retired, cutover pause disarmed.
- **Schema half** ✅ (#252, #253) — 0036–0039 applied and audit-verified on `liveone-dev` AND prod
  `sydney`. `db:pg:generate` reports "No schema changes"; both DB-equivalence audits sit at **120
  statements, zero unexplained, shape-identical** — that is the permanent residue. `_old` +
  `backfill_progress` gone (4,216 MB dev / 4,140 MB prod), hot-table index names canonical, zero `_new`
  names anywhere, boundary-guard regex simplified.
- **`rewrite-descriptor-area-refs.ts` on prod** ✅ — the last Phase-9 loose end. Dry-run first under a
  **read-only** role (so an accidental write would fail, not succeed silently), descriptors backed up to
  `.context/backups/prod-descriptors-pre-arid.json`, then committed under a short-TTL write role:
  **16/16 sections across 4 v3 dashboards rewritten raw-uuid → `ar_`**, 0 unrecognized. Verified three
  ways — the script's own post-write re-inspect, an independent `jsonb` query (16 `ar_`, 0 raw uuid), and
  end-to-end on live prod (shared dashboard renders; `/api/data?access=` returns live data; a bogus token
  401s). **This unblocks the Phase-14 strict-decode tightening** (dropping the dual-accept
  `areaRefToUuid` + `rowToDashboard` read-normalize).

> **Correction worth carrying:** the prod cutover ran **2026-07-26 10:51 UTC**, not 25 Jul. The 25 Jul
> figure is migration 0035's journal `when` (its generation time); the transform was out-of-band and
> later. `point_readings_old`'s last write — the terminal rename-swap — dates it precisely. So the `_old`
> validation window at drop time was ~26 h, not ~2 days. Guards passed with live strictly ahead on all
> three tables (15,664,671 vs 15,599,219 raw), and backup `fzmopfcooojg` (2.69 GB, verified `success`)
> was taken minutes before.

> 🛑 **Ordering rule, learned by breaking prod during 0037 (full detail in step 6 below).** CLAUDE.md's
> "apply migrations to prod BEFORE the dependent code merges" is the **additive** rule. **Drops invert
> it:** deploy the code that stops referencing the column FIRST, then drop. A projection-less
> `.select()` expands to the columns declared in the _running_ build, so any column drop is a breaking
> change until the new build is live.

> **Correction worth carrying:** the prod cutover ran **2026-07-26 10:51 UTC**, not 25 Jul. The 25 Jul
> figure is migration 0035's journal `when` (its generation time); the transform was out-of-band and
> later. `point_readings_old`'s last write — the terminal rename-swap — dates it precisely. So the `_old`
> validation window at drop time was ~26 h, not ~2 days. Guards passed with live strictly ahead on all
> three tables (15,664,671 vs 15,599,219 raw), and backup `fzmopfcooojg` (2.69 GB, verified `success`)
> was taken minutes before.

**Also done 2026-07-27:** the Phase 7/8 rehearsal branches `rehearse-5` (`fq7uult9pcir`) and `rehearse-6`
(`z3ok95wtk88o`) were **deleted** — they were restored-from-prod copies, unreferenced outside these plan
docs, and had been billing since the cutover. `liveone` now has only the `sydney` branch.

## Where we are

### The problem this replaces

Persistence for dashboards/areas/device-config/wiring was reached by iteration (per-system dashboards →
composite systems → areas-backed virtual systems → v3 composition). It worked, but carried: the
polymorphic integer handle (`areas.legacy_system_id` as the universal address, ≥1,000,000 = synthetic
area) — a standing type-confusion bug factory; duplicated placement (tz/location on both `systems` and
`areas`); two sharing systems; free-text spec columns; a SQL projection of a code registry; a hidden
binding mode-switch; and two unrelated "derive a signal" mechanisms (run-tracking vs HWS).

Config v4 is the agreed clean sheet: one TypeID public ID space with the integer handle retired,
`systems`→`devices`, eager areas owning tz/location, unified sharing (dashboards only), trackers + HWS
generalized to `derivations`, and a recursive dashboard node tree (card/tile unified). Hot time-series
tables stay compact via an internal integer `rid` behind a single data-access seam.

### What actually shipped (Phases 0–9)

Nine phases landed over five days, all merged to `main`. Phases 0–7 shipped **dark** behind the unchanged
v3 app; Phase 8 was the one irreversible window.

| Phase                                  | State   | What landed                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Governance                         | ✅ DONE | Prefixes locked `dv/pt/ar/db/dx/bn`; `retire-implied-areas.ts` annotated abandoned (Option A).                                                                                                                                                                                                                                                                                          |
| 1 — `lib/ids/` TypeID codec            | ✅ DONE | Client-safe codec, six branded codecs so cross-entity misuse is a compile error. 33 tests incl. TypeID-spec vectors.                                                                                                                                                                                                                                                                    |
| 2 — Point identity hardening           | ✅ DONE | #212/#213, migration **0030**: `point_uid` NOT NULL, global `point_rid_seq` + `point_info.rid` backfilled deterministically. Applied to prod + dev.                                                                                                                                                                                                                                     |
| 3 — Readings DAO seam + registry cache | ✅ DONE | The highest-leverage strangler, no migration. 31 modules moved behind `ReadingsDao` over PRs A–L (#214→#232); `app_lib` and `scripts` both reached **0** and the baseline file is gone.                                                                                                                                                                                                 |
| 4 — Additive v4 config schema          | ✅ DONE | Migrations **0032** (dark columns + `area_bindings.role` CHECK) + **0033** (`derivations`, `derived_intervals`, `dashboard_revisions`, `legacy_handles`).                                                                                                                                                                                                                               |
| 5 — v4 dashboard doc model             | ✅ DONE | v4 node-tree types + zod validator + `normalizeDocV4`/`collectRefs`, v3→v4 rewriter, `resolve-shell`, adapter renderer, dual-shape SSR window. 34 tests. Adapter chosen over v4-native.                                                                                                                                                                                                 |
| 6 — `/api/v4/*` surface                | ✅ DONE | #233 + #234, migration **0034**: dashboards CRUD (`If-Match`/412) + read-only TypeID-native areas surface. Cutover-era mutation routes deferred (need entities the cutover mints).                                                                                                                                                                                                      |
| 7 — Cutover rehearsal harness          | ✅ DONE | #237. Transform + parity/window harness validated on PS-5 branches restored from prod. `T_window` ≈ 5 min → single-window GO. Caught real bugs (PS-5 OOM at prod's `maintenance_work_mem`, DDL simple-protocol, idempotency).                                                                                                                                                           |
| 8 — **THE CUTOVER**                    | ✅ DONE | #242/#243/#248, migration **0035**. Planning ran as a 14-agent workflow that found 7 defects in a "23/23 green" transform. `liveone-dev` cut over first as a dress rehearsal (Run 8), prod the same day (Run 9): transform 263s, parity 60/61, authz 13/13, window 13.2 ≤ 30 min, smoke 6/6. Pollers never stopped — only materialization paused; the outbox backlog drained in ~2 min. |
| 9 — Post-cutover fixes                 | ✅ DONE | #250. PR 1: prod→dev sync FK break (post-cutover `dashboards.id` is minted per-environment; only `legacy_id` is stable cross-env) fixed via `legacy_id`-keyed `idDrift`, plus three masked stale-rename bugs. PR 2: full `ar_` TypeID uniformity across all ~11 `/api/areas/*` routes incl. a persisted-descriptor data migration.                                                      |

Detail lives in the phase docs, which are the historical record and should not be re-litigated here:
[config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md) (rehearsal + Run 8/9 logs)
and [config-v4-phase8-cutover.md](config-v4-phase8-cutover.md) (defect table, locked decisions, ordered
cutover steps, Group A/B/C split).

### What is actually live in prod today — and what is still v3

**This is the part the old plan understated.** Phase 8 cut over the _hot path_ and the _presentation and
sharing layer_. It did **not** cut over the config registry, the integer handle, or the dashboard write
model. Those are still v3, with v4 running alongside as a dark mirror.

**Cut over and live on the v4 shape:**

- **Hot tables** — `point_readings` / `agg_5m` / `agg_1d` are `(point_rid, time)`-keyed, FK → `points.rid`.
  The `(system_id, point_id)` composite address and the `point_readings.id` surrogate are gone.
- **The readings seam** — uuids above, rids below, enforced by `scripts/check-readings-boundary.mjs`
  (permanent). Nothing outside `lib/readings/**` may import a hot table.
- **Dashboards** — uuid PK with the old int frozen in `legacy_id`; `owner_user_id`/`name`/`slug` renamed.
- **Sharing** — one unified `share_tokens` keyed by `dashboard_id` NOT NULL; the owner-scoped token path is
  retired. `dashboard_grants` reshaped (owner→admin, role CHECK, `user_id`, timestamptz, composite PK).
- **Areas** — post-cutover column names, and `ar_` TypeID at every wire boundary (Phase 9 PR 2).

**Still v3 — the actual remaining work:**

| Legacy thing still live                          | Evidence                                                                                                                                                                                                                                                    | Retired in  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **The config registry is still v3-primary**      | `systems` 28 query sites / 23 files, `point_info` 40/20, `polling_status` 11/11, `area_devices` 11/5. The v4 twins are a dark mirror: `area_members` 1 site, `device_state` **0**, `derivations` **0**.                                                     | Phase 12    |
| **The dark mirror is load-bearing**              | `lib/registry/v4-mirror.ts` writes `points`/`devices`/`area_members` at every mint from `point-manager` + `systems-manager`. Deleting it re-opens defect C7 (a new point gets no `points` row → the hot FK rejects its first reading → QStash poison pill). | Phase 12    |
| **The integer handle — "the headline deletion"** | `areas.legacy_system_id`: 186 occurrences, incl. inside `/api/v4/*` routes. `AREA_HANDLE_BASE = 1_000_000` still allocates.                                                                                                                                 | Phase 13    |
| **Virtual-system synthesis**                     | `synthesizeAreaView` (~50 lines), `getViewableSystem` (6 callers), `isAreaHandle` (2 callers) — all live in `lib/systems-manager.ts`.                                                                                                                       | Phase 13    |
| **`SystemsManager`**                             | 464 lines, **72 importers, 75 `getInstance()` call sites** — the single largest blast radius in the codebase.                                                                                                                                               | Phase 12    |
| **KV is still integer-keyed**                    | `latest:system:N` / `subscriptions:system:N` is the ONLY keyspace; **zero** occurrences of `latest:device:`/`latest:area:`. The subscription SCAN regex requires `(\d+)`.                                                                                   | Phase 13    |
| **`/api/data` is still handle-addressed**        | `?systemId=<int>`, `parseInt`, payload `{system, latest}`. `deviceId` appears nowhere in the repo. ~296 of 639 app files mention a config-sense `system`.                                                                                                   | Phase 13    |
| **Dashboards are dual-shape, v3-write**          | `descriptor` **and** `doc` both NOT NULL and both written. `/api/dashboards/[id]` PATCH — the only editor — accepts **only** v3. Header/nav/`AddAreaDialog` all read `descriptor`.                                                                          | Phase 14    |
| **Zero v4-native renderers**                     | 19 plugins across two split registries (`CARD_RENDERERS` 10 + `TILE_RENDERERS` 9), 100% v3-shaped, reached through `v4-adapt.ts`. `card-types.ts`' 18 unified types have no renderer map.                                                                   | Phase 14    |
| **All v4 mutation routes missing**               | 10 endpoints unbuilt (`/devices`, `/devices/{id}/points`, `/areas/{id}/members\|bindings\|derivations` PUT, `/dashboards/{id}/shares\|grants\|revisions`, `/export`, `/import`); 28 legacy handlers across 15 routes still serve.                           | Phase 14    |
| **Derivations unused; two derive mechanisms**    | `derivations`/`derived_intervals` have 0 consumers. Run-tracking is still 9 bespoke modules on `device_trackers`/`device_run_periods`; HWS is still bespoke.                                                                                                | Phase 11    |
| **`user_systems` / `isViewer`**                  | 7 query sites; `isViewer` confined to `lib/api-auth.ts` (5 refs) and folded into `canRead`.                                                                                                                                                                 | Phase 12    |
| **`roles` table**                                | 1 query site (a seed script) but still the FK target for `area_bindings.role` (CHECK already covers it) + both tracker tables.                                                                                                                              | Phase 11/12 |
| **Dead weight in `schema.ts`**                   | `dashboard_share_tokens` — **0 query sites, schema-only**. Plus 5 dead `share_tokens.*_ms`/`owner_clerk_user_id` columns and `dashboard_grants.created_at_ms`.                                                                                              | Phase 10    |
| **Three `_old` hot tables in the DB**            | Created by the transform's rename-swap, never dropped. Not declared in `schema.ts`; only the scaffolding references them.                                                                                                                                   | Phase 10    |
| **~160 KB of cutover scaffolding**               | 13 files in `scripts/config-v4/`, and `tsc -p scripts/config-v4/tsconfig.json` runs on **every** `prebuild`.                                                                                                                                                | Phase 10    |
| **Cutover pause still armed on ingest**          | `cutoverPausedForIngest()` does a fail-closed KV read per ~10s on the receiver hot path. Its only remaining failure mode is halting all ingest during an Upstash blip, for a window that is over.                                                           | Phase 10    |

## The finish line

**Definition of done — all three, or the migration is not finished:**

1. **No legacy config code.** Every item in clean-sheet §4.8 "What dies" is actually gone: the tables, the
   handle, `point_info.index` + its allocator, tz/location on devices, `area_bindings.ordinal` + the int
   point pair, the synthesis, the `≥1,000,000` allocator, the KV integer keyspaces, the
   `"systemId.pointIndex"` ref grammar, `deviceSystemId` in descriptors.
2. **No migration scaffolding.** `scripts/config-v4/` is deleted, its `prebuild` wiring removed, the
   cutover pause machinery gone, the dark mirror gone, and the one-shot backfills deleted.
3. **One shape, not two.** No runtime branch on `isDashboardV3`/`isDashboardV4`, no adapter, no rewriter,
   one card registry, one write surface.

**Keep permanently — these are the sanctioned thin shims, not debt:** `legacy_handles` (resolves
`?systemId=N` forever), `dashboards.legacy_id` (backs the `/dashboard/id/{n}` 301), the `?systemId=N`
compat alias, slug URLs, share-token strings, `lib/ids/`, `lib/registry/{registry-cache,device-registry}.ts`,
and `scripts/check-readings-boundary.mjs` + `check:readings` (the permanent seam wall).

**Sequencing logic.** Phase 10 is independent and pays for itself immediately. Phase 11 comes before the
registry drop because `device_trackers`/`device_run_periods` hold two of the three composite FKs into
`point_info` and two of the three FKs into `roles` — retiring them first unblocks Phase 12's drops.
Phase 12 must precede Phase 13 (the handle can't die while `SystemsManager` is the config API) and
Phase 14 (the v4 mutation routes need `devices`/`points` as primary). Phase 14 is last and largest.

---

### Phase 10 — Scaffolding demolition, dead-weight removal, snapshot reconciliation

**Goal:** delete everything the cutover needed and nothing needs now; make `db:pg:generate` trustworthy
again. Independent of every other phase — do it first, it is small and removes ongoing risk and build cost.

**✅ Code half DONE (2026-07-27).** Verified: `tsc --noEmit` clean, 127 suites / 1237 tests pass,
`npm run build:local` green. No schema or prod change yet.

- Deleted the 8 spent cutover one-shots (`config-transform`, `cutover.sql`, `parity-check`, `authz-check`,
  `window-report`, `cutover-pause`, `backfill-foundation`, `retire-empty-composites`) and 4 spent
  backfills (`backfill-point-uid`, `retire-implied-areas`, `p2-backfill-membership`,
  `p6-legacy-dashboards`) — **3,354 lines**. Dropped the `db:backfill-config-v4` npm script.
- **Disarmed the cutover pause**: `lib/cron/guard.ts` 176 → 48 lines (`CUTOVER_PAUSED_KEY`,
  `cutoverPaused`, `cutoverPausedForIngest`, the ingest-gate TTL cache + test seam, `cutoverSkipReason`),
  the 6 cron call sites, and the receiver's fail-closed KV read. `cronsEnabled`/`cronSkipReason` kept.
- Replaced `lib/cron/__tests__/guard.test.ts`: it tested **only** the cutover gate, so the permanent
  kill-switch had **zero** coverage. Now it covers `cronsEnabled` (incl. that unset/`"1"`/`"TRUE"` all
  mean OFF) and `cronSkipReason`'s override matrix.
- Corrected a wrong comment in `lib/areas/devices.ts` that credited `retire-implied-areas.ts` with having
  retired the implied areas — that script was abandoned and never ran (Option A keeps them).
- **Correction to the plan:** the `prebuild` wiring **cannot** be removed yet. `scripts/config-v4/guard.ts`
  (the config-v4 target guard `assertRehearsalTarget` — NOT `lib/cron/guard.ts`, which is unrelated and
  has no importers here) is imported by the survivors (`registry-sync`, `rewrite-descriptor-area-refs`),
  so `scripts/config-v4/` and its `tsc --noEmit -p …/tsconfig.json` prebuild step live until **Phase 12**.

**Remaining — the schema half. Stress-tested 2026-07-27, then re-litigated with Simon: NO SQUASH.
History 0000–0035 stays intact; the fix is a catch-up entry 0036. The sequence below is ORDERED and the
order is load-bearing.**

Why this works (all verified empirically, 2026-07-27): `db:pg:generate` reads **only the latest
snapshot** as its diff base — the migration chain is never consulted — and a snapshot records the
**end state**, not the path to it. So the recovery is to give the chain a correct latest snapshot:
generate one from an _empty_ journal in scratch (zero prompts, drizzle's own serialization — the same
bytes generate would have produced had the cutover been a migration), transplant it as
`meta/0036_snapshot.json` with `prevId` patched to 0035's id, and pair it with a `0036_*.sql` whose
only real statements are safe metadata renames. Proven in scratch against the full 36-entry history:
generate then reports **"No schema changes"** with no prompts, and a subsequent
`generate --custom` numbers itself 0037 correctly. Because 0036's SQL is guard-wrapped and no-op-safe,
`db:pg:migrate` applies and records it through the **normal workflow on dev and prod — no hand-edits
to `drizzle.__drizzle_migrations` at all** (unlike the rejected squash). Migrator mechanics verified
from `drizzle-orm` source: entries apply when `when` exceeds the DB's max `created_at`; hash is stored
but never compared; all pending run in one transaction, so failures roll back loudly and harmlessly.

Rejected alternatives, for the record: **squash** (works mechanically, proven in scratch, but rewrites
36 migrations of provenance and needs hand-inserted journal rows on both envs — Simon vetoed,
2026-07-27); **baseline from `drizzle-kit pull`** (150+ statements of vocabulary churn incl. FK
recreations on the 15M/21M-row hot tables and a live `DROP COLUMN`); **letting generate produce 0036
interactively** (~a dozen error-prone rename prompts to yield the same snapshot, plus emitted SQL —
e.g. `ALTER … TYPE uuid` without `USING` — that must be discarded anyway).

Known, accepted cost: replaying 0000→0036 onto an EMPTY database yields the pre-cutover schema (0036
doesn't re-do the cutover). That fidelity is already gone in reality — the cutover was out-of-band and
pre-cutover backups can't be rolled forward — and this project bootstraps environments from R2 dumps,
never from migration replay. `0036_*.sql`'s header documents this and points at
`config-transform.ts`'s git history.

1. **✅ DONE — prod probed 2026-07-27** (short-TTL `pg_read_all_data` role, revoked after). Result:
   **prod and dev are structurally IDENTICAL** — 34 tables each, zero column, type, notNull or index
   differences. So a 0036 validated on `liveone-dev` will apply cleanly to prod; the feared
   hand-applied-DDL divergence (the CONCURRENTLY index era) did not materialise.
   - **`drizzle-kit pull` under-records CHECK constraints** — the prod snapshot recorded 0, the dev
     snapshot 5, but direct `pg_constraint` queries prove all 5 exist on BOTH. A pull artifact, not
     drift. Harmless for the 0036 snapshot (generate-from-empty reads `schema.ts`, not the DB) but the
     step-5 audit must treat CHECK lines as expected churn.
   - Confirmed per-environment: `backfill_progress` 29 rows on prod (as dev); `area_bindings.point_uid`
     **72/72 populated on prod** (as dev); `_old` tables 15.60M / 6.07M / 19.6K rows = **4.14 GB**.
     Row-count guard already satisfied: live `point_readings` 15,634,764 ≥ `point_readings_old`
     15,602,747.
   - **Prod descriptors are NOT migrated: 16/16 sections still raw uuid, 0 in `ar_` form.** So the
     Phase-9 PR 2 data migration definitively never ran on prod. **✅ RUN AND VERIFIED on prod
     2026-07-27** — see the Phase-10-complete summary at the top: 16/16 sections rewritten to `ar_`,
     0 unrecognized, verified by the script's post-write check, an independent `jsonb` query, and live
     end-to-end. (Never a live break: `rowToDashboard`'s read-normalize + dual-accept `areaRefToUuid`
     handled both forms throughout; it was blocking the Phase-14 strict-decode tightening.)
2. **✅ DONE — fixed `schema.ts` BEFORE cutting the 0036 snapshot.** Cutting it first bakes drift in
   silently (verified: a snapshot from the old `schema.ts` contains zero occurrences of
   `area_bindings.point_uid`, so the column becomes permanently invisible to drizzle instead of
   dropped). Declared `area_bindings.point_uid` (nullable uuid; FK → `points.id`, plain NO ACTION —
   read from `pg_constraint`, so a `points` delete is _blocked_, not cascaded as Phase 9 PR 1 feared;
   fully populated 72/72 on dev and prod).

   > ⚠️ **CORRECTION — do NOT rename the `pr*_new_*` INDEX names here (the old step 2/3 said to).**
   > `schema.ts` already _declares_ the `_new` names and a `pg_indexes` probe confirms the live DB
   > matches, so snapshot == schema == DB already; the rename is unnecessary for correctness. It is also
   > **unsafe before 0038**: index and PK-constraint names are schema-GLOBALLY unique in Postgres, and
   > the retained `_old` tables still own `point_readings_pkey` / `pr_measurement_time_idx` /
   > `pr_created_at_idx` / `pr5m_*` / `pr1d_day_idx`, so an early rename is a **42P07**. This is exactly
   > the hazard `config-transform.ts`'s D-g note called out. The cosmetic rename to canonical moves to
   > **0039, after the `_old` drop** (Simon, 2026-07-27). FOREIGN KEY names are per-TABLE, not
   > schema-global, so those renames are safe in 0036 — verified empirically, including
   > `point_readings_session_id_sessions_id_fk`, which `point_readings_old` also holds.

   > ⚠️ **Two MORE live-but-undeclared FKs, found by the step-5 audit** (same class of defect as
   > `point_uid`, both with `schema.ts` comments still claiming "DEFERRED to cutover"):
   > `derivations.output_point_id` → `points(id)` and `legacy_handles.device_id` → `devices(id)`. Both
   > were wired by config-transform stage 5. Undeclared, `generate` wanted to **DROP** them. Now
   > declared. NB this also means Phase 11's "add the FK `derivations.output_point_id` → `points`" item
   > is **already done** — do not re-do it.

3. **✅ DONE — `0036_config_v4_cutover_reconcile.sql`, hand-written.** The renames ARE the migration,
   journalled and applied by plain `db:pg:migrate` (no out-of-band DDL pass): 11
   `ALTER TABLE … RENAME CONSTRAINT` statements — the 4 hot-table FKs (`pr_new_point_fk`,
   `pr_new_session_fk`, `pr5m_new_point_fk`, `pr1d_new_point_fk` → drizzle defaults), the 5
   config-table FKs whose transform-given names (`…_dashboards_fk`) differ from drizzle defaults
   (`…_dashboards_id_fk`, plus `area_bindings_point_uid_points_fk`), and the 2 newly-declared FKs above.
   **No index or PK renames** (see the correction in step 2). All metadata-only and instant; each is
   wrapped in a `DO`/`IF EXISTS` guard so the file is idempotent and no-op-safe on any DB shape.
   **The guards scope by `conrelid`, not `conname` alone** — `conname` is unique per TABLE, not per
   schema, so a bare name match sees `point_readings_old`'s copy of
   `point_readings_session_id_sessions_id_fk` and wrongly skips the rename.
   **Why renames can't be a generated migration:** drizzle-kit cannot express a rename — it emits
   DROP INDEX + CREATE INDEX, a multi-minute rebuild on the 15M-row table.
4. **✅ DONE on dev — transplanted the snapshot.** Scratch generate-from-empty against the fixed
   `schema.ts` → snapshot taken verbatim, `prevId` := 0035's id, saved as `meta/0036_snapshot.json`;
   journal entry appended. `db:pg:generate` then reports **"No schema changes"** with no prompts.
   Applied to dev with plain `db:pg:migrate` and verified against `pg_constraint` (not migrate's
   output — the journal-drift lesson): all 11 renames present, zero old names left on live tables.
   - **Migrator mechanic confirmed empirically:** drizzle stores `created_at` = the journal's `when`
     value, NOT the wall-clock apply time (dev's max was exactly 0035's `when`, 1784954146501). So a
     `when` merely greater than the previous entry's is sufficient and safe.
   - Numbering discipline applied (fetched main; 0036 was free).
   - **✅ Applied to prod `sydney` 2026-07-27** via a short-TTL `pscale role` (reassigned to `postgres`
     - deleted afterwards). Pre-flight probe confirmed prod was at exactly 36 journal rows with all 11
       old FK names and zero new ones; post-apply `pg_constraint` shows all 11 renamed, zero old names
       left on live tables, 37 journal rows. 0036 is metadata-only (renames), so no base backup was
       required — nothing is dropped or rewritten and every statement is reversible.
5. **✅ DONE on dev — audit-verified the snapshot against the live DB.** "generate → No schema changes"
   only proves snapshot == `schema.ts`, NOT snapshot == database. With no docker locally, the
   DB-equivalence proof is the churn-diff audit: `drizzle-kit pull` the live DB, use it as `prev`, and
   generate — then require every statement to classify as (a) pull-vocabulary churn with an identical
   definition, (b) a step-2/3 fix, or (c) the known step-6 drops. **Result on dev: 132 statements, zero
   unexplained.** 53 index DROP+CREATE round-trips (identical definitions, none dropped-without-recreate)
   - 5 CHECK drop/add pairs + `dashboard_grants_pk` drop/add + 8 statements for the known 0038 drops.
     Accepted cosmetic residue, do NOT chase — it recurs in this audit forever and is invisible to the
     gate: `dashboards_legacy_id_unique` and `points_rid_unique` (uniques that exist as CONSTRAINTs, or
     that pull simply omits, where `schema.ts` says `uniqueIndex`); `point_info.rid`'s
     `nextval('point_rid_seq')` vs pull's `::regclass`-qualified rendering; and
     `point_readings_flow_attr_1d`'s PK, whose DB name is truncated at Postgres' 63-char identifier limit
     (`…_load_path_p` vs `…_load_path_pk`).
   * **✅ Re-run against prod 2026-07-27 after 0036 landed: 132 statements, zero unexplained — the audit
     is shape-identical to dev's** (same 53 round-trips, same 2 created-not-dropped, same 24 non-index
     statements). This independently re-confirms step 1's "prod and dev are structurally identical".
     Note prod's pull DID record all 5 CHECKs this time (as drop/add pairs, exactly like dev), so the
     earlier "prod pull records 0 CHECKs" artifact did not recur.
     > 🛑 **ORDERING RULE — learned the hard way, 2026-07-27. For a DROP, the code deploys FIRST.**
     > CLAUDE.md's "apply migrations to prod BEFORE the dependent code merges" is the rule for **ADDITIVE**
     > changes (new code needs the new column). **Drops are the exact opposite** and the rule inverts:
     > deploy the code that stops referencing the column, THEN drop it. Applying 0037 to prod while prod
     > still ran the old build **took share-token access down**: `validateDashboardShareToken` and
     > `listDashboardShareTokens` both issue a projection-less `.select().from(shareTokens)`, which drizzle
     > expands to the column list **declared in the running build** — including the five just-dropped
     > columns — so every share-link request 500'd with `42703 column "owner_clerk_user_id" does not exist`.
     > Recovery was to re-add the five columns + `share_tokens_owner_idx` + `dashboard_grants.created_at_ms`
     > (all nullable, backfilled from the authoritative `timestamp` columns) — verified by re-running the old
     > build's exact query, and end-to-end: a valid `?access=` token renders the dashboard while a bogus one
     > is denied. **Total exposure: a few minutes.**
     > **A projection-less `.select()` turns ANY column drop into a breaking change** for the running build —
     > which is precisely why 0037 also replaced the two bare `.select()`s with explicit projections. Those
     > projections must be **deployed** before the drop re-lands.

✅ **0037 is now COMPLETE on prod (2026-07-27).** After #252 merged and Vercel deployed the explicit
projections, the 7 rolled-back objects were re-dropped by hand — the journal already claimed 0037, so
completing it manually made the journal true, with no new migration and no journal edit. The drop was
run **self-healing**: baseline the live `?access=` share path → drop → re-exercise the path → auto-restore
on failure. The path stayed healthy (65 KB, content present), which is also the proof that the deployed
build carries the projections — the old build would have 500'd instantly. Prod's step-5 audit is clean
again: **128 statements, zero unexplained**, matching dev.

6. **Then prove the restored workflow with three normal journalled migrations:**
   - **✅ 0037 DONE on dev (`0037_kind_famine.sql`, generated + applied 2026-07-27; PROD PARTIAL — see
     the ordering rule above).**
     Generated exactly the intended 9 statements and nothing else; gate, type-check, 127 suites / 1237
     tests and `check:readings` all green afterwards.
     - **Pre-flight found the "1:1 fold" claim is not quite true.** `dashboard_share_tokens` held **1
       row that was never folded** into `share_tokens`: `spare-comic-osprey`, label `v4-e2e-verify`,
       created 2026-07-24 11:24 UTC and last used 11:27 — i.e. e2e-test debris written straight into
       the legacy table, on a dashboard (`legacy_id=6`, "Daylesford") that already has a live unified
       token. It was **already non-functional** (the table has zero query sites, and
       `validateDashboardShareToken` reads `share_tokens`), so dropping the table changed no behaviour.
       ⚠️ **Re-run this same check on prod before applying 0037 there** — if prod holds an unfolded row
       that is NOT test debris, a real share link broke at cutover and needs re-issuing, not dropping.
     - **No information loss from the `*_ms` drops:** verified on the one row that had them
       (`keen-fruity-tapir`) — `created_at` matched the ms value exactly and `last_used_at` carried
       _more_ precision (`.62`) than the ms-derived value.
     - **Verified end-to-end against the running app**, not just tests: `GET /api/dashboards/{id}/share`
       with a real Clerk session now returns populated `createdAtMs` / `lastUsedAtMs`, and — the sharp
       one — a genuinely revoked token now reports `revokedAtMs`, so `ShareLinksPanel`'s
       `filter(t => t.revokedAtMs == null)` correctly excludes it. **Before this change a REVOKED share
       link was listed as ACTIVE** (display only; `validateDashboardShareToken` always honoured
       `revoked_at`, so access was never actually granted).
   - **0037, generated:** drop `dashboard_share_tokens` (0 query sites),
     `share_tokens.owner_clerk_user_id` + its four `*_ms` columns (`created_at_ms`, `expires_at_ms`,
     `revoked_at_ms`, **`last_used_at_ms`** — there is no `last_accessed_at_ms`) +
     `share_tokens_owner_idx`, and `dashboard_grants.created_at_ms` — small tables, safe on autopilot.
     There are **no stale `$inferSelect` exports to remove** (`dashboard_share_tokens` never had any).
     **Two code couplings must land in the same PR** (verified, and missed by the original plan):
     (i) `scripts/utils/reown-dev-data.ts:48` lists `share_tokens`/`owner_clerk_user_id` in `OWNERSHIP`
     and its try/catch sets `hadError = true` if the column vanishes; (ii) the four `_ms` columns reach
     the UI through a projection-less `.select().from(shareTokens)` in `lib/dashboard/sharing.ts`
     → `app/api/dashboards/[id]/share/route.ts` → `DashboardSettingsDialog.tsx` →
     `ShareLinksPanel.tsx`. Project the `timestamp` columns and map to ms — which also fixes a latent
     bug: `createDashboardShareToken` only ever writes the timestamp columns, so those bigints are
     already always NULL and the panel renders blanks today;
   - **✅ 0038 DONE on dev AND prod (`0038_drop_old_hot_tables_and_backfill_progress.sql`,
     2026-07-27).** Freed **4,216 MB** on dev; live tables verified intact at exactly their pre-drop
     counts (15,355,536 / 5,533,074 / 19,400). Prod re-verified 2026-07-28 on the OBJECTS (not the
     journal): zero `%_old` tables, no `backfill_progress`.
     - **The guard invariant is `>=`, NOT `>` — the plan's "live max beyond old's" wording is wrong.**
       On `liveone-dev` crons are disabled, so nothing has been written to the live tables since the
       cutover copy: live == `_old` exactly, same row counts AND same `max(measurement_time)`. A `>`
       guard aborts on a perfectly healthy dev database. The real invariant is containment.
     - **The guards were negative-tested before use**, not just written: running a deliberately
       inverted invariant inside a transaction raised the exception and rolled the `DROP` back, with
       `point_readings_old` still present afterwards. A guard that never fires is worse than none.
   - **0038, hand-written** (`drizzle-kit generate --custom`): drop `backfill_progress` (orphan from
     the June-2026 Turso decommission: 29 rows, never in a migration, zero repo references) and the
     three `_old` hot tables — **4.2 GB on dev** (`point_readings_old` 2823 MB / 15.35M rows,
     `agg_5m_old` 1388 MB / 5.51M, `agg_1d_old` 5.5 MB / 19.4K) — with `DO`/`RAISE EXCEPTION` guards
     (live row count ≥ old row count per table; live `max(measurement_time)` beyond old's) instead of
     drizzle's unguarded `DROP TABLE … CASCADE`. Precondition: Simon confirms the validation window
     has passed; R2 dumps taken before the drop contain the `_old` data (retention: daily 21d /
     weekly 91d / monthly 365d) and a one-off `pscale backup create` lands first per the checklist.
   - **✅ 0039 DONE on dev AND prod (`0039_rename_hot_indexes_to_canonical.sql`, 2026-07-27).**
     Prod re-verified 2026-07-28 on the OBJECTS: all nine canonical names present in `pg_indexes`,
     zero `_new` names, hot tables intact (15.67M / 5.42M / 19.7K). All
     nine names verified free first (the `_old` drop released them), then renamed and verified against
     `pg_indexes`: `point_readings_pkey`, `pr_measurement_time_idx`, `pr_created_at_idx`, `pr5m_pkey`,
     `pr5m_interval_end_idx`, `pr5m_created_at_idx`, `pr5m_updated_at_idx`, `pr1d_pkey`,
     `pr1d_day_idx`. **Zero `_new` names remain anywhere in the database.** Snapshot transplanted (as 0036) since renames cannot be generated. `check-readings-boundary.mjs`'s `(_old|_new|_v\d+)?`
     group removed with its three fixtures — the comment records how to restore it if a future
     migration ever reintroduces a twin.
   - **0039, hand-written** (`generate --custom`) — **only now are the canonical names free.** Rename
     the nine `_new` index/PK names (`point_readings_new_pkey`, `pr_new_*`, `pr5m_new_*`, `pr1d_new_*`)
     to canonical, with the matching `schema.ts` edit and another snapshot transplant. Guarded, and
     metadata-only — but note drizzle CANNOT generate a rename (it emits DROP + CREATE INDEX, a
     multi-minute rebuild on the 15M-row table), which is why it is hand-written. Optionally also give
     `point_readings_flow_attr_1d`'s PK an explicit ≤63-char name to retire that audit-churn line.
     Simplify `check-readings-boundary.mjs:45`'s `(_old|_new|_v\d+)?` group here and prune the fixtures
     at `scripts/__tests__/check-readings-boundary.test.ts:73-78,134-138`.

**Done when:** `db:pg:generate` reports "No schema changes" with no prompts, on a snapshot that
audit-matches BOTH dev and prod; the full 0000–0036 history is intact and 0036 was applied by plain
`db:pg:migrate` on both envs; `_old` + `backfill_progress` absent; `area_bindings.point_uid`,
`derivations.output_point_id` and `legacy_handles.device_id` all declared; 0037/0038/0039 applied via
plain `db:pg:migrate`; the hot-table index names are canonical; `check:readings` green.

**Risks:** materially lower than the squash it replaces — no journal-table hand-edits, no history
rewrite, failures loud and rolled-back. The residual risk is a wrong rename (guarded, verified against
`pg_constraint`/`pg_indexes` on dev before prod) and the step-6 drops (guarded, backed up).

---

### Phase 11 — Derivations: one mechanism for derived signals

**Goal:** collapse run-tracking and HWS onto `derivations`/`derived_intervals`, and drop
`device_trackers`/`device_run_periods`. Small, self-contained, and it unblocks Phase 12's FK drops.

**✅ PR 1 (the re-key + fill tooling) BUILT.** `tsc` clean (app + `scripts/config-v4`), 129 suites /
1257 tests pass, `check:readings` green, `build:local` compiles. Not yet applied to any database.

Corrections to the original sketch, found while building it:

- 🛑 **THE DATA MIGRATION WAS ALREADY DONE — by the cutover transform.** `derivations` and
  `derived_intervals` are **not** empty: config-transform stage 5 already wrote them (dev: 2
  derivations, 76 intervals, byte-identical to `device_run_periods`). The plan's "fill, not a
  reshape" premise was wrong — it is a **reconcile**. Better still, the transform's `params` and
  `source_points` are byte-identical to what this phase's mapper independently produces, which
  cross-validates both.
  **But the transform minted RANDOM v4 ids, independently per environment.** That silently breaks the
  by-PK prod→dev sync this phase adds (two ids for one logical row → duplicate → a
  `derivations_area_role_unique` violation). So `fill-derivations.ts` **normalizes**: any row for the
  same (area, kind, role) under a non-deterministic id is deleted and re-inserted under the
  deterministic uuidv5 id, rebuilding its intervals from `device_run_periods`. **This is why the fill
  must run BEFORE the legacy tables are dropped** — they are the rebuild source.
- **The FK `derivations.output_point_id` → `points` is ALREADY LIVE** — Phase 10's migration 0036
  declared it (it had been wired by config-transform stage 5 but left undeclared). Do not re-add.
- **Run periods do NOT feed `battery-provenance/fold`.** The only reference is a comment noting the
  shared recompute _pattern_; there is no data dependency. The real coupling is the best-effort daily
  heal pass at `lib/aggregation/daily-points.ts:224`. The multi-week recompute-and-compare gate stands
  regardless — a silent re-key error is still the risk that matters.
- `scripts/backfill-run-periods.ts` was an unlisted `listEnabledTrackers` consumer.

**What landed in PR 1**

- **`lib/derivations/`** — the new discovery layer. `resolve.ts` (typed jsonb contracts + the resolved
  shapes + `listEnabledRunDetectors`/`listEnabledHwsModels`/`hasEnabledRunDetector`), `params.ts` (the
  sparse-params → role-defaults merge, pure), `ids.ts` (deterministic `uuidv5(area:kind:role)` ids),
  `fill-map.ts` (pure legacy→v4 row mappers). `lib/run-tracking/resolve.ts` deleted.
- **`resolveAreaIdForHandle`** is the ONE handle→area mapping, used by the fill _and_ every reader, so
  a derivation can't land on an area the readers don't resolve to.
- **`run-periods-pg.ts` → `derived-intervals-pg.ts`**, re-keyed `(system_id, role, start_time)` →
  `(derivation_id, start_time)`; advisory lock now `hashtext(derivation_id)`; source points arrive
  pre-resolved as `PointId`, so the `RegistryCache.pointForAddr` hop is gone.
- **One cron**: `/api/cron/run-periods` → `/api/cron/derivations`, dispatching run-detectors then HWS;
  the minutely-cron HWS hard-wire removed (`vercel.json` updated). Accepted: HWS may trail
  materialization by ≤1 tick, healed next pass.
- **Migration 0040** — `derived_intervals.derivation_id` gains `ON DELETE CASCADE` (guarded,
  idempotent). Intervals are disposable derived output, so they follow their derivation; this is also
  what makes the sync's area idDrift cleanup safe. `db:pg:generate` then reports "No schema changes".
- **prod→dev sync**: `device_trackers` → `derivations` as a plain **by-PK** upsert (deterministic ids
  mean dev and prod mint the same id — no `excludeCols`/natural-key dance); the point_info idDrift
  signal-point children are gone (jsonb refs carry no FK).
- **`scripts/seed-generator-tracker.ts` deleted** (its job is done; the Daylesford tracker is already
  re-pointed to the DSE). `roles` is now writer-less — Phase 12 drops it.
- New tooling: `scripts/config-v4/fill-derivations.ts` (dry-run default, idempotent, refuses to run
  once the new build is live) and `verify-derivations.ts` (the byte-identical gate).

**✅ Dev rehearsal PASSED (2026-07-28)** — 0040 applied to `liveone-dev` (verified via `pg_constraint`:
`confdeltype='c'`, 41 journal rows), fill applied (2 rows re-keyed to deterministic ids, 76 intervals
rebuilt), and every gate green:

- `verify-derivations.ts`: **76 compared, 0 differences**.
- **Old writer vs new writer**: `db:recompute-dev-runs 30` rewrote 8 periods through the new
  `derived-intervals-pg.ts`; re-verify still **0 differences**. This is the phase gate.
- **HWS**: discovery via `derivations` returns the identical pair the old `point_info` scan did
  (system 6, temp index 19, same unit/name/options, same power point uuid — the only active
  `load.hws/power` row). Fixed-window recompute twice → **0 value diffs** (deterministic). ⚠️ A
  _sliding_ `Date.now()` window does legitimately shift values (warmup lead-in moves + newly-synced
  power); don't mistake that for a regression — pin the window when A/B testing.
- **End-to-end on the running app**: `/api/system/1/run-periods` returns 76 events, energy checksum
  167.296 and all 76 start times **identical to `device_run_periods`**; `/api/cron/derivations`
  dispatches both kinds in one pass (`trackersProcessed:1, runningPublished:1, hwsPairs:1`); the old
  `/api/cron/run-periods` path 404s; `hasEnabledRunDetector` → true for handle 1, false for 6;
  `/api/data` serves `source.generator/running` (1.17) and `load.hws/temperature` (6.19).

**✅ PROD PREPARED (2026-07-28), ahead of the PR merge.** Short-TTL `pscale role`s, reassigned +
deleted afterwards; read-only role for the probe/backup, write role only for the two writes.

- **0040 applied to `sydney`** — verified via `pg_constraint` (`confdeltype='c'`), 41 journal rows,
  matching dev. Metadata-only, so no base backup required.
- **Fill applied** — 2 rows re-keyed to the deterministic ids, 78 intervals rebuilt.
  `verify-derivations.ts` on prod: **78 compared, 0 differences**. Backups of the prior state in
  `.context/backups/prod-{derivations,derived-intervals,device-run-periods}-pre-phase11.json`
  (2 / 80 / 78 rows).
- **The design's crux held**: prod's area ids are IDENTICAL to dev's (`019ec06c-f635…`,
  `019ec06c-f6b8…`), so both environments now carry the SAME deterministic derivation ids
  (`947afbcc-…`, `253f145f-…`) — which is what makes the by-PK sync correct. Their previous random
  ids differed across environments (`dcaf7065…`/`71e6d56c…` on prod vs `7488b145…`/`1f782b56…` on
  dev), exactly the breakage the normalization prevents.
- 🛑 **Prod's derivation row was STALE, and the fill fixed it.** `device_trackers` had been re-pointed
  to the DSE on 2026-07-27 01:00 — AFTER the 26 Jul cutover — so the transform-era derivation still
  described the retired Selectronic grid-power proxy (`lowerW:-50, delayOff:120`, signal
  `bidi.grid/power`). The live tracker is `upperW:100, delayOff:240`, signal **system 14 point 3,
  `generator.engine/speed` (rpm)**. The fill takes `device_trackers` as authoritative, so the
  derivation now describes the DSE. This also explains prod's 80-vs-78 interval drift: the frozen
  cutover snapshot predated the re-point.
- Prod stayed healthy throughout (`/api/health` 200); the running build reads `device_run_periods`
  and never touches these tables.

**✅ PR 1 MERGED AND LIVE ON PROD** ([#256](https://github.com/simonhac/LiveOne/pull/256), 2026-07-27
14:54 UTC). Verified on prod: the old `/api/cron/run-periods` 404s, `/api/cron/derivations` is on the
minutely schedule in `vercel.json`, `/api/health` 200.

**✅ Daylesford regenerated from musher-start (2026-07-28).** Probed prod under a short-TTL read-only
`pscale role` (reassigned + deleted afterwards): exactly **one** enabled run detector, signal point
`e149f15f-…` = system 14 index 3 **Engine Speed**, params `upperW:100 / delayOff:240` — i.e. prod's
fill really did take the re-pointed DSE tracker. Signal readings run `2026-07-11 07:39:48Z` →
now, 288 samples/day. Backed up all 78 intervals to
`.context/backups/prod-derived-intervals-pre-regen.json`, then
`action=regenerate&start=2026-07-11&end=2026-07-27` → `rowsPurged:3, rowsInserted:3`.

Diff, pre vs post: **exactly one row changed** — 22 Jul `01:46:19–02:16:18` (proxy-derived: max/avg
power **−1156 / −3723 W**, the Selectronic grid signal) became `01:50:00–02:18:00` (DSE-derived,
1551 rpm, 1.537 kWh). The 26 + 27 Jul runs were already DSE-detected and came back byte-identical;
everything before 11 Jul (75 rows back to 2025-09-03) is untouched. Daily Engine-Speed rollups confirm
only three days since musher-start have any `value > 100` samples, so three runs is complete, not
truncated. End-to-end: `/api/system/1/run-periods?last=30d` on live prod returns 200 with the new
22 Jul boundaries.

> ⚠️ **Cosmetic follow-up, pre-existing (not introduced by the regenerate).** The detector is still
> `signalKind: "power-threshold"`, so a run's signal statistics land in the `*_power_w` columns and
> the API serves them as `minPowerKw` / `maxPowerKw`. With an rpm signal the card now reads
> "1.6 kW / 1.5 kW" for what is really ~1550 rpm (and min > max, since the fields aren't ordered for
> a positive signal). `energy_kwh` is unaffected — it comes from the separate energy point. Fix
> belongs with the aesthetic/v4-native work, not here.

**Still TODO**

1. Soak, then apply migration **0041** — code first, per the drop rule: merge + deploy PR 2, confirm
   prod is serving the new build, then `db:pg:migrate` against `sydney`, then `liveone-dev`.

> 🛑 **The prod→dev sync is DOWN and has been since ~2026-07-25** (found 2026-07-28 while checking
> post-merge state; Simon's call: proceed with the regenerate + PR 2 first, fix it in Phase 12).
> `liveone-dev` is frozen — its copy of the DSE signal point stops at `2026-07-25 03:40Z`. Two causes
> in sequence: (a) **resolved** — schema preflight mismatch, prod-only `point_readings_new_pkey` /
> `pr_new_created_at_idx`, i.e. 0039 was on dev before prod; prod 0039 landed later on 27 Jul and the
> 15:15Z run cleared preflight. (b) **current blocker** — `update or delete on table "areas" violates
> foreign key constraint "devices_primary_area_id_areas_id_fk"`. This is precisely the deferred
> follow-up at `lib/readings/prod-dev-sync.ts:162-171`: post-cutover, drifted dev areas own real
> `devices`, and `devices.primary_area_id` is NOT NULL/RESTRICT, so idDrift's clear-and-delete can't
> proceed. Six dev areas are drifted, each owning one device — legacy handles **15, 16, 10000, 10001,
> 10002, 10003** (all uuid-prefixed `019f97ba-…`). **Consequence: until this is fixed, no dev-side
> check is evidence about prod.** Dev's Daylesford derivation still describes the retired Selectronic
> proxy simply because it hasn't synced. Phase 12 should treat this as its first item, not a footnote.

**PR 2 (built 2026-07-28, not yet applied to any database).** Code-only removal plus a guarded drop:

- Deleted `scripts/config-v4/{fill,verify}-derivations.ts`, `lib/derivations/fill-map.ts` + its test
  (the fill script was their only consumer), and the `deviceTrackers` / `deviceRunPeriods` tables +
  their four `$inferSelect`/`$inferInsert` type exports from `schema.ts`. Comment touch-ups in
  `lib/derivations/{resolve,params}.ts`, `lib/run-tracking/defaults.ts`, the prod-dev-sync test, and
  the two `docs/architecture/` files. `lib/run-tracking/` and `lib/readings/prod-dev-sync.ts` needed
  no change — already fully on `derived_intervals` / `derivations`.
- **`0041_drop_legacy_tracker_tables.sql`** — drizzle emitted a bare `DROP TABLE … CASCADE`; replaced
  with a `DO`/`RAISE EXCEPTION` coverage guard (`derived_intervals` row count ≥ `device_run_periods`,
  and its `max(start_time)` not trailing) and `DROP TABLE IF EXISTS` **without** `CASCADE`, so an
  unexpected dependent aborts instead of being silently removed. Idempotent.
- Green: `tsc` (app + `scripts/config-v4`), 128 suites / 1243 tests, `check:readings`, `build:local`.

**Done when:** the run-periods route and the generator-runs card render unchanged; both legacy tables
are gone; `point_info` has exactly one remaining FK child (`area_bindings`).

**Risks:** a silent re-key error would corrupt derived daily history. Gate on a recompute-and-compare
over a multi-week window, not a spot check.

---

### Phase 12 — Registry cutover: `devices`/`points` become primary

**Goal:** make the v4 registries the only registry, retire `SystemsManager`, and drop `systems`,
`point_info`, `polling_status`, `area_devices`, `user_systems`, `roles`. This is the largest structural
phase and the one that finally deletes the dark mirror.

**Work** — commit in ordered slices on one branch (the Phase-3/Phase-8 pattern), because the
`SystemsManager` fan-out is 72 files.

- **Replace `SystemsManager` with `DeviceRegistry`** as the config read API. Port the ~20 methods
  (`getSystem`, `getSystemByVendorSiteId`, `getSystemsVisibleByUser`, `createSystem`, `updateSystem`,
  `deleteSystem`, …) to device-shaped equivalents reading `devices`/`device_state`. Migrate the 75 call
  sites in slices — vendors/adapters, then admin feeds, then routes, then SSR.
- **`point-manager` mints `points` directly.** `points.id` is the uuid (today's `point_uid`) and `rid`
  comes from the sequence — so the per-device `max(index)+1` allocator and `point_info.index` both die,
  along with the `"systemId.pointIndex"` ref grammar in the publisher/receiver.
- **Delete the dark mirror** — `lib/registry/v4-mirror.ts`, its two call sites, the
  `/api/health?v4mirror=1` probe, and `scripts/config-v4/{registry-sync,registry-populate}.ts`. Defect C7
  becomes structurally impossible once the mint writes `points` as primary.
- **Re-key the remaining int-addressed tables:** `sessions.system_id` → `device_rid` (a live int FK into
  `systems`, so it blocks the drop), `observations_outbox.system_id` → `device_rid` (no FK; rename only,
  no rewrite — `devices.rid` preserves `systems.id` verbatim).
- **Finish `area_bindings`:** point at `points` by uuid, make `priority` the ordering key everywhere
  (`lib/areas/bindings.ts`, `app/api/areas/route.ts`, `lib/areas/create.ts` all still `ORDER BY ordinal`),
  then drop `ordinal`, `point_system_id`/`point_id`, and the composite FK into `point_info`.
- **Drop `user_systems` and `isViewer`** (7 query sites; `isViewer` is confined to `lib/api-auth.ts` and
  only feeds `canRead`), and drop `roles` — `area_bindings_role_check` from migration 0032 already
  enforces the 6-role set, and Phase 11 removed the other FKs.
- **Fix the deferred prod→dev sync hazard — DO THIS FIRST; it is no longer theoretical.** As of
  2026-07-25 it breaks every sync run, so `liveone-dev` is frozen and unusable as a rehearsal target
  (see the Phase 11 note above). The `areas` `idDrift` step
  can't realign a drifted area that owns real `devices`/`points`, because `devices.primary_area_id` and
  `derivations.area_id` are NOT NULL/RESTRICT while `area_bindings` can cross-reference a point owned by a
  device under a _different_ area — a naive clear-and-delete destroys other areas' live bindings. It
  belongs here because it is the same dark-registry territory, and the safe fix (null-out rather than
  delete) falls out once the mirror is gone. 4 dev areas (handles 15, 16, 10000, 10001) sit un-realigned.
- **Drop `systems`, `point_info`, `polling_status`, `area_devices`** and their `$inferSelect` type exports.

**Done when:** zero query sites against any dropped table; `SystemsManager` deleted; a real poll →
publish → receive → aggregate → serve cycle green on `liveone-dev` including a **newly minted point**
(the C7 case); `db:sync-dev-db` exits 0 with all four orphan-FK checks at 0 and the 4 drifted areas
realigned; `check:readings` green.

**Risks:** highest of any remaining phase. Migrations are manual and must reach prod before the dependent
code merges, and `sessions`/`outbox` renames touch the ingest path — so stage it expand/contract (add,
dual-read, cut, drop) rather than as one flip. The registry rename has no rehearsal harness left after
Phase 10, so lean on `liveone-dev` as the dress rehearsal.

---

### Phase 13 — Kill the handle: TypeID-native serve path

**Goal:** delete `areas.legacy_system_id` — the headline deletion — and everything that reads an integer
as an address. Depends on Phase 12 (`DeviceRegistry` must already be the config API).

**Work**

- **Delete the synthesis:** `synthesizeAreaView`, `getViewableSystem`, `isAreaHandle`, `AREA_HANDLE_BASE`
  and `allocateAreaHandle` (which reads `max(systems.id)`, so it dies with `systems` anyway). Route the 8
  remaining call sites (`lib/api-auth.ts` ×3, `serve-data.ts`,
  `logical-system.ts`, `point-manager.ts` ×2) through `DeviceRegistry.resolveHandle` — one read instead of
  a DB probe plus a fabricated virtual system. **Precedence is device-first (locked)**, which is what
  today's real-row-first code already does, so this is behaviour-preserving. Keep
  `point-manager-area-of-one-parity.test.ts` as the gate.
- **Make the wire TypeID-native:** `/api/data` and `/api/history` accept `deviceId=dv_…` / `areaId=ar_…`;
  the payload's `system` key becomes `device`. Demote `?systemId=N` to a **permanent compat alias**
  resolved through `legacy_handles` (area first, else device) — it is currently the primary interface, not
  an alias. Update the React Query keys in `lib/queries/*` in lockstep.
- **Move the KV keyspace:** `latest:system:N` → `latest:device:{dv_…}` / `latest:area:{ar_…}`, and
  `subscriptions:system:N` likewise. The SCAN regex requires `(\d+)` and must change with it. KV is a
  disposable cache — rebuild via `rebuild-dev-kv-from-db.ts` / accept one cold poll cycle rather than
  writing a migration.
- **The `systems`→`devices` code rename**, including the URL cluster (`app/api/systems/*`,
  `app/api/system/[systemId]/*`, `app/api/admin/systems/*`, `app/admin/systems/*` — ~4,576 lines across
  21 files) and `lib/point/point-manager.ts` (~1,050 lines, ~120 `system` occurrences). Mechanical but
  wide: ~296 files mention a config-sense `system`.
- **Drop `areas.legacy_system_id`** and its unique index. Keep `legacy_handles`.
- Fold the handle-era string-ID classes in `lib/identifiers/` that no longer have callers
  (`SystemIdentifier`, `PointReference`, `SeriesPath` — ~10 prod call sites between them). **Leave
  `logical-path.ts` and `point-uid.ts` alone** — they are orthogonal to the handle and still widely used.

**Done when:** zero occurrences of `legacySystemId`, `AREA_HANDLE_BASE`, `isAreaHandle`,
`synthesizeAreaView`; `?systemId=N` still resolves for every pre-cutover handle (assert over the full
`legacy_handles` set); KV holds only TypeID-keyed entries and the subscription registry rebuilds; a
`/dashboard/id/{n}` 301 still works.

**Risks:** the KV move and the `/api/data` shape change are both user-visible on the live serving path,
and the plugin props still carry `handle` — absorb that at the `v4-adapt.ts` boundary (exactly what the
adapter is for) rather than touching 19 plugins twice.

---

### Phase 14 — v4-native presentation, and the last of the two shapes

**Goal:** one dashboard shape. Delete the v3 descriptor, the rewriter, the adapter and the legacy route
handlers. Largest phase by volume; last because it depends on Phase 12's registries.

**Work**

- **Port the 19 plugins to v4-native.** One `CARD_RENDERERS` keyed on `card-types.ts`' 18 unified
  `KnownCardType`s, replacing the split `cards/registry.tsx` (10) + `tiles/registry.tsx` (9). Plugins take
  a v4 node + `NodeContext` instead of `{card: CardV3, section: AreaSectionV3, handle}`. Then delete
  `v4-adapt.ts` (`synthCardV3`/`synthSectionV3`) — `components/dashboard/v4/node-view.tsx` is its only
  runtime caller.
- **Build the v4 editor** so the write model is v4. Today the only editor is
  `/api/dashboards/[id]` PATCH, which accepts **only** v3; `AddAreaDialog` is handed `descriptor`, and the
  page shell still calls `hasTimeTravelingCard`/`primaryHandle`/`sectionAreaIdsV3` on it. Move the shell
  onto the doc and make `temporal-cards.ts` v4-aware.
- **Build the 10 missing `/api/v4` mutation endpoints** — `/devices`, `/devices/{id}/points`,
  `/areas/{id}/members|bindings|derivations` (PUT), `/dashboards/{id}/shares|grants|revisions`, `/export`,
  `/import` — then retire the 28 legacy handlers across 15 `/api/dashboards/*` and `/api/areas/*` routes.
  `/api/areas/[areaId]/default-section` is already a straight duplicate of `/api/v4/areas/[id]/default-group`.
- **Drop `dashboards.descriptor`** once every doc is authoritative, and delete `lib/dashboard/v3.ts`,
  `cards.ts`, `v3-to-v4.ts` (still called by every `createDashboard`), `v4-seed.ts`'s v3 detour, and the
  `isDashboardV3`/`isDashboardV4` branches in `dashboards.ts`, `composition.ts`, `access.ts` and
  `app/dashboard/[...slug]/page.tsx`. Retire the bridge tests (~362 LOC).
- **Tighten to strict decode** — PR 2's deferred Commit 5: drop the dual-accept `areaRefToUuid` and the
  `rowToDashboard` read-normalize. **Precondition MET**: prod was confirmed 100% `ar_` on 2026-07-27
  (Phase 10 ran `rewrite-descriptor-area-refs.ts` there; 16/16 sections, 0 raw uuid). Re-assert before
  dropping the scaffolding — any dashboard created between then and now must also be `ar_`. Fix the
  `/api/data` `system.vendorSiteId` raw-uuid wire leak noted in PR 2.
- **Queued card work, unblocked here:** port the standalone HWS 7-day stripe (`/labs/kinkora-hws`) to a
  generic `daily-stripe` card and the selectable-series heatmap (`/device/{id}/heatmap`) to a `heatmap`
  card — deliberately deferred until the registries are unified, because building them v3-shaped would
  need throwaway scaffolding and hit `rewriteCard`'s per-type config-forwarding drop. See
  [hws-stripe-and-heatmap-cards.md](hws-stripe-and-heatmap-cards.md).
- **Close out the initiative:** delete `config-v4-phase7-rehearsal-harness.md`,
  `config-v4-phase8-cutover.md` and this file, and fold anything still true into
  `docs/architecture/data-model.md`. Git is the archive.

**Done when:** no runtime branch on dashboard shape; `descriptor` dropped; one card registry; every
dashboard mutation goes through `/api/v4`; every clean-sheet §4.8 item verified gone.

**Risks:** the 19-plugin port is where visual regressions hide, and there is no snapshot coverage. Port
plugin-by-plugin behind the still-present adapter and remove the adapter last, so each plugin is
independently revertible.

---

## Locked decisions

- **ID scheme.** Public IDs are TypeIDs: `prefix_` + Crockford-base32(UUIDv7), 26-char suffix. The DB
  stores the raw `uuid`; the prefix is wire/URL only. `lib/ids/` is the single source of truth.

  | Entity | Prefix |     | Entity     | Prefix |
  | ------ | ------ | --- | ---------- | ------ |
  | device | `dv`   |     | dashboard  | `db`   |
  | point  | `pt`   |     | derivation | `dx`   |
  | area   | `ar`   |     | binding    | `bn`   |

  Owner-scoped human **slugs** remain for pretty URLs. Share tokens stay 3-word phrases (no prefix);
  dashboard-doc nodes keep local `n_…` ids (not scope-bearing TypeIDs, §8.3); `users` keep Clerk ids.

- **The seam rule.** Uuids above, rids below. `lib/registry/registry-cache.ts` is the only owner of
  uuid↔rid↔address; `lib/readings/schema-internal.ts` is the only importer of the hot tables;
  `lib/readings/dao.ts` is the only SQL. Enforced by `no-restricted-imports` (editor/app feedback) plus
  `scripts/check-readings-boundary.mjs` (the authoritative prebuild gate, which also catches dynamic
  imports and raw SQL in `scripts/`/`packages/`). Both are permanent.

- **Eager areas — Option A.** `retire-implied-areas.ts` is abandoned; areas-of-one are kept (deleting them
  would destroy uuid-keyed `flow_attr_1d` / `battery_provenance_daily` history). Every device has exactly
  one `primary_area_id` (NOT NULL); the area-of-one is the sole home for tz/location, so it is not a
  duplicate. Areas-of-one are filtered from the user-facing area picker at render time, not deleted.

- **Adapter over rewrite** for the v4 render window (Phase 5) — the 19 plugins go v4-native in Phase 14.

- **§15 opens, baked as recommended:** `oe-grid` → area-level; `/api/v4` replaces rather than coexists;
  doc depth cap = 4; group `direction` defaults to `column`.

## Cross-cutting mechanics

- **Migrations are manual and lead code to prod.** `db:pg:generate` / `db:pg:migrate`, never
  `drizzle-kit push`. Every migration must be applied to prod `sydney` **and verified** before the code PR
  that depends on it merges — Vercel does not apply migrations at deploy. Prefer expand/contract.
- **Simon is the sole user.** Prefer a simple change with a short outage over machinery that minimises
  downtime. Share tokens are the one genuine multi-party surface.
- **Collection is durably buffered.** All ingest funnels through `publishPoll` → `observations_outbox`
  (durable) → QStash → the receiver, which is the single writer of the serving store. Pausing
  materialization never stops collection; that property is what made Phase 8's window survivable and it
  still holds for any future windowed operation.
- **KV is a disposable cache** — rebuild from PG rather than migrating it.
- Run `npm run build:local && npm run type-check` before every commit.
