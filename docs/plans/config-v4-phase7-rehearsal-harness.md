# Config-v4 Phase 7 — Cutover Rehearsal Harness

> **Status: DESIGN (approved-decisions folded in, 2026-07-25).** Rationale:
> [config-v4-clean-sheet.md](config-v4-clean-sheet.md). Phasing + Phase 8 cutover steps:
> [config-v4-execution-plan.md](config-v4-execution-plan.md). Prereqs (Phases 1–6 + migration 0034 on
> dev+prod + dev foundation-backfill rehearsal) are **met**.

Phase 7 is a **rehearsal harness**, not a code freeze: it runs the entire Phase 8 cutover transform + a full
parity suite end-to-end on throwaway prod-snapshot PlanetScale branches, iterated until **(G1)** every parity
check is green **and (G2)** the hot-table rid-rewrite fits the maintenance window. It never touches real prod.
Its outputs: a proven transform script that becomes the real Phase 8 script verbatim, and a defensible
window-fit number.

## Ground truth measured this session (start from these, not the plan's older estimates)

| Fact | Value | Source |
| ---- | ----- | ------ |
| `point_readings` size | **15.3M** rows | `pg_stat_user_tables` (dev mirror) |
| `point_readings_agg_5m` size | **5.5M** | ″ |
| `sessions` / `agg_1d` / `outbox` | 1.05M / 19.4k / 12.3k | ″ |
| Ingest rate | **~4.6k readings / 2h** (≤~16k theoretical max) | `count(measurement_time > now()-2h)` |
| Prod cluster | **PS-5, HA, 1 primary + 2 same-region replicas (0s lag)**, aws-ap-southeast-2 | PlanetScale dashboard |
| `synchronous_commit=off` | **honored** per-session (`SET`→`SHOW`=`off`) | dev |
| Area `1000001` (Kuti House) | **71 `flow_attr_1d` rows**, 1 member, 0 bindings → **KEEP** | dev |
| Migration `0035` | **free** on origin/main | `git ls-tree` |
| Surrogate `point_readings.id` consumers | none but a row-count `.returning` (`dao.ts:639`) | grep |

## Locked decisions (Simon, 2026-07-25)

- **Window budget (Q2):** materialization pause acceptable up to **2h, prefer less**. Buffered, no data loss.
  → target a **≤30-min actual window** (≪ 2h); backlog (~5–16k msgs) drains in seconds. `B_max` non-issue.
- **Timing fidelity (Q1/Q3 — "don't overengineer"):** **do not** provision a prod-class HA branch for
  timing. Use a cheap `restore-drill` throwaway for parity *and* timing; multiply by a safety factor (×3);
  GO if that fits well under the ~30-min target. Reason it holds: work is minutes-scale, the load runs with
  `synchronous_commit=off` (so the HA replica-wait the review feared is bypassed), and the 2h budget dwarfs
  everything. Budget cap ~$10 covers the throwaway branch(es).
- **Pre-copy + delta-catchup fallback:** **not built/rehearsed** — documented as break-glass only (§5.3). We
  won't need it at this scale + budget.
- **Drain-map backing (Q3):** keep `point_info` alive through the drain (Phase 9 drops it); **no**
  `legacy_point_addr` table.
- **Cron quiescence (Q7):** temporary **cron gate** (a flag the agg / provenance / HWS / coverage-repair /
  **relay** crons check and skip when set) — set at pause, cleared at resume. **Defer the
  `observations_outbox.system_id→device_rid` rename out of the window** (Phase 9) so the live relay isn't
  broken mid-rename; `device_rid==system_id`, so the rename buys nothing during the window.
- **KV rehearsal (Q8):** rebuild against the **`test:`** namespace, delete it when done. Rebuild script
  asserts the `test:` prefix (never `prod:`/`dev:`).
- **`1000001` (Q5):** **KEEP** (has flow history). The step-2 gated delete fires only on a provably-empty
  synthetic area, so this is automatic — but the plan's "drop 1000001" wording is corrected to "keep".
- **Drop `point_readings.id` surrogate (Q4):** **yes** (natural `(point_rid, measurement_time)` PK).
  In-repo safe; Simon to confirm no off-repo consumer keys on it.

## Deliverables

1. `scripts/config-v4/config-transform.ts` — **new** driver for cutover steps 2/4/5. The batched 15.3M copy
   lives here (a TS driver that commits per batch — not a single-txn migration file).
2. `scripts/config-v4/parity-check.ts` — **new**; the whole §4 suite, non-zero exit on any red.
3. `scripts/config-v4/window-report.ts` — **new**; per-stage timing + go/no-go verdict.
4. Cutover migration `0035+` — twin DDL, renames, config re-keys (idempotent; `IF [NOT] EXISTS` /
   `ON CONFLICT` / `DO…RAISE EXCEPTION`, the 0030/0032 idiom).
5. Reuses: `backfill-foundation.ts`, `restore-drill-pg.sh`, `audit-pg-fk-orphans.ts`,
   `rebuild-dev-kv-from-db.ts`, `rewriteV3ToV4` + `v4-seed` resolver, `verify-daily-learn-equivalence.ts`.

## ⚠️ Correctness guardrails (from adversarial review — non-negotiable)

- **C1 — target the snapshot, never `liveone-dev`.** `getPoolConfig()` reads `PLANETSCALE_DATABASE_URL`/
  `DB_*`, **never `DATABASE_URL`**; reused scripts `dotenv`-load `.env.local` (=dev). The runbook must
  override `PLANETSCALE_DATABASE_URL` **and** `PLANETSCALE_DATABASE_URL_MIGRATIONS` (dotenv won't clobber a
  shell-set var), and **every write-capable script asserts `current_database()`/host == the snapshot before
  its first write** (fail-closed). Pre-flight gates query the branch's `drizzle.__drizzle_migrations` +
  FK-orphan audit over `$REHEARSE_URL` directly — not `/api/health` (that reads the deployed app's DB).
- **C2 — full-table, per-column content parity.** Counts + latest-value are not enough (a mid-history rid
  mis-map or dropped column slips through). Add an **ordered per-column checksum**
  (`md5(string_agg(… ORDER BY key))` or per-column sum/min/max/count) over ALL rows + ALL columns of all
  three hot tables, `_old` vs twin. Note the twin `agg_5m` must carry every column
  (`session_id`/`data_quality`/`created_at` + the 7 value cols + sample/error_count + updated_at) — the
  checksum catches any silent drop.
- **C3 — the three cutover tables the step list forgot:** `area_devices`→`area_members` (rename +
  `system_id` int→device-uuid re-key + populate the minted areas-of-one — **parity P3 depends on it**),
  `polling_status`→`device_state` (1:1 satellite, written every poll — live-write continuity), and the
  `user_systems` drop.
- **C4 — access/authz parity.** `user_systems` dies with no replacement; legacy owner share-tokens get
  re-pointed. Compute pre- vs post-cutover readable **(user→point)** and **(share-token→point)** sets;
  assert no unintended narrowing (lockout) or widening (leak).
- **C7 — FK-checked drain of during-window points.** `NOT VALID` FKs still enforce on *new* inserts, so a
  point minted during the window needs a `points` row → the post-cutover writer **dual-writes `point_info`
  AND `points`**. The drain test mints such a point through the real writer and asserts a successful
  FK-checked insert.
- **C8 — bounded rename-swap.** `SET lock_timeout` + retry around the `ACCESS EXCLUSIVE` swap txn; rehearse
  with a deliberately-held long reader present (reads are not paused at cutover).
- **C9 — assorted:** DAO-equivalence sweep = **capture outputs before the transform, compare after** (the
  deployed DAO has one SQL shape post-swap); `points` per-column fidelity (`transform`/`metric_type`/…);
  `EXPLAIN (ANALYZE)` the **device-keyed** DAO methods on the twin (dropping the per-device time indexes can
  silently regress device-scoped reads); re-point `sessions.system_id→systems.id` FK at cutover.

## 2. Snapshot-branch runbook (per iteration)

```bash
git fetch origin main                       # 0035 still free? (yes as of 2026-07-25)
# provision cheap throwaway + restore latest R2 dump
pscale branch create liveone rehearse-N --from sydney --wait     # or a small standalone PG for Mode B
pscale role  create liveone rehearse-N rh --inherited-roles postgres --ttl 4h --format json
export REHEARSE_URL="<database_url>"; export REHEARSE_MIG_URL="$REHEARSE_URL"
# C1: assert target BEFORE any write; gates read $REHEARSE_URL directly
PSQL_URL="$REHEARSE_URL" npm run db:psql -- -Atc "select current_database(), inet_server_addr()"
PSQL_URL="$REHEARSE_URL" npm run db:psql -- -Atc "select max(id) from drizzle.\"__drizzle_migrations\""   # version gate
# transform (all scripts assert target internally)
PLANETSCALE_DATABASE_URL="$REHEARSE_URL" PLANETSCALE_DATABASE_URL_MIGRATIONS="$REHEARSE_MIG_URL" \
  npx tsx scripts/config-v4/backfill-foundation.ts --commit      # step 3 (idempotent no-op)
PLANETSCALE_DATABASE_URL_MIGRATIONS="$REHEARSE_MIG_URL" npm run db:pg:migrate            # 0035+ DDL/DML
PLANETSCALE_DATABASE_URL="$REHEARSE_URL" npx tsx scripts/config-v4/config-transform.ts --commit  # steps 2/4/5
# parity + timing
PLANETSCALE_DATABASE_URL="$REHEARSE_URL" npx tsx scripts/config-v4/parity-check.ts       # §4 → non-zero on red
PLANETSCALE_DATABASE_URL="$REHEARSE_URL" npx tsx scripts/config-v4/window-report.ts       # T_window + verdict
# teardown (ownership trap: reassign to postgres before deleting the role)
pscale role reassign liveone rehearse-N <role-id> --successor postgres --force
pscale role delete   liveone rehearse-N <role-id> --force
pscale branch delete liveone rehearse-N --force
```

Fresh branch per iteration (the rename-swap isn't idempotent). Fixes always land in the transform script
(which *is* the Phase 8 script), never as hand-edits to snapshot data.

## 3. The transform (mirrors Phase 8; FK order areas→devices→points→hot twins→bindings/derivations→dashboards)

1. **Pause** — no-op on the snapshot (a restore *is* the frozen state); record hot-table watermarks
   (`max(created_at)` via `pr_created_at_idx`).
2. **Registries** — `devices` (id=`legacy_handles.device_id`, rid=`systems.id` verbatim; seed
   `device_rid_seq` at max+1), `points` (id=`point_uid`, rid=`point_info.rid` verbatim; **trap: `pi.id` is
   the DB column, TS field `index`**), areas carryover (uuids byte-preserved — flow/provenance firewall),
   mint areas-of-one, `primary_area_id` NOT NULL; **+C3: `area_members`, `device_state`**; gated-drop empty
   synthetic composites (**`1000001` is kept — has flow history**).
3. **Foundation backfill** (no-op no-missing) + wire deferred device FK + freeze `legacy_handles`.
4. **Hot rewrite** — build unindexed twins; batched 15.3M copy (500k–1M chunks, per-batch commit, each a
   timing sample) with `synchronous_commit=off` + big `maintenance_work_mem`; build indexes/PK/`NOT VALID`
   FKs after load (**never `CONCURRENTLY`** on an unpublished twin; `VALIDATE` deferred out-of-window);
   rename-swap keeping `_old` (**+C8 lock_timeout**); `sessions` column rename (**outbox rename deferred to
   Phase 9, Q7**); retain `(system_id,index)→point_rid` addr map via surviving `point_info`.
5. **Config** — `area_bindings`→`pt_` uuid + `priority`; `device_trackers`+HWS→`derivations`/
   `derived_intervals` (migrate before dropping `roles`); dashboards uuid+frozen `legacy_id`+doc v3→v4 (via
   `rewriteV3ToV4`, atomic `legacy_id→new_id` re-key of `users.default_dashboard_id`/grants/revisions/
   share_tokens); unified `share_tokens` (strings verbatim; epoch-ms→timestamptz same deploy); **+C4 authz**.
6. **KV** — rebuild against **`test:`** namespace only (delete after); assert prefix.
7. **Parity + resume** — deploy/resume simulated; parity (§4) is the gate.

## 4. Parity suite (`parity-check.ts`, non-zero exit on red)

- **P1** per-table row counts `_old` vs twin (exact — inner join drops nothing).
- **P2** per-point last value (`latestForPoints`/`latest5mForPoints`) old-address vs new-rid.
- **P3** per-area point-set vs a **pre-transform** snapshot (needs `area_members`, C3).
- **P4** `agg_1d` day boundaries preserved verbatim.
- **P5** `flow_attr_1d` sums unchanged (untouched, area-uuid-keyed; assert zero drift + no orphan area).
- **P6** per-area series-set equality — the `ordinal→priority` swap must **not** reorder (headline risk).
- **C2** ordered per-column checksums over all rows/cols of the three hot tables.
- **C4** authz delta = 0 unintended (user→point, token→point).
- **C9** `points` per-column fidelity; device-keyed DAO `EXPLAIN`.
- **DAO sweep** — capture all 26 `ReadingsDao` method outputs **before** transform (composite) vs **after**
  (rid twin); byte-identical, under `TZ=UTC`.
- **F1–F5** foundation/mapping (backfill self-verify, `legacy_handles` coverage, FK-orphan audit, migration
  version, area-of-one parity test).
- **C1–C5 config** — dashboard rewrite scope-equivalence (`collectRefs` == `descriptorAreaIds`), zero
  `MissingDeviceMappingError`, `legacy_id` captured, share-token strings preserved, `?systemId=`/
  `/dashboard/id/{n}` shims resolve.
- **Quiescence gate** — `MAX(created_at/updated_at)` stable on all three hot tables before the final copy
  (agg/relay crons are independent writers — the cron gate, Q7).
- **Dual-grammar drain** — v2 `pointUid` + v1 `{sys}.{idx}` + a point minted during the window (C7:
  FK-checked, idempotent).

## 5. Window-fit

**5.1** Instrument per-stage wall-clock into a run-log table; `EXPLAIN (ANALYZE, BUFFERS)` a representative
copy batch; ~2× disk headroom while old+twin coexist; ≥5 runs, take **max × 3 safety factor**.

**5.2 Go/no-go:** GO iff `T_window × 3 ≤ ~30 min` (≪ 2h budget) **and** every §4 check green (incl.
quiescence) **and** the drain test passes. At 15.3M/5.5M with index-after-load + `synchronous_commit=off`,
`T_window` is expected in the low-tens-of-minutes; the ×3 margin absorbs HA/concurrency/cache differences the
cheap branch can't reproduce (deemed acceptable given the 2h budget). A prod free-space pre-flight for the
~2× twin headroom is a Phase 8 acceptance item.

**5.3 Fallback (break-glass, not rehearsed):** if a future data-growth run blows the window, pre-copy the
bulk **before** the pause and catch up a small delta in-window. Deltas must overlap the watermark and use
`ON CONFLICT (point_rid, …) DO UPDATE` (raw `id > T0` is unsafe — serial commits out of order). Documented,
not built.

## 5.4 Rehearsal run 1 — results (2026-07-25) ✅ spine GREEN, window fits

First end-to-end run of stages 1/2/4 on a **PS-5 branch restored from sydney backup `ypy8vw1fcu94`**
(15,492,014 `point_readings` + 6,028,797 `agg_5m`; 16 systems / 134 points). Verdict: **GO for
single-window** — the hot rewrite is well inside budget.

| stage | time | notes |
| ----- | ---- | ----- |
| stage2 registries | 0.7s | 16 devices, 134 points, 30 area_members, 11 device_state, 4 areas-of-one minted; all guards passed |
| stage4 copy-raw (15.5M) | 62s | 118s on a colder run — use the higher as the conservative sample |
| stage4 copy-5m (6M) | 31s | single statement |
| stage4 indexes | 128s | PK + secondary indexes + `NOT VALID` FKs, built after load |
| stage4 swap | 0.2s | idle branch — the real swap must add `lock_timeout` under live readers |
| **T_window** | **~3.7 min** (≤~5 min conservative) | |

**Correctness (spine):** row counts exact (new `point_readings` == old 15,492,014; `agg_5m` == 6,028,797),
per-point last value preserved, swap landed (rid-keyed), all stage-2 row-count guards green.
**Go/no-go:** `T_window × 3` ≈ 11–15 min ≤ 30-min target ≪ 2h budget → **GO**.

**Findings the rehearsal surfaced (all fixed in `config-transform.ts`):**

1. **PS-5 OOM on index build (real prod constraint).** `maintenance_work_mem = 512MB` on a 512 MB-RAM
   PS-5 kills the backend (`57P01`) during the PK build. **Prod is also PS-5**, so the real cutover must
   use a modest `maintenance_work_mem` (96 MB used; spills to disk, survives) + `statement_timeout = 0`.
2. **DDL via simple query protocol.** drizzle's `execute` (extended/prepared protocol) rejects a
   multi-statement + comment file; apply `cutover.sql` through the raw pg client (like `psql -f`).
3. **Idempotency:** mint areas-of-one *before* the devices insert — `ON CONFLICT` suppresses only UNIQUE
   violations, so a NULL `primary_area_id` (filled later) trips `NOT NULL` on re-run.

**Infra notes for the runbook:** PlanetScale PG **branch-from-parent (even `--seed-data`) is empty** — get
prod data via `--restore <backup-id>`. The latest backup predates a just-applied migration, and
`db:pg:migrate` **skips** it (journal-timestamp drift), so apply the trailing migration with `psql -f`.
~~Prod's `legacy_handles` is empty~~ — **SUPERSEDED 2026-07-25: the foundation pre-mint has now been run on
prod** (16/16 device + 16/16 area mappings; see the P0 note below). A branch restored from a backup taken
*before* that still needs `backfill-foundation.ts --commit`. Run cost: **~$0.02** (short-lived PS-5
branches, server-side ops, torn down).

> **P0 (2026-07-25) — prod `legacy_handles` was empty and that had become a live outage.** `aede359b`
> (#235) made `ReadingsDao.deviceIdsWithAgg5mSince` throw on an unmapped handle
> (`lib/readings/dao.ts:965-968`), and `lib/aggregation/daily-points.ts:142` calls it unguarded, so
> `/api/cron/daily` (14:05 UTC) would have failed from its first post-deploy run.
> `backfill-foundation.ts --commit` was run against prod `sydney` — `validationErrors: []`, 16 devices +
> 16 areas mapped, 0 systems unmapped, and 0 of the 15 handles carrying `agg_5m` data left unmapped. Caught
> ~9.5 h before the first affected run, so **no aggregation was missed** (`agg_1d` complete through
> 2026-07-24). Side effect: 2 areas gained `config.batteryProvenance` (Daylesford ← sys 1, Kinkora Unified
> ← sys 6), copied from their own battery-power source device — inert for materialisation (the live path
> reads the *system's* config, `lib/battery-provenance/load.ts:470-471`) and consistent with what
> `lib/areas/create.ts:394` already does at area creation.

### Run 2 (2026-07-25) — complete transform + parity, all green

Second run added **stage 5** (config) and the **`parity-check.ts` + `window-report.ts`** harness, on a fresh
PS-5 restore. Everything passed **first try**.

- **T_window = 5.1 min** (copy-raw 116s + copy-5m 42s + indexes 145s + swap 0.2s + stage5 0.9s); × 3 margin =
  **15.2 min ≤ 30-min target ≪ 2h** → **GO** (`window-report.ts`).
- **Stage 5:** 5a bindings → `point_id` uuid, 5b `device_trackers`→`derivations` + `device_run_periods`→
  `derived_intervals`, 5c **3 dashboards rewritten v3→v4, 0 failed** — all in 0.9s.
- **`parity-check.ts`: 15/15 pass, 0 fail.** The headline is **C2 per-column content checksums** (order-
  independent `sum(md5(row))`, incl. the mapped `point_rid`) matching old-vs-twin across **all ~21M rows**
  (raw 15,492,014 + agg_5m 6,028,797 + agg_1d 19,453) — proves the re-key is byte-correct everywhere, not
  just counts/latest. Plus registry counts (devices/points/device_state/area_members), points attribute
  fidelity, `points.rid == point_info.rid`, every device has an area-of-one, bindings + dashboard docs
  populated.

~~**Recommended for Phase 8:** temporarily scale prod PS-5 → a larger instance for the window.~~
**REVERSED (Simon, 2026-07-25): do NOT scale up.** The saving is ~1–2 min off a 128–145 s index build while
`T_window` (5.1 min) already sits against a 30-min target; the OOM is already solved and validated 3× by the
96 MB `maintenance_work_mem` cap; the resize mechanics (online? restart? failover?) are undocumented; and
stage 4 pins a *single* connection carrying session-level `synchronous_commit`/`statement_timeout`/
`maintenance_work_mem` across the whole copy (`config-transform.ts:546-555`), so a mid-copy restart forces a
full stage-4 restart. Keep `CONFIG_V4_MAINT_WORK_MEM=96MB`. If you scale anyway, scale ≥24 h before.

### Run 3 (2026-07-25) — deferred tranche, parity 23/23 green

Added stage 5d (dashboards **int→uuid PK swap** + re-key `users.default_dashboard_id` / `dashboard_grants` /
folded `dashboard_share_tokens` 1:1), the **HWS-model derivation** (`kind='hws-model'`, `output='point'` → the
`load.hws/temperature` point, source = `load.hws/power`), and 8 more parity checks. **Parity 23/23, 0 fail** —
adds: `dashboards.id`/`users.default_dashboard_id`/`dashboard_grants.dashboard_id` are uuid, tokens folded,
**P6 series order (priority == ordinal, 0 reorders)**, run-detector derivations == trackers (1), hws-model
derivations == temp points (1), derived_intervals == run_periods (76). Two more bugs caught + fixed: the
`share_tokens` fold hit `owner_clerk_user_id` + `created_at_ms` NOT NULLs (legacy columns that die in Phase 9 —
their NOT NULLs are now dropped in the fold). Idempotency note: 5c is not re-runnable *after* the 5d swap drops
`new_id`, so a same-branch re-run must precede the swap or use a fresh branch (fresh-branch-per-iteration
remains the model).

**Still deferred (genuinely need more than mechanical DDL):**

- **DAO-equivalence sweep** — needs the DAO's internal SQL flipped to rid-keyed (that's the cutover *build*, not
  the transform). The C2 per-column content checksums already prove the twins are byte-correct, which is the
  substance the sweep would verify against the DAO surface.
- **Authz delta** — access semantics change *intentionally* (`user_systems` dies with no replacement, §4.5), so
  the assertion isn't "delta = 0"; it needs the resolved (user→point) sets computed both ways with the intended
  reduction encoded. Design task, not a checksum.
- **1 legacy owner-scoped `share_token`** — the auto-create-a-dashboard re-point (+ `share_tokens.dashboard_id`
  NOT NULL flip) is deferred; the fold handles the dashboard-scoped tokens.
- **Grant reshape** (role CHECK/PK/`user_id`/timestamptz) + dropping `descriptor`/legacy `*_ms` columns — Phase 8/9.

## 6. Iterate-to-green & done

Loop: fresh branch → C1 target-assert + version/FK-orphan gates → transform → `parity-check.ts` →
`window-report.ts` → teardown. **Done** = one clean no-hand-edits run of the frozen `0035+` + drivers with
**all §4 green**, G2 met (`T_window×3 ≤ target`), and the drain test green — then schedule the real Phase 8
window (with the Q7 cron-gate list as an operational precondition).

## 7. Still-open for Simon

- ~~**Q4:** confirm no *off-repo* consumer keys on `point_readings.id`.~~ **CLOSED (Simon, 2026-07-25): no
  off-repo consumers — drop the surrogate; the natural `(point_rid, measurement_time)` PK stands as rehearsed.**
- Everything else is decided above. Phase-8 execution decisions (incl. no dual-shape DAO, D1–D5 kept in the
  window, `liveone-dev` cut over first, parity-before-deploy) are recorded in the Phase 8 plan of record.
