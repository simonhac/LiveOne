# Config v4 — Phase 8 cutover (plan of record)

> **Status: ACTIVE.** The _rationale_ is [config-v4-clean-sheet.md](config-v4-clean-sheet.md); the
> _phasing / current-state_ is [config-v4-execution-plan.md](config-v4-execution-plan.md); the
> _rehearsal run log_ is [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md).
> This file is the durable home for the Phase-8 defect table + locked decisions + the ordered cutover
> steps + the Group A/B/C work split. (It was referenced by the other two docs before it existed; those
> links now resolve here.)

Phase 8 is THE CUTOVER: one irreversible window that flips the app from the integer-handle / composite
hot-key world to the config-v4 world (`devices`/`points`/`area_members` registries, `(point_rid, time)`
hot tables, unified `share_tokens`, uuid dashboards). Collection is buffered through `observations_outbox`
throughout, so pollers never stop — only materialization pauses. See the clean-sheet for the why.

## Defect table (from the Phase-7/8 rehearsals — none was caught by the 23/23 parity suite)

The rehearsals were "23/23 green" yet a 14-agent planning pass + PR#242 hardening found defects the
content-checksum suite is structurally blind to (it verifies data fidelity, not DDL correctness, planner
health, lock behaviour, or access semantics). Each is fixed in `scripts/config-v4/config-transform.ts`
unless noted; the verifying check is named where one exists.

| Id      | Symptom                                                                                                                                                                                                                        | First failure                                                             | Fix location                                                                                                                    | Verified by                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **D-a** | promoted dashboards uuid PK inherits no default → `createDashboard` id-less insert = 23502 on the first POST after the window                                                                                                  | first dashboard created post-cutover                                      | `config-transform.ts` stage 5d (`ALTER … SET DEFAULT gen_random_uuid()`)                                                        | `parity-check.ts` "D-a dashboards.id DEFAULT gen_random_uuid()"  |
| **D-b** | `DROP COLUMN` silently drops the indexes that column participated in — `users_default_dashboard_idx` (0016) + `dashboard_grants_dashboard_user_unique` (0012, the `createGrant` onConflict arbiter → 42P10 + duplicate grants) | first grant create post-cutover                                           | `config-transform.ts` stage 5d (recreate both; the unique is then promoted into the composite PK)                               | `parity-check.ts` D-b index + "grant uniqueness preserved as PK" |
| **D-c** | _(no code anchor — the execution plan cites "7 defects" but only a,b,d,e,f,g exist in source)_                                                                                                                                 | —                                                                         | —                                                                                                                               | **OPEN: confirm/transcribe from the planning record (below)**    |
| **D-d** | stage-2i composite-delete gate tested only 4 of 8 `areas` FK children, non-transactional, ran AFTER the `areas` renames → an abort strands prod half-migrated                                                                  | a synthetic composite with an unchecked FK child                          | removed outright → `scripts/config-v4/retire-empty-composites.ts` (daylight cleanup; blocker list derived from `pg_constraint`) | it is a prerequisite for nothing                                 |
| **D-e** | no `ANALYZE` before the swap → serving resumes with zero planner stats on a 15.5M-row table = seq scans ("cutover worked but the site is dead")                                                                                | resume, on the first served query                                         | `config-transform.ts` stage 4 (`ANALYZE` the twins before swap)                                                                 | invisible on an idle rehearsal branch                            |
| **D-f** | the `ACCESS EXCLUSIVE` swap had `lock_timeout` but a bare rethrow → one lost lock race discarded the whole ~6-min copy                                                                                                         | a live reader (serving / run-periods) holding `ACCESS SHARE` at swap time | `config-transform.ts` stage 4 (bounded 10×3s retry logging blocking pids; `synchronous_commit=on` for the swap commit)          | rehearse with a deliberately-held long reader                    |
| **D-g** | twin index/constraint names keep the `_new` suffix (can't be canonicalised in-txn: 42P07)                                                                                                                                      | cosmetic; a later `_new`-named index                                      | left `_new`; renamed in Phase 9                                                                                                 | —                                                                |

**D-c (open):** the 7th defect has no code anchor. Candidates from the planning record: the authz-narrowing
gap (`user_systems` dies with no replacement — now covered by `authz-check.ts`), or one of PR#242's
hardening items (the `run-periods` cron had no kill-switch; the relay converting durable outbox rows into
paused-queue-only rows). **Do not invent it — confirm its definition with Simon before this table is
authoritative.**

## Locked Phase-8 decisions (Simon)

- **No dual-shape DAO** — one cutover build, deployed in-window, de-risked by rehearsal (not a DAO that
  reads both key shapes).
- **`liveone-dev` cuts over FIRST** as the dress rehearsal; **prod the next day**.
- **Parity before deploy** — `parity-check.ts` + `authz-check.ts` + `window-report.ts` all green is the gate;
  **resume-after-green is the one-way door**.
- **No PS-5 scale-up** for the window (rehearsal §5.4 REVERSED): the OOM is solved by
  `CONFIG_V4_MAINT_WORK_MEM=96MB`, the saving is ~1–2 min, and a mid-copy restart forces a full stage-4
  restart. Keep the modest `maintenance_work_mem`.
- **Drop the `point_readings.id` surrogate** — the natural `(point_rid, measurement_time)` PK stands (no
  off-repo consumer, confirmed).
- **Retire the legacy owner-scoped `share_token`** — re-point it at an auto-created dashboard; unify
  `lib/dashboard/sharing.ts` onto `share_tokens` (the code half is Group B).
- **Grant `owner` role → `admin`** at reshape (no access loss).
- **Deploy by merging the cutover build to `main`** at the final step (S7).
- **Cron gate** = KV flag `cutover:paused` (PR#242, `lib/cron/guard.ts`, fail-closed), separate from
  `CRONS_ENABLED` so the POLLERS keep running (collection is buffered, never interrupted). Gated:
  relay-outbox, daily, repair-coverage, monitor-observations, run-periods, + the two derived agg_5m writers
  in minutely (after `pollAllSystems`). `OUTBOX_GC_DAYS` 7→30 so the post-resume revert stays viable while
  the `_old` tables are retained.

## Ordered cutover steps (window)

Pre-window (dark, on prod days ahead): `backfill-foundation.ts --commit` (pre-mint `dv_` ids +
`legacy_handles`; already run — P0), then `registry-sync.ts --commit` (populate `devices`/`points`/
`area_members`/`device_state` + areas-of-one, arming the C7 `/api/health?v4mirror=1` invariant early).
`retire-empty-composites.ts` is optional daylight cleanup (a prerequisite for nothing).

1. **Pause materialization** — set `cutover:paused` (freezes QStash delivery→receiver→hot-table writes and
   the gated crons). Keep `CRONS_ENABLED=true` so pollers + the outbox keep buffering. Do NOT drain to zero.
2. **Materialize registries** — `config-transform.ts` stage 2 (calls the shared `populateRegistries`; +the
   in-window `areas` column renames): `devices` (`rid`=old `systems.id`), `points` (`id`=`point_uid`,
   `rid`=`point_info.rid`), areas carryover + areas-of-one, `primary_area_id` NOT NULL.
3. **Foundation backfill (idempotent) + freeze `legacy_handles`** — close the writer-deployment race; verify
   full coverage/uniqueness.
4. **Hot rewrite** — stage 4: build `(point_rid, time)` twins → batched JOIN-copy (15.5M + 6M) → indexes/PK/
   `NOT VALID` FKs after load → `ANALYZE` (D-e) → bounded rename-swap keeping `_old` (D-f). `sessions` column
   rename only; `observations_outbox` rename deferred to Phase 9 (`device_rid == system_id`).
5. **Config transform** — stage 5: bindings→`pt_` uuid + priority; trackers+HWS→`derivations`/
   `derived_intervals`; dashboards int→uuid PK swap + v3→v4 `doc`; unified `share_tokens` (dashboard tokens
   1:1 + owner-token auto-create + NOT NULL); grant reshape (role CHECK/`user_id`/timestamptz/composite PK).
6. **KV** — delete `latest:system:*` / `subscriptions:system:*`; rebuild under `latest:device:{dv_}` /
   `latest:area:{ar_}`; warm from PG or accept ≤1 poll cycle cold.
7. **Deploy the cutover build** (`systems`→`devices` rename; DAO SQL flipped rid-keyed; virtual-system
   synthesis deleted; dual-grammar receiver) by merging to `main`; run `parity-check.ts` + `authz-check.ts`;
   then clear `cutover:paused` → the buffered backlog drains into the rid-keyed tables. **This resume is the
   one-way door.**

## Work split (Group A / B / C)

- **Group A — DARK / mergeable before the window** _(this batch — in progress)_. Completes the transform +
  its verification; deploys no serving code.
  - Single-source the additive stage-2 population — `scripts/config-v4/registry-populate.ts`
    (`populateRegistries`), shared verbatim by `registry-sync.ts` and `config-transform.ts` stage 2 (fixes
    the `device_state` `DO NOTHING`→`DO UPDATE` staleness drift; makes stage 2 transactional).
  - Owner-token auto-create + `share_tokens.dashboard_id` NOT NULL; grant reshape (owner→admin, role CHECK,
    `user_id`, timestamptz, composite PK) — both in `config-transform.ts` stage 5d.
  - `scripts/config-v4/authz-check.ts` (AC1 scope-equivalence, AC2 share-token preservation, AC3 user→point
    delta = intended reduction) + DDL-correctness parity checks (D-a/D-b class) + device_state content
    checksum in `parity-check.ts`.
  - This doc + the execution-plan updates.
- **Group B — the cutover BUILD (all-or-nothing, deployed in-window).** DAO internal SQL flipped to
  `point_rid` (`lib/readings/dao.ts` 16 point-keyed + 7 device-keyed `// SEAM:` sites; add `point_rid`;
  `sessions`/`outbox` `system_id`→`device_rid`); `systems`→`devices` code rename; delete virtual-system
  synthesis (`synthesizeAreaView`/`getViewableSystem`/`isAreaHandle`/`AREA_HANDLE_BASE`, the point-manager +
  api-auth area branches); `?systemId=` compat alias via `legacy_handles` (add handle→`area_id` resolver to
  `lib/registry/device-registry.ts`); KV keyspace move; drop `user_systems` + the `isViewer` branch; unify
  `lib/dashboard/sharing.ts` onto `share_tokens` + narrow `lib/dashboard/grants.ts` role to admin/viewer;
  extend the area-of-one parity test; DAO-equivalence sweep (capture-before / compare-after on a snapshot).
- **Group C — the WINDOW (ops).** Schedule; run the ordered steps above; `liveone-dev` first, prod next day.

## Verification (Group A acceptance gate)

`npm run build:local && npm run type-check` + unit tests green; then a full-transform rehearsal on a fresh
PS-5 branch restored from prod (per the Phase-7 runbook): `backfill-foundation` → `registry-sync`/transform
→ `parity-check` (incl. the new DDL + content checks) → `authz-check` (AC1–AC3) → `window-report` (still
single-window GO). False-green is the enemy — the new checks exist precisely to catch what the 23/23 missed.
