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

## ▶ NEXT ACTION — Phase 10 (scaffolding demolition + snapshot reconciliation)

Phase 9's PR 1 + PR 2 merged as [#250](https://github.com/simonhac/LiveOne/pull/250). **PR 3 ("aesthetic
changes") is SCRAPPED** (Simon, 2026-07-27) — aesthetic work waits until the migration is 100% complete
(i.e. after Phase 14), so it is not part of this plan at all. Nothing else is outstanding from Phase 9.

**Two loose ends carried in from Phase 9 — settle both in Phase 10:**

1. **`rewrite-descriptor-area-refs.ts` ran on `liveone-dev` only.** No prod run is recorded. Prod
   descriptors may still hold raw area uuids. This is not a live break (the read-normalize in
   `rowToDashboard` plus dual-accept `areaRefToUuid` make the code correct against both forms) but the
   migration is unfinished and blocks the Phase-14 strict-decode tightening.
2. **The drizzle snapshot no longer describes the live database.** See Phase 10.

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
- **Correction to the plan:** the `prebuild` wiring **cannot** be removed yet. `guard.ts` is imported by
  the survivors (`registry-sync`, `rewrite-descriptor-area-refs`), so `scripts/config-v4/` and its
  `tsc -p …/tsconfig.json` prebuild step live until **Phase 12**.

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

1. **Probe prod's actual shape first** (short-TTL `pg_read_all_data` role): `drizzle-kit pull` against
   prod into scratch, diff vs the dev probe (`.context/snapshot-probe/`). Dev is NOT proof of prod —
   prod has its own hand-applied-DDL history (the CONCURRENTLY index era), and `backfill_progress` /
   `area_bindings.point_uid` population must be confirmed per-environment. Also verify prod descriptors
   are 100% `ar_`; if not, run `rewrite-descriptor-area-refs.ts` on prod (backup, dry-run, `--commit`).
2. **Fix `schema.ts` BEFORE cutting the 0036 snapshot** — cutting it first bakes the drift in silently
   (verified: a snapshot from today's `schema.ts` contains zero occurrences of
   `area_bindings.point_uid`, so the column becomes permanently invisible to drizzle instead of
   dropped). Declare `area_bindings.point_uid` (nullable uuid; FK → `points.id`, plain NO ACTION —
   read from `pg_constraint`, so a `points` delete is _blocked_, not cascaded as Phase 9 PR 1 feared;
   fully populated 72/72 on dev). Rename `schema.ts`'s `pr*_new_*` index names to canonical in the
   same pass.
3. **Write `0036_config_v4_cutover_reconcile.sql` by hand** — the renames ARE the migration, journalled
   and applied by plain `db:pg:migrate` (no out-of-band DDL pass): `ALTER INDEX … RENAME` /
   `ALTER TABLE … RENAME CONSTRAINT` for the 6 `pr*_new_*` indexes, the 4 hot-table FKs
   (`pr_new_point_fk` → drizzle-default names), the ~7 config-table FKs whose transform-given names
   (`…_dashboards_fk`) differ from drizzle defaults (`…_dashboards_id_fk`), and the `point_uid` FK if
   its DB name differs from the declared one. All metadata-only and instant; wrap each in a
   `DO`/`IF EXISTS` guard so the file is idempotent and no-op-safe on any DB shape. **Why renames can't
   be a generated migration:** drizzle-kit cannot express a rename — it emits DROP INDEX +
   CREATE INDEX, a multi-minute rebuild on the 15M-row table. Accepted cosmetic residue (do NOT
   chase): a few uniques exist as CONSTRAINTs in the DB where `schema.ts` says `uniqueIndex` (e.g.
   `dashboards_legacy_id_unique`) — identical enforcement, invisible to generate.
4. **Transplant the snapshot:** scratch generate-from-empty against the fixed `schema.ts` → take its
   snapshot verbatim, patch `prevId` := 0035's snapshot id, save as `meta/0036_snapshot.json`; append
   the journal entry (`when` > 0035's 1784954146501). Run `db:pg:migrate` on dev, verify the renames
   really landed (`pg_indexes`, not migrate's output — the journal-drift lesson), then prod. Ordinary
   numbering discipline applies (fetch main, check for in-flight 0036s in other workspaces) — but
   unlike the squash, a collision here is renumberable as usual.
5. **Audit-verify the snapshot against the live DB.** "generate → No schema changes" only proves
   snapshot == `schema.ts`, NOT snapshot == database. With no docker locally, the DB-equivalence proof
   is the churn-diff audit: re-run the pull-as-prev scratch diff and require every statement to
   classify as (a) pull-vocabulary churn with an identical definition, (b) a step-2/3 fix, or (c) the
   known step-6 drops. Zero unexplained lines on dev AND prod.
6. **Then prove the restored workflow with two normal journalled migrations:**
   - **0037, generated:** drop `dashboard_share_tokens` (0 query sites),
     `share_tokens.owner_clerk_user_id` + its four `*_ms` columns + `share_tokens_owner_idx`,
     `dashboard_grants.created_at_ms`, and the stale `$inferSelect` exports — small tables, safe on
     autopilot;
   - **0038, hand-written** (`drizzle-kit generate --custom`): drop `backfill_progress` (orphan from
     the June-2026 Turso decommission: 29 rows, never in a migration, zero repo references) and the
     three `_old` hot tables — **4.2 GB on dev** (`point_readings_old` 2823 MB / 15.35M rows,
     `agg_5m_old` 1388 MB / 5.51M, `agg_1d_old` 5.5 MB / 19.4K) — with `DO`/`RAISE EXCEPTION` guards
     (live row count ≥ old row count per table; live `max(measurement_time)` beyond old's) instead of
     drizzle's unguarded `DROP TABLE … CASCADE`. Precondition: Simon confirms the validation window
     has passed; R2 dumps taken before the drop contain the `_old` data (retention: daily 21d /
     weekly 91d / monthly 365d) and a one-off `pscale backup create` lands first per the checklist.
     Also simplify `check-readings-boundary.mjs`'s `(_old|_new)?` regex group here.

**Done when:** `db:pg:generate` reports "No schema changes" with no prompts, on a snapshot that
audit-matches BOTH dev and prod; the full 0000–0036 history is intact and 0036 was applied by plain
`db:pg:migrate` on both envs; `_old` + `backfill_progress` absent; `area_bindings.point_uid` declared;
0037/0038 applied via plain `db:pg:migrate`; `check:readings` green.

**Risks:** materially lower than the squash it replaces — no journal-table hand-edits, no history
rewrite, failures loud and rolled-back. The residual risk is a wrong rename in 0036 (guarded, verified
against `pg_indexes` on dev before prod) and the step-6 drops (guarded, backed up).

---

### Phase 11 — Derivations: one mechanism for derived signals

**Goal:** collapse run-tracking and HWS onto `derivations`/`derived_intervals`, and drop
`device_trackers`/`device_run_periods`. Small, self-contained, and it unblocks Phase 12's FK drops.

**Work**

- Data-migrate `device_trackers` → `derivations` (`role`, `output` ∈ (point, intervals), `area_id`) and
  `device_run_periods` → `derived_intervals` (PK `(derivation_id, start_time)`, the open-interval partial
  unique). Both tables were created empty by migration 0033 and are still unconsumed, so this is a fill,
  not a reshape.
- Move `lib/run-tracking/` (9 modules) onto the new tables: `resolve.ts` reads `derivations` instead of
  `device_trackers`; `lib/db/planetscale/run-periods-pg.ts`, `recompute.ts`, `live.ts` and
  `app/api/system/[systemId]/run-periods/route.ts` read `derived_intervals`. Keep the row semantics
  identical — this is a re-key, not a behaviour change.
- Register HWS as a `derivations` row (`output = point`, `output_point_id` → the existing
  `load.hws/temperature` point) so `lib/hws/recompute.ts` is discovered through the same mechanism as a
  tracker rather than being hard-wired in the minutely cron. The thermal model itself does not change.
- Add the FK `derivations.output_point_id` → `points` (deferred at 0033 because `points` was empty).
- Drop `device_trackers` + `device_run_periods`, which removes two of the three composite FKs into
  `point_info` and two of the three FKs into `roles`.
- Retire `scripts/seed-generator-tracker.ts` or port it to the new shape (it is the only `roles` writer).

**Done when:** run periods for the Daylesford genset and the Kinkora HWS series are byte-identical
before/after on `liveone-dev`; the run-periods route and the generator-runs card render unchanged; both
legacy tables are gone; `point_info` has exactly one remaining FK child (`area_bindings`).

**Risks:** run-tracking feeds `battery-provenance/fold` and `daily-points` aggregation, so a silent re-key
error would corrupt derived daily history. Gate on a recompute-and-compare over a multi-week window, not a
spot check.

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
- **Fix the deferred prod→dev sync hazard** (Phase 9 PR 1's flagged follow-up): the `areas` `idDrift` step
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
  `rowToDashboard` read-normalize once prod is confirmed 100% `ar_` (Phase 10). Fix the `/api/data`
  `system.vendorSiteId` raw-uuid wire leak noted in PR 2.
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
