# Config v4 — execution plan

> **Status: ACTIVE (started 2026-07-22).** The _rationale_ is [config-v4-clean-sheet.md](config-v4-clean-sheet.md)
> (the canonical design doc); this file is the _execution_ plan — phasing, decisions locked with
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
> phase" step is deferred — the batch opens as one PR (PR-G+H = **#228**; a later reader/writer batch would
> be its own PR).

## ▶ NEXT ACTION — Phase 9: PR 1 + PR 2 done (PR #250) → PR 3 (aesthetic changes, TBD)

> **PHASE 8 IS COMPLETE.** Scoped by Simon 2026-07-26: Phase 9 splits into **PR 1** (the
> sync-prod-to-dev FK fix, urgent — failing every 2h), **PR 2** (`areas` TypeID id-uniformity, full
> flip incl. a descriptor data migration), and a separate **PR 3** (aesthetic changes, TBD). Everything
> else from the original Phase 9 list moves to a new **Phase 10**. Full detail in the "Phase 9 —
> Post-cutover teardown" section below. **PR 1 (`2b91688d`) and PR 2 (`b122382f`) are both done,
> verified live against `liveone-dev`, and submitted together as
> [PR #250](https://github.com/simonhac/LiveOne/pull/250) (branch `simonhac/config-v4-next-pr`) — see
> their sections below for detail. Once #250 merges, the next open item is PR 3 (not yet scoped) or
> starting Phase 10.**

> **PHASE 8 IS COMPLETE.** Prod is live on the config-v4 shape. `liveone-dev` cut over first (dress
> rehearsal, Run 8), prod the same day (Run 9), via PR
> [#248](https://github.com/simonhac/LiveOne/pull/248) (`faa6f007`, merged 2026-07-26). Full detail in
> [config-v4-phase8-cutover.md](config-v4-phase8-cutover.md) § Verification and
> [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md) §§ Run 8/9.
>
> - **Run 9 (prod):** transform 263.1s · authz-check 13/13 (pre- and post-deploy) · window GO
>   (13.2 ≤ 30 min). Parity 60/61 — one root-caused, reproduced, non-blocking deviation
>   (`device_state`/`polling_status`, a structural race unique to a LIVE window with pollers un-paused
>   by design; every content checksum green). Named smoke set 6/6 green against `www.liveone.energy`
>   with a real prod session; confirmed **D-l device-first live** (handle 13 → the Sigenergy device).
>   Resumed cleanly; backlog (outbox depth 222 at resume) drained to steady-state within ~2 minutes.
> - **Run 8 (dev):** transform 246.0s · parity 61/61 · authz-check 13/13 · window GO. Found + fixed two
>   real defects before they could hit prod: a **29s device-keyed query regression** from the rid-flip
>   (`lib/readings/dao.ts`, `bb58dbe5` — the twins don't recreate `pr5m_system_time_idx`; fixed with a
>   per-rid `LATERAL`, ~39,000× faster, no new index) and a **latent `lib/kv.ts` bug** (`2d304dab`) where
>   `cutover-pause.ts clear` could silently no-op and report success while leaving the cutover flag set.
> - **Post-window finding (not a Group C blocker):** `sync-prod-to-dev.yml`'s config-table leg now
>   fails on `users.default_dashboard_id` FK — `dashboards.id` is minted independently per environment
>   post-cutover (only `legacy_id` is stable cross-env). Tracked below under Phase 9.
> - **Item D (delete virtual-system synthesis) — confirmed still DEFERRED to Phase 9** (unchanged by
>   the window — see the Phase 9 list below). **Areas id-uniformity — still DEFERRED** likewise.
>
> _The blockquotes below are the historical Run-1..7 / Group-A/B/B0 trail, superseded by the summary
> above and by [config-v4-phase8-cutover.md](config-v4-phase8-cutover.md)'s Verification section._

> **Run 5 is complete (2026-07-26): `parity 48/52` · `authz 10/13` · `window-report` ✅ GO · transform `rc=0`**,
> on branch `rehearse-5` restored from a freshly-dispatched prod backup (`0846o64bc1a7`, 2026-07-25 13:46 UTC).
> The config-first reorder is verified in the timing ledger, `T_window` = 5.4 min × 3 = 16.1 min ≤ the 30-min
> target, and **D-f was exercised for the first time** (held reader → 2 bounded `55P03` retries with the blocker
> pid logged → swap won on attempt 3). The 7 reds are all *v3 code reading a v4 database*, not transform
> defects: 4 W-series writability reds that **are** Group B's `schema.ts` work list (must reach 52/52 when the
> model + writers flip), and 3 AC1 vacuity reds. **The AC1 finding is the significant one — it retroactively
> invalidates Run 4's "authz 9/9"** (the floor didn't exist then, so `descriptor ⊆ doc` passed over an empty
> set). **Do before the window: give `authz-check.ts` a pre-transform descriptor-scope snapshot** — resolving
> both legs post-transform through code that can't read the renamed `areas` columns proves nothing. Detail:
> [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md) § Run 5. Branch `rehearse-5`
> is **retained** as the Group B build/preview target (twin tables reassigned to `postgres`).

> **Next concrete step: stand up the `v4shape` branch and run the gate (Run 5).** Restore a CURRENT prod
> backup (`pscale backup list liveone sydney` → newest, NOT `avtprjx1cmde`) into a PS-5 branch, then
> `backfill-foundation --commit` → `config-transform --commit` → `parity-check` → `authz-check` →
> `window-report`, holding an open reader across the **whole** `config-transform` run to exercise D-f for the
> first time (the stage-4 swap now runs LAST — see the reorder note below — so keep the reader open through
> the config half too). It must run AFTER the B0 pre-flight (below) because B0 changes the transform. Keep the
> branch — it is the Group B build target, and binding the build branch's preview to it is what makes the
> smoke set possible.
>
> **Pre-Run-5 hardening — config-transform now runs config BEFORE the hot swap (2026-07-25).** The
> `config-transform.ts` stages are numbered by v4 role (4 = hot, 5 = config) but now EXECUTE `1 → 2 → 5 → 5d
> → 4`, so the irreversible hot rename-swap is the transform's terminal act rather than sitting in front of
> ~35 destructive-autocommit config statements. Stage 4 and stage 5 are independent siblings of stage 2, so
> the reorder is data-safe; it shrinks the blast radius of a config-half failure (hot tables stay pristine)
> and the v3-on-v4 serving outage. The abort matrix in
> [config-v4-phase8-cutover.md](config-v4-phase8-cutover.md) is rewritten for the new order.
>
> **Group B0 — pre-flight (dark) — landed.** Found and closed three more defects that no green check could
> catch, two of them on the irreversible side: **D-h** step 1 did not actually pause materialization (the
> KV flag gates 6 cron routes, never the receiver; `publishPoll` bypasses the gated relay) → fail-closed
> receiver gate + `cutover-pause.ts` (both halves) + `parity-check --quiescence`; **D-i** stage 5a silently
> flipped `area_bindings.point_id` int→uuid under a `schema.ts` that still says `integer` → made additive
> (`point_uid`); **D-j** a false-green *inside* the anti-false-green suite (`data_type LIKE 'timestamp%'`
> asserting "is timestamptz") plus a session-TimeZone-dependent epoch-ms cast → `msToTs()` + exact
> assertions. Also: `guard.ts` target modes (Group C previously had **no** sanctioned way to run the
> scripts against dev or prod), non-vacuity floors on authz-check AC1/AC3, the DAO's three `.returning()`
> projections and two window-around SELECTs moved off columns the cutover deletes, and
> `DeviceRegistry.resolveHandle()` added dark.
>
> **Scope is now locked and much smaller** (Simon, 2026-07-25): the transform contains **no**
> `DROP TABLE`/`RENAME TO` for `systems`, `point_info`, `user_systems`, `polling_status`, `area_devices`,
> `sessions` or `observations_outbox` — so the `systems`→`devices` code rename, the KV keyspace move and
> the `user_systems`/`isViewer` drop are elective and **defer to Phase 9**. Group B = forced core +
> deleting virtual-system synthesis + dashboards uuid-native. See the scope audit in the plan of record.

> **Phase 8 started 2026-07-25.** Planning ran as a 14-agent workflow (analyse → 3 rival strategies →
> 3-lens judge panel → 3-lens adversarial refutation). It found **7 defects in the "23/23 green" transform**
> — none covered by any parity check — plus a live prod incident. Decisions locked with Simon: **no
> dual-shape DAO** (one cutover build, deployed in-window, de-risked by rehearsal); **D1–D5 config changes
> stay in the window**; **`liveone-dev` cuts over FIRST** as the dress rehearsal, prod the next day;
> **parity before deploy**; **no PS-5 scale-up**; **drop the `point_readings.id` surrogate**; **retire the
> legacy owner-scoped share token**; **unify `sharing.ts` onto `share_tokens`**; **deploy by merging to
> `main`** at S7. Full plan of record + the defect table + the ordered cutover steps + the Group A/B/C split:
> [config-v4-phase8-cutover.md](config-v4-phase8-cutover.md).
>
> **The remaining Phase-8 work** (detail in the plan of record): **Group A** ✅ (#243) and **Group B0**
> ✅ (pre-flight) are dark and landed. **Group B** — the all-or-nothing cutover BUILD, now scoped to the
> forced core (DAO rid-flip incl. the 6 SEAM sites outside `dao.ts`; `areas` renames; dashboards
> uuid-native; unify `sharing.ts`/narrow `grants.ts`) **plus** deleting virtual-system synthesis; the
> `systems`→`devices` rename, the KV move and the `user_systems` drop moved to Phase 9. **Group C** —
> schedule + run the window (dev first, prod next day).
>
> **Done so far:**
> - **P0 (prod)** — `legacy_handles` was EMPTY while `aede359b` had already shipped a hard throw through
>   `/api/cron/daily`. `backfill-foundation.ts --commit` run on prod: 16/16 devices + 16/16 areas mapped,
>   0 unmapped handles among the 15 carrying `agg_5m` data. Caught ~9.5 h before the first affected run —
>   no aggregation lost.
> - **Migration 0035** (`0035_brown_terrax`, additive: `devices`/`points`/`area_members`/`device_state` +
>   `device_rid_seq`) applied + verified on **`liveone-dev` and prod `sydney`**, reassigned to `postgres`
>   (ownership trap fired as documented). `schema.ts` ↔ snapshot ↔ DB proven in agreement (a second
>   `drizzle-kit generate` reports *"No schema changes"*). `scripts/config-v4/cutover.sql` realigned to the
>   same object names/kinds and verified a clean no-op on a 0035-applied branch.
> - **PR#242 (merged)** — the dark-mergeable Phase-8 prep: cutover cron gate (`cutover:paused` KV,
>   fail-closed, `lib/cron/guard.ts`), C7 mint-time mirror (`lib/registry/v4-mirror.ts` + `/api/health?v4mirror=1`),
>   transform defect fixes D-a/D-b/D-d/D-e/D-f, and `registry-sync.ts` (the additive dark half of stage 2).
> - **Group A (#243, merged)** — single-sourced the additive stage-2 population into `registry-populate.ts`
>   (fixes the `device_state` staleness drift; stage 2 now transactional); owner-token auto-create +
>   `share_tokens.dashboard_id` NOT NULL + grant reshape (owner→admin, role CHECK, `user_id`, timestamptz,
>   composite PK) in `config-transform.ts`; new `authz-check.ts` + DDL/content parity checks; this doc.

> **Phases 4, 5, and Phase 6's pre-cutover surface are COMPLETE (dark).** [PR #233](https://github.com/simonhac/LiveOne/pull/233)
> (Phases 4–6-so-far) is **MERGED** (`c31d7573`, now HEAD of `main`, deployed dark to prod). Phase 4: schema
> (migrations **0032**+**0033**) live on prod `sydney` + `liveone-dev`. Phase 5: v4 doc model + zod validator
>
> - v3→v4 rewriter + `resolve-shell` + adapter renderer + dual-shape SSR window. **Phase 6: the
>   `/api/v4/dashboards` resource** (GET/POST/PUT/PATCH/DELETE + validate; `If-Match`/412; `updateDashboardDoc`)
> - v4-aware share/grant access scope (#233) **plus the pre-cutover area surface** (this branch). All dark.

**Phase 6's pre-cutover surface is COMPLETE; only the cutover-era routes remain (correctly deferred):**

1. ✅ **Done (TypeID-native):** read-only `GET /api/v4/areas`, `/areas/{id}` (final TypeID-only
   members + bindings + config), `/areas/{id}/eligibility`, `/areas/{id}/resolution` (deterministic
   explicit→auto→config→absent slot report), `/areas/{id}/default-group`, and `POST /api/v4/dashboards
{seedArea}`. Migration **0034** adds per-slot binding priority + unique `legacy_handles` identities;
   `db:backfill-config-v4` pre-mints permanent `dv_` ids before cutover. Preview and persisted seeds
   use the same authoritative mapping and keep device-pinned cards such as `oe-grid`. Dashboard ref
   validation, shared scope, SSR seeding, and rendering all resolve direct devices; an unresolved
   device never falls back to its Area. **[PR #234](https://github.com/simonhac/LiveOne/pull/234)**
   is merged (`ebe944cd`).
2. **Cutover-era, correctly deferred:** `/devices`, `/devices/{id}/points`,
   `/areas/{id}/members|bindings|derivations` (PUT), `/dashboards/{id}/shares|grants|revisions`,
   `/export`, `/import` — all addressed by `dv_`/`pt_`/uuid entities the cutover mints (and `revisions`
   is uuid-keyed), so they can't be built or tested pre-cutover.

Phases 1–6 are merged, and **Phase 7 is COMPLETE** ([PR #237](https://github.com/simonhac/LiveOne/pull/237)).

**✅ Phase 7 done (2026-07-25).** The cutover transform + parity/window-fit harness
(`scripts/config-v4/{config-transform.ts,cutover.sql,parity-check.ts,window-report.ts,guard.ts}`) was built and
validated end-to-end on PS-5 branches restored from prod. **Single-window GO** — `T_window` ≈ 5 min (× 3 safety
margin = 15 min ≤ the 30-min pause target ≪ the 2h budget); **parity 23/23 green at Phase-7 close** (Run 3;
the suite has since grown — Group A's Run 4 was **36/36 + authz 9/9**, and the Group-B pre-flight adds more)
— per-column content
checksums matching old-vs-twin across all ~21M hot-table rows (15.5M `point_readings` + 6M `agg_5m`), plus
registries, bindings (now an additive dark `point_uid`), derivations (run-detector + HWS), the dashboards int→uuid PK swap
(`users`/`grants`/`share_tokens` re-keyed), and P6 series-order (priority == ordinal). Migration **0034** is
applied + `inSync` on `liveone-dev` + prod `sydney`. The rehearsal caught + fixed real bugs (PS-5 OOM on a
512 MB `maintenance_work_mem` — a prod constraint; DDL simple-protocol; two idempotency/NOT-NULL bugs). Full
design + run log: [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md).

**NEXT — Phase 8: the cutover build + window.** The rehearsed transform becomes the real Phase 8 script
verbatim; what remains is (a) the cutover **build** the transform can't rehearse — the DAO's internal SQL
flipped to rid-keyed + the `systems`→`devices` code rename + dual-grammar receiver; (b) the items the rehearsal
left as build/design tasks — the DAO-equivalence sweep (needs the rid-flip; the C2 checksums already prove twin
correctness), the authz-delta check (access semantics change by design, so it's not "delta = 0"), the 1 legacy
owner-token auto-create, and the grant reshape; then (c) schedule the window — **recommended: temporarily scale
prod up** (removes the OOM ceiling + shortens the index build; prorated cost ≈ cents) — and run § Phase 8. Prod
foundation backfill runs at cutover (step 3).

**Readings `scripts` lane: COMPLETE.** Five active operational tools now run behind `ReadingsDao`
(OpenElectricity bulk ingest, QStash health, preview seeding, dev-KV rebuilding, and the two-connection
prod→dev COPY sync); five completed one-shot migration/cleanup scripts were retired. Both lanes are zero,
so `.readings-boundary-baseline.json` is deleted. The baseline-free checker, its tests, `check:readings`,
and prebuild wiring remain as the permanent hard wall across `app`/`lib`/`scripts`/`packages`.

## Progress

| Phase                                                  | State                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Governance (doc)                                   | ✅ DONE                       | prefixes corrected to `dv/pt/ar/db/dx/bn`; `retire-implied-areas.ts` annotated abandoned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1 — `lib/ids/` TypeID codec                            | ✅ DONE                       | 33 tests incl. TypeID-spec base32 vectors + compile-time brand checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2 — `point_uid` NOT NULL + global `points.rid`         | ✅ DONE                       | PRs #212/#213 (migration 0030) applied + verified on prod `sydney` + `liveone-dev`; `rid` backfilled 1..130 in `(system_id, id)` order, `point_rid_seq` reassigned to `postgres`. Prod was a migration behind, so 0029 (drop `point_readings_flow_1d`) was applied in the same pass — its guard required the bindingless synthetic area Kuti House / legacy `1000001` materialised in `flow_attr_1d` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3 — uuid↔rid DAO seam + registry cache + lint ratchet | ✅ DONE (`app_lib`=0)         | highest-leverage strangler. **No new migration** (reads Phase-2's `point_uid`/`rid`). PR-A (dark foundation + ratchet, #214) + PR-B (receiver adoption — dual-grammar + publisher payload v2) + PR-C (first materialization writer `aggregate-points-pg.ts`; added DAO `insert5m` `preserveVendorMeta` value-only-upsert mode; byte-identical + idempotent verified on `liveone-dev`, prod `measurement_time` confirmed ms-granular) + PR-D (daily 1d agg `lib/aggregation/daily-points.ts` → DAO `delete1dRange`/`earliestAgg5mMs`/`systemIdsWithAgg5mSince`; byte-identical + idempotent verified on `liveone-dev`; #221) + PR-E (serving-path reader `lib/history/readings-pg.ts` → DAO `read5m`/`read1d`; identity via `RegistryCache.pointForAddr` with `UnknownIdError` skip-and-continue; `avgCache` reconstructed byte-identical; NO new DAO surface; pure reader, no pause) + PR-F (**CLEAN-READER BATCH** #226 — 6 pure readers `flow-series-pg`/`labs/kinkora-hws`/`enphase-history`/`battery-provenance/load`/`battery-provenance-daily-pg`/`run-periods-pg` → `read5m`/`read1d`/`readRaw`; added `ReadWindow.toInclusive` half-open upper bound + pure `upperBoundOp` helper; byte-identical verified on `liveone-dev` incl. half-open boundary + multi-point batch reverse-map; no pause) landed; **21 modules remain** (11 app_lib + 10 scripts). Readers profiled this session are NOT uniform → **6-PR trajectory** (§ Readings-seam ratchet ledger): 6 clean (done), 8 need new DAO surface (reader PRs G/H/I), 2 agg_5m writers (paused PRs J/K). PR-G (vendor 5m reads `amber/client`/`enphase/adapter`/`oe/scheduler`; added `createdAtMs`/`latest5mForPoints`/`latestAgg5mIntervalMsForSystem`) + PR-H (observability + coverage `coverage/find-gaps`/`admin/observations/stats`/`cron/monitor-observations`; added coverage COUNT-by-local-day `countAgg5mByLocalDay`/`countAgg5mForLocalDay` + created_at fleet counters `countByCreatedAtSince`/`createdAtHistogramSince`/`distinctSystemsByRawCreatedAtSince`/`latestRawCreatedAtMs` + `maxAgg5mIntervalMsForSystems`; both routes' raw `point_readings` counters moved behind the seam too; byte-identical verified on `liveone-dev` under `TZ=UTC`) landed; PR-I (**admin readings viewers** — the pivot route `admin/systems/[systemId]/point-readings` + `readings-read-pg` [which served BOTH that route AND the single-point drill-down `admin/point/[systemIdDotPointId]/readings`]; added `readAdminPivot`/`hasReadingsForSystem`/`hasReadingsForSystemBeyond`/`readRawWindowAround`/`read5mRowWindowAround` + reused `read1d`; `readings-read-pg.ts` DELETED; SQL relocated VERBATIM as `sql.raw` inside the seam → byte-identical by construction; verified on `liveone-dev` under `TZ=UTC`; #230) landed; **13 modules remain** (3 app_lib + 10 scripts). PR-JK (**the two writers, batched** — Simon 2026-07-23: `battery-provenance/recompute` + `battery-provenance-pg` + `hws/recompute`; added DAO `latestAgg5mIntervalMsForPoints` (per-point `MAX(interval_end)`) + `latestAgg5mUpdatedAtForPoint` (per-point windowed `MAX(updated_at)`) + `insert5m` `writeDataQuality` mode (7 agg + `data_quality` + `updated_at`, sole-writer derived points); HWS input reuses `read5m`; byte-identical + idempotent verified on `liveone-dev` under `TZ=UTC`; #232) landed → **`app_lib` = 0, 10 modules remain (0 app_lib + 10 scripts)**. Served-app boundary now lint-enforced (`.eslintrc.json` ratchet override removed); the `scripts` lane (10, possibly permanent) is the only baseline remainder. **Phase-3 app_lib strangler COMPLETE.** |
| 4 — additive v4 config schema + roles→CHECK            | ✅ DONE                       | migrations **0032** (dark columns `areas.day_offset_min`(backfilled)/`config`, `dashboards.doc`/`revision`, `area_bindings.role` CHECK) + **0033** (four empty tables `derivations`/`derived_intervals`/`dashboard_revisions`/`legacy_handles`) applied + verified on prod `sydney` + `liveone-dev`. Simon chose "build all 4 tables now". See § Phase 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5 — v4 dashboard doc model + dual renderer             | ✅ DONE                       | **pure core** (`v4.ts` types, `card-types.ts`, `v4-validate.ts` zod validator + `normalizeDocV4` + `collectRefs`, `v3-to-v4.ts` rewriter; adversarially reviewed) + **`resolve-shell.ts`** (§8.1 inheritance + `resolveDashboardShell`) + **adapter renderer** (`v4-adapt.ts` + `components/dashboard/v4/node-view.tsx` recursive `<NodeView>`/`DashboardV4View` reusing the UNCHANGED v3 plugins + ported `SiteChartsGroup` collapse; adapter chosen — the ~19 plugins go v4-native in Phase 9) + **dual-shape SSR window** (`CompositionDashboard` surfaces `doc`/`revision`; `isDashboardV4` guard; `dashboardAreaUuids` shape-aware area resolution at the shared/grantee paths; `renderCompositionDashboard`/`DashboardClient` branch on `doc` → `DashboardV4View`). 34 tests; zod added. Dark — no dashboard has a `doc`, v3 path byte-identical. **Deferred to Phase 6/cutover:** v4 SSR data-seeding perf, `access.ts` v4-scope for shared-v4 data, the v4-native editor + temporal nav.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6 — `/api/v4/*` route surface                          | ✅ DONE (pre-cutover surface) | Dashboard CRUD/validation plus final TypeID-only area detail, eligibility, deterministic resolution, and authoritative default-group seeding. Migration 0034 + `db:backfill-config-v4` pre-mint stable device ids; refs are validated across areas/devices, share scope includes direct devices, SSR resolves/prefetches them, and missing devices render explicitly. `If-Match` is strict (malformed present values → 400). PR #234 is merged; cutover-era collection mutation routes/revisions/export/import remain deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7 — cutover rehearsal harness                          | ✅ DONE (PR #237)             | transform + parity/window harness validated on prod-restore PS-5 branches: T_window ~5min → single-window GO; parity 23/23 at Phase-7 close (Run 3; Group A's Run 4 = 36/36 + authz 9/9) — per-column checksums across ~21M rows + full stage-5 config transform incl. dashboards int→uuid PK swap + HWS. Run log → `config-v4-phase7-rehearsal-harness.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8 — THE CUTOVER                                        | 🔄 IN PROGRESS (build done)  | #242 + Group A #243 + Group B0 dark-landed. **Group B BUILD DONE + validated** (branch `simonhac/config-v4-group-b-v2`): dashboards + sharing/grants uuid-native, DAO rid-flip, parity NOT-NULL alignment (on the areas renames). **Run 7 (prod restore): parity 61/61 · authz 13/13 · DAO-equivalence 215/215 · window GO.** Synthesis deletion (Item D) DEFERRED to Phase 9 (current code is already device-first, so D-l is a non-issue). Remaining: doc-reconcile + Group C window (dev first, prod next day). See [config-v4-phase8-cutover.md](config-v4-phase8-cutover.md). Single windowed op; pauses materialization, not pollers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9 — post-cutover: sync fix + areas TypeID uniformity   | 🔄 IN PROGRESS (PR1 + PR2 in [#250](https://github.com/simonhac/LiveOne/pull/250)) | Scoped 2026-07-26: PR 1 (sync-prod-to-dev FK fix, Option A2, `2b91688d`) + PR 2 (`areas` TypeID uniformity, Plan B full flip, `b122382f`) — both done, verified live against `liveone-dev`, submitted together as PR #250. PR 3 (aesthetic, TBD) not started; rest deferred to Phase 10. See § Phase 9. |
| 10 — deferred teardown                                  | ⬜ TODO                       | destructive teardown, Item D synthesis deletion, systems→devices rename, KV move, v4-native cards. See § Phase 10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Phases 0–6 all ship **dark**, behind the unchanged v3 app — each independently mergeable and reversible.

## Readings-seam ratchet ledger

Phase 3's boundary gate (`scripts/check-readings-boundary.mjs`, run via `npm run check:readings`;
`.eslintrc.json` `no-restricted-imports`) is a **monotonic ratchet**: each adoption PR moves one
module behind `ReadingsDao` and removes its `.readings-boundary-baseline.json` entry, so the baseline
only shrinks. **Live source of truth for the _remaining_ set is `.readings-boundary-baseline.json`** —
this ledger records the _trajectory_ the JSON can't self-record (which PR moved which module), not the
current list, so it never drifts.

| PR       | Module moved behind `ReadingsDao`                                                                                                                                                                                                                                                                                                               | `app_lib` | `scripts` | remaining |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | --------- |
| A · #214 | — (installed the baseline)                                                                                                                                                                                                                                                                                                                      | 21        | 10        | 31        |
| B · #215 | `app/api/observations/receive/route.ts`                                                                                                                                                                                                                                                                                                         | 20        | 10        | 30        |
| C · #218 | `lib/db/planetscale/aggregate-points-pg.ts`                                                                                                                                                                                                                                                                                                     | 19        | 10        | 29        |
| D · #221 | `lib/aggregation/daily-points.ts`                                                                                                                                                                                                                                                                                                               | 18        | 10        | 28        |
| E · #224 | `lib/history/readings-pg.ts`                                                                                                                                                                                                                                                                                                                    | 17        | 10        | 27        |
| F · #226 | **batch of 6 clean readers** (`flow-series-pg`, `kinkora-hws` page, `enphase-history`, `battery-provenance/load`, `battery-provenance-daily-pg`, `run-periods-pg`)                                                                                                                                                                              | 11        | 10        | 21        |
| G · #228 | **vendor 5m reads** (`amber/client`, `enphase/adapter`, `oe/scheduler`)                                                                                                                                                                                                                                                                         | 8         | 10        | 18        |
| H · #228 | **observability + coverage** (`coverage/find-gaps`, `admin/observations/stats`, `cron/monitor-observations`)                                                                                                                                                                                                                                    | 5         | 10        | 15        |
| I · #230 | **admin readings viewers** (`admin/systems/[systemId]/point-readings` route + `readings-read-pg` [served BOTH that route AND `admin/point/[systemIdDotPointId]/readings`] → `readAdminPivot`/`hasReadingsForSystem`/`hasReadingsForSystemBeyond`/`readRawWindowAround`/`read5mRowWindowAround` + `read1d` reuse; `readings-read-pg.ts` deleted) | 3         | 10        | 13        |
| J · #232 | **battery-provenance writers** (`battery-provenance/recompute` blend watermark → `latestAgg5mIntervalMsForPoints`; `battery-provenance-pg` blend upsert → `insert5m writeDataQuality` + staleness probes → `latestAgg5mUpdatedAtForPoint`)                                                                                                      | 1         | 10        | 11        |
| K · #232 | **HWS writer** (`hws/recompute` model input → `read5m`; output → `insert5m writeDataQuality`) — landed in the SAME PR as J                                                                                                                                                                                                                      | 0         | 10        | 10        |
| L · this PR | **scripts lane drain** — 5 active tools behind DAO maintenance/PointId surfaces; 5 completed one-shot scripts retired                                                                                                                                                                                                                                  | 0         | 0         | 0         |

**Trajectory (readers batched — DECIDED this session):** the 8 remaining app_lib readers need new DAO
surface (grouped by shared surface), the 2 writers pause:

- **PR-G** ✅ vendor 5m reads (`amber/client`, `enphase/adapter`, `oe/scheduler`; +`createdAtMs`/`latest5mForPoints`/`latestAgg5mIntervalMsForSystem`) → 8 / 10 / **18**.
- **PR-H** ✅ observability + coverage (`coverage/find-gaps`, `admin/observations/stats`, `cron/monitor-observations`; local-day COUNT + `created_at`-axis fleet counters + helper-vendor blend MAX) → 5 / 10 / **15**.
- **PR-I** ✅ admin readings viewers (`admin/systems/[systemId]/point-readings` route + `readings-read-pg`, which also served the single-point drill-down `admin/point/[systemIdDotPointId]/readings`; wide-pivot + keyset pagination + ±10 window + session-label + existence probes; `readAdminPivot`/`hasReadingsForSystem`/`hasReadingsForSystemBeyond`/`readRawWindowAround`/`read5mRowWindowAround` + `read1d` reuse; `readings-read-pg.ts` deleted) → 3 / 10 / **13**.
- **PR-J** ✅ _(writer, batched into PR-JK)_ `battery-provenance/recompute` + `battery-provenance-pg` (+per-point `latestAgg5mIntervalMsForPoints` + windowed `latestAgg5mUpdatedAtForPoint` + `insert5m writeDataQuality`; NOTE the forecast's fleet `maxAgg5mUpdatedAt` did NOT exist — the real staleness read is per-point + `interval_end`-windowed) → 1 / 10 / **11**.
- **PR-K** ✅ _(writer, batched into PR-JK)_ `hws/recompute` (input reuses `read5m`, output `insert5m writeDataQuality`) → 0 / 10 / **10**.

**Final end state (REACHED in PR-L):** `app_lib` = **0**, `scripts` = **0**. The baseline file is deleted.
`no-restricted-imports` remains the editor/app feedback wall and the baseline-free prebuild checker remains
the authoritative whole-repository wall, including dynamic imports and raw SQL in scripts/packages.

> **Maintenance:** every adoption PR appends one row here (the row for the PR _itself_ — not the forecast
> row for the next one) and deletes its baseline entry **in the same commit, as the final step before the
> PR is opened** (never a post-merge chore); the newest `remaining` must equal `npm run check:readings`.

### Readings cutover-seam inventory

The seam is not “two touchpoints.” Its stable public surface has three explicit classes, all implemented
inside `lib/readings/dao.ts`; the Phase 7 dual-schema parity harness must exercise every entry:

- **Point-keyed:** `readRaw`, `read5m`, `read1d`, `latestForPoints`, `latest5mForPoints`,
  `latestAgg5mIntervalMsForPoints`, `latestAgg5mUpdatedAtForPoint`, both local-day counters,
  `insertRaw`, `insert5m`, `upsert1d`, `readRawWindowAround`, and `read5mRowWindowAround`.
- **Device-keyed:** `deviceIdsWithAgg5mSince`, `latestAgg5mIntervalMsForDevice`,
  `maxAgg5mIntervalMsForDevices`, `readAdminPivot`, `hasReadingsForDevice`, and
  `hasReadingsForDeviceBeyond`. These accept or return `DeviceId`; current integer addresses resolve
  only inside the DAO.
- **Keyless maintenance/fleet:** `earliestAgg5mMs`, `countByCreatedAtSince`,
  `createdAtHistogramSince`, `distinctSystemsByRawCreatedAtSince`, `latestRawCreatedAtMs`, and
  `delete1dRange`.

Admin pivot callers supply only `PointId`, stable output keys, and the whitelisted value-column enum;
the DAO owns every hot-key projection and table-specific SQL fragment.

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

**Posture:** push as much value as possible through _reversible, ships-behind-the-unchanged-app_
dark prep before the single irreversible cutover, so the risky window is small, rehearsed, and
deterministic. The seam contract — **uuids above, rids below** — is made true the moment
`points.rid` exists (even while hot tables are still composite-keyed); the cutover then flips only
the DAO's internal SQL, changing nothing above the seam.

## Locked ID scheme (confirmed with Simon)

Public IDs are TypeIDs: `prefix_` + Crockford-base32(UUIDv7) (26-char suffix). DB stores the raw
`uuid`; the prefix is wire/URL only. Confirmed 2-letter prefixes:

| Entity | Prefix |     | Entity     | Prefix |
| ------ | ------ | --- | ---------- | ------ |
| device | `dv`   |     | dashboard  | `db`   |
| point  | `pt`   |     | derivation | `dx`   |
| area   | `ar`   |     | binding    | `bn`   |

The codec (`lib/ids/`) is the single source of truth. Owner-scoped human **slugs** remain for pretty
URLs. Share tokens stay 3-word phrases (no prefix); dashboard-doc nodes keep local `n_…` ids (not
scope-bearing TypeIDs, §8.3); `users` keep Clerk ids.

## Current-state reality (where the codebase diverges from the proposal's sketch)

Verified during planning — start from these facts, not the proposal's idealized DDL:

- **Postgres**, despite the `lib/db/planetscale/` path. Schema `lib/db/planetscale/schema.ts`.
  Migrations are **manual** drizzle-kit (`db:pg:generate`/`db:pg:migrate`), **never at deploy** —
  every migration must hit prod `sydney` _and be verified_ before the code PR that reads it merges.
- **`lib/ids/` now exists** (Phase 1). `lib/identifiers/` holds handle-era string ID classes
  (`SystemIdentifier`, `PointReference` `"sys.pt"`, `SeriesPath`) + `point-uid.ts` (server-only
  uuidv5 via `node:crypto`) — leave those alone; do NOT fold them into `lib/ids`.
- **`point_uid` is present but NULLABLE and only partially backfilled** (`scripts/utils/
backfill-point-uid.ts`, idempotent, `--commit`). Hot tables FK on the renameable _address_
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
- `areas.day_offset_min` + typed `config` are present. Migration 0034 adds
  `area_bindings.priority` (lowest wins per role/metric) while retaining `ordinal` for the legacy KV
  address, and binding writes enforce the same stem/metric catalog used by resolution.
- The `roles` SQL table has **no committed full-set seeder** (only the generator row is upserted;
  the original was deleted) → v4 replaces it with CHECK constraints generated from
  `lib/roles/registry.ts` (`ROLES` = all 6, incl. `generator`, which is absent from `ROLE_IDS`).
- Dashboards: serial id PK; descriptor in jsonb column **`descriptor`** (not `doc`); **no revisions
  table**. v3 descriptor `{version:3, sections:[…]}` in `lib/dashboard/v3.ts`; `normalizeDescriptor`
  assigns ids for `sankey` only.
- SSR seeding is shape-aware: v3 pins and v4 `device` refs are authorized and prefetched separately.

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

### Phase 0 — Governance (doc-only) ✅ DONE

- Corrected proposal §5 prefixes to `dv/pt/ar/db/dx/bn`; annotated `retire-implied-areas.ts` as
  abandoned (Option A). Confirmed: Simon, 2026-07-22.

### Phase 1 — `lib/ids/` TypeID codec ✅ DONE

- New `lib/ids/` (`base32.ts`, `uuid.ts`, `types.ts`, `typeid.ts`, `index.ts`), client-safe. Six
  codecs `Device/Point/Area/Dashboard/Derivation/Binding`; branded `TypeId<P>` so cross-entity misuse
  is a compile error. 33 tests: round-trip, `ParseError` codes, TypeID-spec `valid.yml`/`invalid.yml`
  vectors, `@ts-expect-error` brand checks. No migration, no wiring — inert until a consumer imports it.
- **Deferred:** the optional `no-restricted-imports` ban on `uuidv7` outside `lib/ids/**` (cleaner
  once real callers exist).

### Phase 2 — Point identity hardening: `point_uid` NOT NULL + global `rid` (dark, additive) ✅ DONE

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

### Phase 3 — Time-series DAO seam + registry cache + lint ratchet ✅ DONE

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

### Phase 4 — Additive v4 config schema, empty/nullable + roles→CHECK (dark) ✅ DONE

> Shipped as migrations **0032** (dark columns + `area_bindings.role` CHECK) + **0033** (four empty v4
> tables), applied + verified on prod `sydney` and `liveone-dev` (2026-07-24), all dark behind the
> unchanged v3 app. Simon decided (2026-07-24) to **build all four new tables now**, not defer to cutover.
> `0033`'s tables were minted via a temp `pscale role` then **reassigned to `postgres`** (ownership trap).

**What shipped — 0032 (touches live `areas`/`dashboards`, one atomic tx):**

- `areas.day_offset_min int` NULLABLE, backfilled `= timezone_offset_min` (in-migration UPDATE + a
  `DO/RAISE EXCEPTION` coverage guard). Stays nullable — v3 `createArea` omits it; NOT-NULL flip = cutover.
- `areas.config jsonb` (nullable; untyped — no `AreaConfig` type yet, add `$type<>` later, no migration).
- `dashboards.doc jsonb` (nullable; the v4 node-tree home, coexists with `descriptor`) + `dashboards.revision int NOT NULL DEFAULT 1` (the default keeps v3 inserts working).
- `area_bindings.role` CHECK over the 6 registry roles (incl. `generator`), alongside the surviving `roles` FK.

**What shipped — 0033 (four empty v4 tables):**

- `derivations` (generalizes `device_trackers` + absorbs HWS): CHECK `role`∈6 / `output`∈(point,intervals);
  UNIQUE `(area_id, role) WHERE role IS NOT NULL`; FK `area_id`→areas.
- `derived_intervals` (was `device_run_periods`): PK `(derivation_id, start_time)`; UNIQUE
  `(derivation_id) WHERE end_time IS NULL`; FK `derivation_id`→derivations.
- `dashboard_revisions`: PK `(dashboard_id, revision)`.
- `legacy_handles`: `handle int PK`; FK `area_id`→areas.

**Reconciliation — NOT in Phase 4 (already present, or cutover-only):**

- **Already existed:** `systems.config`; `dashboard_grants` + `dashboard_share_tokens` (the "P4" shims);
  `area_bindings.role` (+`roles` FK).
- **Cutover-only** (renames / uuid re-keys / reshapes): `systems`→`devices` + `rid` / `adapter_state`
  (←`metadata`) / `primary_area_id` / `slug`(←`alias`); `dashboards.slug`(←`alias`) / `legacy_id`;
  `area_bindings` uuid `point_id` + `priority` (`ordinal` dies); unified `share_tokens`; `dashboard_grants`
  uuid+CHECK reshape; drop `roles` / `device_trackers` / `device_run_periods`.

**Cutover checklist inherited from Phase 4** — bare uuid columns whose FK targets don't exist yet:

- Add FKs: `derivations.output_point_id`→`points`, `dashboard_revisions.dashboard_id`→`dashboards`,
  `legacy_handles.device_id`→`devices`.
- `SET NOT NULL`: `areas.day_offset_min` (re-backfill residual NULLs from any v3-created areas first).
- The `device_trackers`→`derivations` **data** migration is now unblocked (tables exist) and may be
  built/rehearsed dark in a later phase.

- Deps: Phase 2/3 (met).

### Phase 5 — v4 dashboard doc model: types, validator, rewriter, dual renderer (dark) ✅ DONE

> Landed across 5 commits (pure core → resolve-shell → adapter renderer → dual-shape SSR window), all
> dark behind the unchanged v3 app. Files: `lib/dashboard/{v4,card-types,v4-validate,v3-to-v4,
resolve-shell,v4-adapt}.ts` + `components/dashboard/v4/node-view.tsx`; wired via `CompositionDashboard`
> `doc`/`revision`, `isDashboardV4`, `dashboardAreaUuids`, and the `DashboardClient`/`renderComposition
Dashboard` branch. **Decision:** adapter over the unchanged v3 plugins (Simon) — the ~19 plugins go
> v4-native in **Phase 9**. **Deferred (Phase 6/cutover):** v4 SSR data-seeding perf (`resolveDashboard
Shell.dataHandles`), `access.ts` v4-scope so a _shared_ v4 dashboard's `/api/data` authorizes,
> the v4-native editor + `temporal-cards` v4-awareness. The sketch below is the design reference.

- `lib/dashboard/v4.ts` + `card-types.ts` — unified `group`/`card` node tree; branded
  `AreaRef`/`DeviceRef` **only** in the envelope (§8.3 invariant baked into the shape). The v3
  `"tiles"` container disappears (→ row group); every `TileView` becomes a first-class `CardType`.
- `lib/dashboard/v4-validate.ts` — zod layering (envelope strict/422; `type` open-string
  warn-not-reject; known-type strict config; refs always strict + readable), depth cap ~4, and
  `normalizeDocV4` that assigns every node a local `n_…` id idempotently.
- `lib/dashboard/v3-to-v4.ts` — pure `rewriteV3ToV4(v3, resolver)` behind a `LegacyRefResolver`:
  `areaRef(uuid)` pure; `deviceRef(legacyId)` resolves the permanent pre-minted id in
  `legacy_handles`. Round-trip + **scope-equivalence** validation.
- Merged registry: `cards/registry.tsx` + `tiles/registry.tsx` → one `CARD_RENDERERS` keyed by
  `CardType`; `group` is structural via a recursive `<NodeView>` (threads `NodeContext`
  area/device inheritance; moves the chart+sankey→`SiteChartsGroup` collapse into the group
  renderer). `catalog.ts` `TILE_CATALOG`+`CARD_CATALOG` → one `NODE_CATALOG`. **Dual-shape render
  window** (accepts both v3 and v4 for one release) retires the "rewrite breaks a live dashboard" risk.
- `lib/dashboard/resolve-shell.ts` — pure in-process `resolveDashboardShell(doc, viewer)` +
  `collectRefs(doc)` (one type-agnostic envelope walk). Refactor `renderCompositionDashboard` to use
  them; cache key `(dashboard_id, revision)`.
- Deps: Phase 1.

### Phase 6 — `/api/v4/*` route surface (dark; writes go live at cutover) ✅ DONE (pre-cutover surface)

> **Done:** the `/api/v4/dashboards` resource (GET/POST/PUT/PATCH/DELETE + validate; `If-Match`/412;
> `updateDashboardDoc`) + v4-aware share/grant access scope (#233), **plus the pre-cutover area surface**
> ([PR #234](https://github.com/simonhac/LiveOne/pull/234), merged; TypeID-native `ar_`/`dv_`/`pt_`): read-only
> `GET /api/v4/areas`, `/areas/{id}`,
> `/areas/{id}/eligibility`, `/areas/{id}/resolution`, `/areas/{id}/default-group` (capability seed →
> `rewriteV3ToV4` with authoritative device mappings), and `POST /api/v4/dashboards {seedArea}`.
> New: `loadReadableArea`/`findReadableArea` (`lib/areas/http.ts`, the single `ar_`→uuid decode + readable-set
> gate), seed builders (`lib/dashboard/v4-seed.ts`), tests (`lib/dashboard/__tests__/v4-seed.test.ts`).
> Device ids are pre-minted in `legacy_handles`; no `/api/v4` response exposes integer identities.
> `dashboard_revisions` history stays deferred (uuid-keyed).
> **Cutover-era (deferred, need cutover-minted entities):** the rest of §9.2 —
> devices/points/bindings/members/derivations/shares/grants/revisions/export/import.

- Full route table (proposal §9.2). Whole-doc `PUT` in one txn: `SELECT … FOR UPDATE`; `If-Match`
  mismatch → **412**; validate+normalize → **422** (nothing persisted); else insert
  `dashboard_revisions`, bump `revision`, invalidate the `(dashboard_id, revision)` shell cache, echo
  normalized doc + new ETag. `If-Match` optional. Restore copies forward, never rewinds.
- **Coexist vs replace:** single write surface (replace v3 descriptor PATCH at cutover), a brief
  dual-shape _render_ window, permanent `?systemId=` data-fetch compat alias via `legacy_handles`.
- Deps: Phases 1, 4, 5.

### Phase 7 — Cutover rehearsal harness (prod snapshot branch only)

- Full cutover script + parity checks, end-to-end on a throwaway snapshot branch. Two outputs: all
  parity checks pass, and the 13M+3M rewrite fits the window (else pre-copy + delta-catchup). Iterate
  to green, then schedule the real window. Deps: Phases 1–6 live and burned-in.

### Phase 8 — THE CUTOVER (single irreversible window)

> **SUPERSEDED — historical planning draft, kept for context only.** Phase 8 actually shipped
> 2026-07-26 (see the `▶ NEXT ACTION` block at the top of this file); the executed runbook is
> [config-v4-phase8-cutover.md](config-v4-phase8-cutover.md)'s ordered steps, not this draft (which
> predates that doc — e.g. it names the retired `POST /api/admin/observations/info` pause mechanism,
> superseded by `cutover-pause.ts`, and a KV keyspace rebuild that was later deferred to Phase 9).

1. **Pause materialization only** — `POST /api/admin/observations/info {action:"pause"}` freezes
   QStash delivery→receiver→hot-table writes (hot tables go static). **Keep `CRONS_ENABLED=true`** so
   poll+push collection and the relay keep buffering into the outbox + the paused queue. No poller
   pause, no drain-to-zero.
2. Materialize registries: `devices` copy the pre-minted `legacy_handles.device_id` verbatim
   (`rid` = old `systems.id`; seed `device_rid_seq` at `max+1`; never mint replacement ids); `points`
   (`id` = `point_uid` PK, `rid` PK); `areas` carried over (uuids preserved), `day_offset_min` set;
   mint area-of-one for area-less devices (tz/location copied up); `primary_area_id` → NOT NULL. Drop
   empty synthetic composites (`1000001`).
3. Run the idempotent foundation backfill once more to close the writer-deployment race, verify full
   coverage/uniqueness, then freeze `legacy_handles` (every old `systems.id` + `areas.legacy_system_id`).
   (Within `config-transform.ts` these are run **config-first** — step 5 before step 4 — so the
   irreversible hot swap is the transform's terminal act; the numbers below name the v4 role, not the run
   order. See the plan of record's ordered steps + abort matrix.)
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
   - `AREA_HANDLE_BASE`; dual-grammar receiver live); run parity checks; then `{action:"resume"}` →
     the buffered backlog drains into the new rid-keyed tables. **Resume-after-green is the one-way door.**

### Phase 9 — Post-cutover teardown

**Scoped by Simon (2026-07-26): do #1 then #5 now, each its own PR; aesthetic changes are a separate
PR3 (content TBD); everything else in the original Phase 9 list moves to a new Phase 10 (below).**

#### PR 1 — sync-prod-to-dev FK fix (#1, urgent — actively failing every 2h)

**Problem** (found live in the Group C window, 2026-07-26): re-enabling `sync-prod-to-dev.yml` post-cutover,
its small-config-table leg fails: `insert or update on table "users" violates foreign key constraint
"users_default_dashboard_id_dashboards_fk"`. Root cause: pre-cutover `dashboards.id` was a stable serial
int; Group B made it `gen_random_uuid()`, minted independently by each environment's own `config-transform`
run — prod's and dev's uuids for "the same" dashboard are unrelated values (only `dashboards.legacy_id` is
stable cross-environment). The sync copies `users.default_dashboard_id` (a uuid FK) verbatim from prod,
which doesn't exist in dev's `dashboards`. `share_tokens.dashboard_id` (NOT NULL) is the identical bug,
one step behind. Not caught by any rehearsal (single-environment; this is a two-environment interaction).

**Decided approach — Option A2, not a `legacy_id` FK-remap.** Rather than keep dev's own dashboard uuids
and remap the FK columns via a `legacy_id` bridge (A1 — the originally-sketched fix), make dev **adopt**
prod's dashboard uuids via a `legacy_id`-keyed `idDrift` (the existing, tested mode already used for
`areas`/`point_info`): reorder `dashboards` ahead of `users`/`share_tokens` in the sync manifest, sync it
with `idDrift: { uniqueKeys: [["legacy_id"], ["owner_user_id","slug"]], children: [] }` (children empty —
every FK to `dashboards.id` is CASCADE/SET NULL), and delete the now-broken serial `mirror` leg (its
`setval(pg_get_serial_sequence(...), ...)` errors on a uuid PK). Then `users.default_dashboard_id` and
`share_tokens.dashboard_id` copy verbatim — no per-column remap needed, and `legacy_id = NULL`
(post-cutover) dashboards fall through to a clean insert instead of being unbridgeable (A1's fatal gap
for `share_tokens`, which is NOT NULL). Self-quiescing: once dev converges onto prod's uuids the drift
filter is empty and later syncs are a plain upsert.
- Changes in `lib/readings/prod-dev-sync.ts`: reorder `FULL` (`dashboards` to position 2, ahead of
  `users`/`share_tokens`); replace the `dashboards` manifest entry as above; delete the dead `mirror`
  mode entirely (field, narrowing, and branch — `dashboards` is its only user).
- Companion fix (same PR): `scripts/utils/reown-dev-data.ts` still references `dashboards.clerk_user_id`
  (renamed `owner_user_id` at cutover) — masked today because the sync fails first; once fixed the
  `db:reown-dev` leg would red one step later. Rename it in this PR.
- Tests in `lib/readings/__tests__/prod-dev-sync.test.ts`: updated manifest-order assertion; new shape
  assertion for the `dashboards` entry (`idDrift`, no `mirror`); an ordering invariant
  (`dashboards` before `users`/`share_tokens`); a leg-SQL test asserting the drift/upsert SQL and the
  *absence* of `setval`/`pg_get_serial_sequence` (regression guard).
- Verification (writes to dev only — prod role is `pg_read_all_data`; `syncProdToDev` fails closed if
  the write target resolves to prod): `npm run db:sync-dev-db` exits 0; on dev all four orphan-FK checks
  (`users`, `share_tokens`, `dashboard_grants`, `dashboard_revisions` → `dashboards`) return 0;
  `legacy_id ↔ id` matches row-for-row across prod/dev; a second sync run is a stable no-op.

**✅ Done, verified live, submitted as [PR #250](https://github.com/simonhac/LiveOne/pull/250)
(2026-07-26/27, commit `2b91688d`).** Ran `npm run db:sync-dev-db` against a short-TTL
`pg_read_all_data` prod role and `liveone-dev` (revoked after). Confirmed **the reported bug is fixed
and durably committed**: `systems`/`dashboards`/`users`/`user_systems`/`polling_status`/`share_tokens`/
`roles` all synced cleanly (0 orphan FKs on `users.default_dashboard_id` / `share_tokens.dashboard_id`;
dev's `dashboards.legacy_id ↔ id` matches prod row-for-row). Two more masked bugs found and fixed the
same way (both were dead code paths — never reached because the sync failed at `users` before this
point): the `areas` `idDrift` step still referenced pre-cutover column names
(`owner_clerk_user_id`/`alias`, renamed to `owner_user_id`/`slug`) that no longer exist, and its
`children` list predates migration 0033's `legacy_handles` (an `area_id` FK with no `ON DELETE`, so an
uncleared row now blocks a drifted area's delete) — both fixed in `prod-dev-sync.ts`.
`reown-dev-data.ts` had the equivalent stale-rename bugs on `areas.owner_clerk_user_id` and
`dashboards.clerk_user_id`, plus `dashboard_grants`' own cutover reshape (`clerk_user_id→user_id`,
`created_at` now NOT NULL, PK-based conflict target) — all fixed.

**Found but deliberately NOT fixed — flagged for a follow-up, not blocking this PR:** running the sync
against real data surfaced a materially deeper, separate issue. 4 areas (handles 15, 16, 10000, 10001)
have drifted uuids (same independent-mint pattern as dashboards) and now own real `devices` rows
(config-v4's dark v4-registry mirror, populated on dev by a *different* script, `registry-sync.ts`, not
this sync). `devices.primary_area_id`/`derivations.area_id` are NOT NULL/RESTRICT, so the drifted
area's delete is blocked — but naively adding them as `idDrift` children is unsafe: `area_bindings`
(area 7/8/13/1000002's real, currently-used bindings) cross-references those same devices' `points` via
the dark, unconsumed `point_uid` column, so deleting `points`/`devices` would cascade into deleting
*other, unrelated* areas' live binding rows. Needs its own considered design (e.g. null-out-not-delete
the dark `point_uid` column, or a coordinated `registry-sync.ts` re-run after the realignment) — tracked
under Phase 10 (the dark v4-registry mirror is Phase-10-owned territory already). Net effect today:
those 4 areas' rows on dev remain un-realigned (their divergent local uuids persist); every other table
in the manifest, including the originally-reported bug's tables, syncs cleanly.

#### PR 2 — Full TypeID id-uniformity for `areas` (#5, Plan B — full flip incl. data migration)

Flip `areas`' internal representation from the raw uuid to the opaque `ar_` (raw uuid confined to the
areas data layer, matching point/device/dashboard) across **all ~11** legacy `/api/areas/*` routes,
including the two that were previously going to be excluded as "impure": the persisted v3 dashboard
descriptor (`AreaSectionV3.areaId`, raw uuid today) is data-migrated to `ar_`, and the client/server
consumers of it move in lockstep. **Correction to the original claim below** ("pure code change… no
doc/data migration"): that's only true for the self-contained area-builder routes
(`POST/GET /api/areas`, `[areaId]` GET/PATCH/DELETE, `bindings`, `devices`); the dashboard-composition
routes (`readable`, `default-section`, `provenance-summary`, `provenance-daily`, `recompute-provenance`,
`by-handle`) are joined against the persisted descriptor and do require the migration below. Simon chose
the full flip (Plan B) over scoping to the pure-code subset. See memory `config-v4-id-typeid-seam`.

**Decoupling lever:** a read-normalize in the descriptor loader (`rowToDashboard`,
`lib/dashboard/dashboards.ts`) rewrites `section.areaId` → `ar_` on read, and dual-accept decode
(`areaRefToUuid`, new `lib/areas/ref.ts`) is used at every route/scope seam. So the code deploy and the
one-off data migration need no simultaneity and produce no broken window — the code is correct against
both descriptor forms from the moment it deploys; the migration is a cleanup that can run after.

- **Commit 1** — shared primitives: `lib/areas/ref.ts` (`areaRefToUuid`, `areaRefToArId`,
  `encodeDescriptorAreaRefs`); make `pureAreaRef` (`lib/dashboard/v3-to-v4.ts`) dual-accept.
- **Commit 2** — decode seam + area-builder flip: `loadAreaForOwner` in `lib/areas/http.ts` (400
  malformed / 404 unknown / 403 not-owner); encode `ar_` on output in the builder routes + admin SSR
  feed (`lib/admin/get-areas-data.ts`); `ReadableArea.id` stays raw uuid below the seam.
- **Commit 3** — dashboard-composition route flip (decode input, encode output, incl. the raw-SQL
  `WHERE area_id = ${uuid}` cases) + `dashboardAreaUuids` (`lib/dashboard/composition.ts`) decode + the
  `rowToDashboard` read-normalize + SSR prop encoding (`app/dashboard/[...slug]/page.tsx`) + the one
  DARK `node-view.tsx` line + the battery-provenance-history card normalizing to `ar_` at its boundary.
  Helper device `vendorSiteId = helper:area:<raw uuid>` stays raw (below the seam; device identity, not
  a public area id) — only its wire-adjacent card consumer normalizes.
- **Commit 4** — the persisted descriptor migration: `scripts/config-v4/rewrite-descriptor-area-refs.ts`
  (a `tsx` one-off modeled on `scripts/config-v4/backfill-foundation.ts` — data, not schema, so not a
  drizzle migration), idempotent, dry-run default, row/section-count validation before any write, run on
  dev then (after a prod backup) on prod.
- **Commit 5 (deferred to Phase 10)** — once prod is confirmed 100% `ar_`, drop the dual-accept/
  read-normalize and tighten route decode to strict.
- Tests: `lib/areas/__tests__/ref.test.ts` and `http.test.ts` (new — the biggest existing coverage gap
  is no test for `lib/areas/http.ts` or any `/api/areas/*` route); `dashboard-area-uuids.test.ts` fixtures
  flipped to `Area.encode`; route round-trip tests (`ar_` in → raw uuid predicate → `ar_` out; malformed
  → 400; no raw uuid in any response body).
- Verification (dev, JWT auth via `scripts/utils/get-test-token.ts` — `x-claude` is insufficient for
  Clerk-gated routes): run the migration; load a dashboard with areas + the battery-provenance-history
  card; exercise "Add existing area", Recompute, and dashboard creation seeded from an area; DevTools
  wire audit confirms no raw uuid on any `/api/areas/*` or `/api/dashboards/*` response.

**✅ Done, verified live, submitted as [PR #250](https://github.com/simonhac/LiveOne/pull/250)
(2026-07-27, commit `b122382f`).** All 4 commits implemented; `npm run build:local` +
`npm run type-check` + the full Jest suite (128 suites, 1250 passed) all green. Ran the descriptor
migration against `liveone-dev` (dry-run → `--commit` → re-run confirmed idempotent): 5 dashboards,
27 sections, all now `ar_`; spot-checked directly in Postgres. Started the dev server and, with a
minted Clerk JWT, exercised the live routes: `GET /api/areas/[areaId]` (builder, strict) accepts a
valid `ar_`, 400s a raw uuid AND garbage; `GET /api/areas/[areaId]/provenance-daily` (composition,
dual-accept) resolves BOTH forms and always emits `ar_` on output; `by-handle` emits `ar_`;
`default-section` emits `ar_` for the `AddAreaDialog` append path. Loaded a real dashboard
(`db_0ntpqjgrz38gn9pfn8dmzr5a1d`) in-browser as the signed-in owner: all 11 sections' areas resolved
by name (proving the SSR-encoded props ↔ read-normalized descriptor ↔ client `ar_`-keyed `areaById`
join), the header dropdown confirmed `canEdit`, "Add existing area…" correctly showed only the 2
areas NOT already on the dashboard (of 13 total) with `<option value="ar_…">`, and a `/device/1` page
rendered live data cleanly. No console errors on either page; `/api/areas/readable` was correctly
*not* called client-side on the owner path (SSR-seeded `initialData`, as designed).

#### PR 3 — aesthetic changes

Separate PR; content TBD by Simon.

#### Phase 10 — deferred teardown (moved from the original Phase 9 list)

- After the backlog drains and a validation window passes: drop `_old` hot tables; drop the
  `(system_id,index)→point_rid` backlog-drain map; drop `systems`/`point_info`/`roles`/
  `user_systems`/legacy token tables; delete dead handle-era code. Keep **permanently**:
  `legacy_handles`, `dashboards.legacy_id` (`/dashboard/id/{n}` 301), `?systemId=N` alias, slug URLs,
  share-token strings.
- **Delete virtual-system synthesis (Item D, moved here from Group B).** `synthesizeAreaView`/
  `getViewableSystem`/`isAreaHandle` read `systems`, so their deletion is naturally bound to the
  `systems`→`devices` drop above. Route handle resolution through `DeviceRegistry.resolveHandle`. **D-l
  precedence = device-first (locked)** — and since today's `getViewableSystem`/`isAreaHandle` are already
  real-row-first (= device-first), this is behaviour-preserving; keep the area-of-one + handle-13
  parity test as the gate. Deferred out of Group B because it is net-zero on auth and `systems`-bound.
- **`systems`→`devices` code rename + KV keyspace move + `user_systems`/`isViewer` drop** — the elective
  renames deferred from Group B.
- **Queued v4-native card work (build here, once the registries are unified — NOT before):** port
  the standalone HWS 7-day stripe timeline (`/labs/kinkora-hws`) into a generic `daily-stripe` card
  and the selectable-series heatmap (`/device/{id}/heatmap`) into a `heatmap` card, so both can be
  dropped into any area. Deferred deliberately — building them in the v3 idiom now would
  need throwaway `CardV3`/`synthCardV3` scaffolding AND a `v3-to-v4.ts rewriteCard` config-forwarding
  edit (it forwards config per-type, so a v3-placed new card's config is dropped at cutover). See
  [hws-stripe-and-heatmap-cards.md](hws-stripe-and-heatmap-cards.md).
- **From PR2 (#5):** the optional Commit-5 tightening (drop dual-accept/read-normalize once prod is
  confirmed 100% `ar_`), and the separate `/api/data` `system.vendorSiteId` raw-uuid wire leak (a
  different surface — device field, not an area id — noticed but out of scope for PR2).
- **From PR1 (#1), found live 2026-07-26/27, deliberately not fixed there:** the `areas` `idDrift`
  step in `prod-dev-sync.ts` can't safely realign a drifted area that owns real `devices`/`points`
  (config-v4's dark v4-registry mirror, populated on dev by the separate `registry-sync.ts`, not this
  sync) — `devices.primary_area_id`/`derivations.area_id` are NOT NULL/RESTRICT, and
  `area_bindings.point_uid` (dark, unconsumed by the app) can cross-reference a point owned by a device
  under a DIFFERENT, unrelated area, so a naive clear-and-delete would destroy live bindings belonging
  to other areas. Needs a considered fix (e.g. null-out-not-delete the dark `point_uid` column before
  clearing `points`/`devices`, or a coordinated `registry-sync.ts` re-run against dev after the
  realignment) — squarely in the same dark-v4-registry territory as the rest of this phase. Currently
  4 areas (handles 15, 16, 10000, 10001) sit un-realigned on dev as a result; every other manifest
  table (incl. `dashboards`/`users`/`share_tokens`, the originally-reported bug) syncs cleanly.

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
{action:"pause"}` → `queue.upsert({paused:true})`: a paused queue keeps _accepting_ enqueues but
  stops _delivery_. Keep `CRONS_ENABLED=true` (poller + relay keep filling the outbox). **Do NOT set
  `CRONS_ENABLED=false`** — that stops the relay too.
- **The one requirement — a dual-grammar receiver.** Buffered messages carry the OLD
  `"{systemId}.{pointIndex}"` int reference (`publisher.ts:79`; receiver `split(".")[1]`). Messages
  drained _after_ the cutover must be translated to `point_rid` via a frozen `(system_id, index) →
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
