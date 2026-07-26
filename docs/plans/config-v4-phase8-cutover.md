# Config v4 — Phase 8 cutover (plan of record)

> **Status: DONE.** Phase 8 shipped 2026-07-26 — `liveone-dev` cut over first (dress rehearsal), prod
> the same day via PR [#248](https://github.com/simonhac/LiveOne/pull/248) (`faa6f007`). Prod is live
> on the config-v4 shape; the backlog buffered during the pause drained cleanly on resume. The
> _rationale_ is [config-v4-clean-sheet.md](config-v4-clean-sheet.md); the _phasing / current-state_ is
> [config-v4-execution-plan.md](config-v4-execution-plan.md); the _rehearsal + real-window run log_ is
> [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md) (Run 8 = dev, Run 9 =
> prod). This file is the durable home for the Phase-8 defect table + locked decisions + the ordered
> cutover steps + the Group A/B/C work split — kept as the historical record; **Phase 9** (post-cutover
> teardown) is tracked in the execution plan.

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
| **C7** | a point minted during the window (pollers never stop) gets a `point_info` row + rid but no `points` row → the hot tables' `NOT VALID` FK (still enforced on new inserts) rejects the first reading = QStash poison pill | first mid-window mint of a new point | `lib/registry/v4-mirror.ts` — `ensurePointInfo`/`createSystem` mirror `points`/`devices`/`area_members` at mint time (one txn); `/api/health?v4mirror=1` arms the standing invariant | the standing C7 mirror invariant + a real mid-window-mint drain test |
| **D-d** | stage-2i composite-delete gate tested only 4 of 8 `areas` FK children, non-transactional, ran AFTER the `areas` renames → an abort strands prod half-migrated                                                                  | a synthetic composite with an unchecked FK child                          | removed outright → `scripts/config-v4/retire-empty-composites.ts` (daylight cleanup; blocker list derived from `pg_constraint`) | it is a prerequisite for nothing                                 |
| **D-e** | no `ANALYZE` before the swap → serving resumes with zero planner stats on a 15.5M-row table = seq scans ("cutover worked but the site is dead")                                                                                | resume, on the first served query                                         | `config-transform.ts` stage 4 (`ANALYZE` the twins before swap)                                                                 | invisible on an idle rehearsal branch                            |
| **D-f** | the `ACCESS EXCLUSIVE` swap had `lock_timeout` but a bare rethrow → one lost lock race discarded the whole ~6-min copy                                                                                                         | a live reader (serving / run-periods) holding `ACCESS SHARE` at swap time | `config-transform.ts` stage 4 (bounded 10×3s retry logging blocking pids; `synchronous_commit=on` for the swap commit)          | rehearse with a deliberately-held long reader                    |
| **D-g** | twin index/constraint names keep the `_new` suffix (can't be canonicalised in-txn: 42P07)                                                                                                                                      | cosmetic; a later `_new`-named index                                      | left `_new`; renamed in Phase 9                                                                                                 | —                                                                |
| **D-h** | **step 1 did not actually pause materialization.** `cutoverSkipReason` gates only the 6 cron routes that call it; `/api/observations/receive` had NO gate; `publishPoll` enqueues straight to QStash, bypassing the gated relay. With the mandated `CRONS_ENABLED=true` the receiver kept writing `point_readings` through stage 4's ~6-min copy — and the copy runs over a `[min(id), max(id)]` range captured once, so those rows are silently NOT copied. Lost, on the irreversible side, detected only by a row-count compare that runs AFTER the swap. | any in-flight message during stage 4 | fail-closed `cutoverPaused()` gate in `app/api/observations/receive/route.ts` (500 → QStash retries; never ack-and-drop) + `scripts/config-v4/cutover-pause.ts` driving BOTH the KV flag and the QStash queue pause | `parity-check.ts --quiescence` — the pre-stage-4 gate (hot tables static across 60 s) |
| **D-i** | **`area_bindings.point_id` silently changed type.** Stage 5a renamed the live int to `point_id_legacy` and put a uuid in `point_id`, while `schema.ts` still declares `integer`. **Eight** modules read it (`lib/areas/{bindings,resolution,create}.ts`, `app/api/areas/route.ts`, `app/api/v4/areas/[id]/route.ts`, `lib/battery-provenance/{load,recompute}.ts`, `lib/db/planetscale/battery-provenance-pg.ts`). No 42703 — the query succeeds and returns wrong values: area point-resolution 22P02s (swallowed by `access.ts`'s per-area `catch {}` → the area silently contributes no points) and `buildSubscriptionsFromBindings` stringifies a uuid into the KV subscription registry, which `updateLatestPointValue` then never matches. | first render of a multi-device area post-cutover | stage 5a made ADDITIVE — `point_id` stays int, the uuid lands as a new dark **nullable** `point_uid` (FK → `points(id)`). Phase 9 does the swap once `point_info` dies. | `parity-check.ts` "5a point_id still integer", "point_uid is NULLABLE", "point_uid agrees with (point_system_id, point_id)" |
| **D-k** | **the first fix for D-i was itself a defect.** `point_uid` was added `NOT NULL` with no default — but `schema.ts` does not declare the column, so neither drizzle INSERT site (`lib/areas/create.ts`, reached from four `/api/areas` routes; `lib/battery-provenance/register.ts` `ensureHelperBindings`) emits it. Every binding write after resume would 23502, on the irreversible side. `.onConflictDoNothing()` does not help: NOT NULL is checked before conflict arbitration. Found by review, not by any check — **no check in the suite had ever attempted a write**. | first area create / binding edit / provenance-helper registration after resume | column left NULLABLE until Phase 9 tightens it alongside the writers (cf. `lib/point/mint-point-uid.ts`, which exists for exactly this reason on `point_info.point_uid`) | `parity-check.ts` **W-series**: for every transform-touched table, no column is NOT-NULL-without-a-default unless `schema.ts` declares it |
| **D-j** | **a false-green inside the anti-false-green suite.** `parity-check`'s *"5d grants created_at is timestamptz"* asserted `data_type LIKE 'timestamp%'` — which matches both types, so it could not fail on the thing it was named after. Separately, the epoch-ms backfill used `to_timestamp(ms/1000.0)` (a `timestamptz`) assigned to a naive `timestamp` column: an implicit cast that reads the SESSION `TimeZone`, never pinned. | a non-UTC session ⇒ every folded token expiry / grant timestamp shifts by the offset, silently | `msToTs()` in `config-transform.ts` spells the conversion as `… AT TIME ZONE 'UTC'`; `parity-check.ts` asserts `data_type = 'timestamp without time zone'` exactly, plus a value-level re-derivation from the surviving `_ms` column | `parity-check.ts` "created_at == created_at_ms (UTC, no offset drift)" |

| **D-l** | **`resolveHandle` is area-FIRST, and handle 13 is BOTH a real device and a multi-member area** — so deleting virtual-system synthesis silently RE-POINTS it. Today `getViewableSystem(13)` finds `systems.id=13` first and returns the device's 12 own points (all on system 13). After the deletion, `legacy_handles` row 13 (which carries **both** `area_id` and `device_id`) resolves area-first and expands the area's 12 bindings — **6 points on system 13 + 6 on system 16** (the derived helper). Net: 6 system-13 points DROP OUT of dashboard `legacy_id=7`'s scope and 6 system-16 points enter. A silent scope change on a shared dashboard, in the direction that removes access. | first resolution of handle 13 after the synthesis deletion (Group B), not at the transform | **RESOLVED (2026-07-26): Item D deferred to Phase 9, so D-l never fires.** Today's `getViewableSystem`/`isAreaHandle` are already real-row-FIRST (= device-first), so handle 13 already resolves to the device (12 sys13 pts) — the locked device-first behaviour. The `resolveHandle` area-first switch only happens WHEN synthesis is deleted; deferring that to Phase 9 (it reads `systems`, dropped there) keeps device-first with nothing to re-point or re-baseline. Run 7 confirmed authz-check AC1 green (0 lost points). | ~~`authz-check` AC1 will fail "descriptor ⊆ doc" by exactly 6 points on dashboard `legacy_id=7`~~ (would only fire post-deletion; deferred); verified on rehearse-6: `systems row: 1 · area members: 2 · bindings: 12 (6→sys13, 6→sys16)`, `legacy_handles.handle=13` has both ids |

D-l does not fire at the transform — it fires ONLY when the synthesis is deleted. **It is now resolved by
deferring that deletion (Item D) to Phase 9** (2026-07-26): today's dispatch is already device-first, so
handle 13 already resolves to the device — exactly the locked D-l precedence, with nothing to re-point.
It is listed here because it is the only handle in the fleet that is simultaneously a real device and a
multi-member area, so no amount of testing the other 19 handles finds it. Run 7 verified AC1 green
(`descriptor ⊆ doc`, 0 lost points) with synthesis intact.

D-h, D-i and D-j were found by the Group-B pre-flight pass (2026-07-25) and are fixed in that batch. All
three share the shape that makes this table worth keeping: **each was invisible to a green suite**, and two
of them landed on the irreversible side of the window.

D-j is not hypothetical — measured on `liveone-dev`:

```sql
SET TimeZone='Australia/Sydney';
SELECT (to_timestamp(1700000000000/1000.0) AT TIME ZONE 'UTC')::text,  -- 2023-11-14 22:13:20  ← msToTs
       (to_timestamp(1700000000000/1000.0))::timestamp::text;          -- 2023-11-15 09:13:20  ← old
```

An **11-hour** shift on every folded share-token expiry and grant `created_at`, decided by whatever
`TimeZone` the window's session happened to carry — and green under the old `LIKE 'timestamp%'` check.

**On the count (resolved):** the planning's "7 defects" = the six D-lettered rows above (the D-lettering
skips `c` — there was never a distinct "D-c" defect; an earlier draft of this table wrongly assumed a
contiguous a–g) **plus C7**, the mint-time-mirror race, which was found by the same pass but tracked under
the rehearsal doc's C1–C9 correctness-guardrail scheme (not the D-scheme) and closed in PR#242's
`v4-mirror.ts` commit. Distinct from the "live prod incident" the execution plan mentions separately (the
P0 empty-`legacy_handles` outage, fixed by running `backfill-foundation.ts --commit` on prod).

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
- **Retire the legacy owner-scoped `share_token`** — re-point it at an auto-created dashboard covering
  **all the owner's areas** (the token is owner-scoped, so this preserves the grant and never narrows it;
  narrowing to one consumer's view would risk a lockout — authz-check AC2d asserts the kinkora scope
  survives). Unify `lib/dashboard/sharing.ts` onto `share_tokens` (the code half is Group B).
- **Grant `owner` role → `admin`** at reshape (no access loss).
- **Deploy by merging the cutover build to `main`** at the final step (S7).
- **Cron gate** = KV flag `cutover:paused` (PR#242, `lib/cron/guard.ts`, fail-closed), separate from
  `CRONS_ENABLED` so the POLLERS keep running (collection is buffered, never interrupted). Gated:
  relay-outbox, daily, repair-coverage, monitor-observations, run-periods, + the two derived agg_5m writers
  in minutely (after `pollAllSystems`) — **and, since the pre-flight batch, the receiver itself**.
  `OUTBOX_GC_DAYS` is **already 30 by default** (`lib/observations/outbox.ts`) — nothing to set in the window.

### Locked in the Group-B pre-flight (Simon, 2026-07-25)

1. **Scope: forced-core + delete virtual-system synthesis** — see the scope audit below. The
   `systems`→`devices` code rename, the KV keyspace move and the `user_systems`/`isViewer` drop move to
   Phase 9. *The discipline that makes deferral safe: any table you flip, flip read AND write in the same
   deploy; any table you don't flip, leave both sides completely alone.*
2. **`area_bindings` stays int-keyed in the window** — additive dark `point_uid` (defect D-i).
3. **The pause is enforced in code, not by operator memory** (defect D-h).
4. **Dashboards go uuid-native everywhere** at cutover — not `legacy_id` int addressing. That pulls in
   `lib/user-preferences.ts`, `app/api/user/preferences/route.ts` (a `typeof !== "number"` → 400),
   `lib/queries/preferences.ts`, `components/GrantsPanel.tsx`, `components/Dashboard.tsx` and the SSR
   page's `/^\d+$/` parse — all previously un-inventoried.

## Scope audit — what the transform FORCES vs what is ELECTIVE

Group B was scoped at roughly 5× what the transform actually forces, because the config-v4 *code* rename
was treated as coupled to the *DDL* cutover. It is not. Evidence:
`grep -E 'DROP TABLE|RENAME TO' scripts/config-v4/config-transform.ts` returns **only the three hot-table
swaps**, and there are 7 `renameColumnIfExists` calls (areas ×3, dashboards ×2 + PK, dashboard_grants ×1).

**FORCED — the build cannot half-deploy across these:**

| Change | Why forced |
| --- | --- |
| 3 hot tables → `(point_rid, …)`; `point_readings.id` dropped; no `system_id`/`point_id` | the swap is irreversible and the old SQL 42703s against the twins |
| `areas`: `owner_clerk_user_id`→`owner_user_id`, `display_name`→`name`, `alias`→`slug` | in-window column renames (stage 2) |
| `dashboards` serial→uuid PK (+`legacy_id`), `users.default_dashboard_id`, `dashboard_grants` reshape (`clerk_user_id`→`user_id`, composite PK, `created_at`), `share_tokens` unification | stage 5d `DROP COLUMN`s |

**ELECTIVE — verified NOT touched by the transform, so deferrable to Phase 9 daylight PRs:**
`systems`, `point_info`, `user_systems`, `polling_status`, `area_devices`, `sessions`,
`observations_outbox` all survive Phase 8 intact and are merely COPIED into their v4 counterparts. Hence
the `systems`→`devices` code rename, the KV keyspace move (`latest:system:*` keys stay correct — the
handle is permanent), and the `user_systems`/`isViewer` drop are all elective. **Deleting virtual-system
synthesis is elective but kept in-window** (decision 1): it collapses structurally rather than needing
porting, because `legacy_handles.area_id` is filled for every handle and
`DeviceRegistry.resolveHandle()` replaces the `isAreaHandle` probe in one indexed read.

**Correction to step 4 below:** the transform performs **no** `sessions.system_id → device_rid` rename —
`device_rid` appears nowhere in `lib/` or `scripts/` except `device_rid_seq`. Since `device_rid ==
system_id` numerically, the rename buys nothing in the window; it is deferred to Phase 9 alongside
`observations_outbox`, and the code must NOT be flipped for it.

## Ordered cutover steps (window)

> **Execution order inside `config-transform.ts`:** the single `--commit` run executes **config (step 5)
> BEFORE the hot swap (step 4)** — `1 → 2 → 5 → 5d → 4`. The step NUMBERS below name the v4 role (4 = hot,
> 5 = config), not the run position. Running the cheap, idempotent config half first means a config failure
> aborts while the hot tables are still pristine, and makes the irreversible rename-swap the transform's
> terminal act (nothing destructive-autocommit runs after it). See the abort matrix.

Pre-window (dark, on prod days ahead): `backfill-foundation.ts --commit` (pre-mint `dv_` ids +
`legacy_handles`; already run — P0), then `registry-sync.ts --commit` (populate `devices`/`points`/
`area_members`/`device_state` + areas-of-one, arming the C7 `/api/health?v4mirror=1` invariant early).
`retire-empty-composites.ts` is optional daylight cleanup (a prerequisite for nothing).

**Pre-window preflight (same day, before step 1):**

- **Backup, and confirm the object landed.** Step 5 is destructive AND autocommit (`DROP COLUMN` on
  `dashboards`/`users`/`dashboard_grants`), so a mid-5d failure strands a half-reshaped config with no
  rollback — restore-from-backup is the only recovery. `pg-backup` has no GitHub cron (it is dispatched by
  the off-repo Cloudflare scheduler), so backup freshness is **not** under this runbook's control unless
  you dispatch it and verify.
- **Free space.** Twins + `_old` coexist ≈ 2× the hot-table size.
- **CI green on the exact SHA** you will merge at step 7. Between the stage-4 swap and the deploy going
  live, the OLD build serves 42703 against a v4 database — a hard outage, not a paused-but-healthy state.
  A failed merge build strands prod v3-code-on-v4-data.
- **Silence the off-repo jobs** for the window: `pg-backup`, `pg-staleness-check`, `pg-durable-verify`
  (Cloudflare-dispatched — `_old` retention roughly doubles hot-table counts, so durable-verify's row-count
  reference will alert), `pg-dashboard` (a `workflow_run` child of `pg-backup`, silenced as a side effect),
  and `sync-prod-to-dev.yml` (`20 */2 * * *` — the only one with a GitHub-native cron; **must stay
  disabled through BOTH the dev and prod cutovers**, not just prod's, or it writes v3-shaped rows into a
  v4 `liveone-dev` between the two). Take the backup FIRST, then silence — `pg-staleness-check` self-heals
  a missed `pg-backup` tick by re-triggering it (and Slack-alerting), so disabling `pg-backup` alone just
  gets it silently re-enabled. Concretely (all five are `workflow_dispatch`-only once disabled, so a
  `gh workflow run` on a disabled one 422s — this is by design, it proves silencing took):
  ```bash
  for w in sync-prod-to-dev.yml pg-backup.yml pg-staleness-check.yml pg-durable-verify.yml pg-dashboard.yml; do
    gh workflow disable "$w"   # ... window runs ...   gh workflow enable "$w" after
  done
  ```

0. **Capture the authz baseline — BEFORE anything else writes, ON THE STILL-DEPLOYED PRE-CUTOVER BUILD.**
   `authz-check.ts --snapshot` records each dashboard's v3 `descriptor` point-scope while the v3 resolver
   can still read the v3 `areas` columns, keyed on the int PK that stage 5c freezes into `legacy_id`.
   ⚠️ **Run it with the CURRENTLY-DEPLOYED (pre-cutover) code, not the cutover build** — the resolver reads
   the RENAMED `areas` columns, so the cutover build 42703s against the pre-transform DB and the per-area
   `catch{}` vacates the scope (Run 7 finding). In prod the cutover build is not deployed until S7, so this
   is automatic; a single-branch rehearsal must `git checkout origin/main` for this step, then transform +
   verify with the cutover branch. **After stage 2 renames `areas.display_name` this resolution is
   impossible**, so skipping this step permanently forfeits AC1 — and, worse, AC1 then passes vacuously
   (Run 4's false green). The capture refuses to persist a zero-point scope.

   ```bash
   CONFIG_V4_TARGET=prod ALLOW_PROD_DB_IN_DEV=true PLANETSCALE_DATABASE_URL="<prod url>" \
     npx tsx scripts/config-v4/authz-check.ts --snapshot --i-understand-this-is-prod
   ```

1. **Pause materialization** — `cutover-pause.ts set --env=prod --i-understand-this-is-prod`, which does
   BOTH halves: the `cutover:paused` KV flag (crons + the receiver) and the QStash **queue** pause
   (delivery). Neither alone is a pause — see defect D-h. Keep `CRONS_ENABLED=true` so pollers + the
   outbox keep buffering. Do NOT drain to zero. **Then prove it:**

   ```bash
   CONFIG_V4_TARGET=prod ALLOW_PROD_DB_IN_DEV=true PLANETSCALE_DATABASE_URL="<prod url>" \
     npx tsx scripts/config-v4/parity-check.ts --quiescence --i-understand-this-is-prod
   ```

   must go green before step 4. (Note the target mode: the scripts default to `rehearsal`, which refuses
   a prod connection. `ALLOW_PROD_DB_IN_DEV=true` is also required — `@/lib/db/planetscale` refuses a prod
   pool outside `VERCEL_ENV=production` before the guard even runs. `--env=dev` pauses KV only: dev/preview
   run with `CRONS_ENABLED` unset so `liveone-dev` never publishes, and on Vercel `NODE_ENV=production`
   even for previews, so a "dev queue" would either be unused or be prod's.)
2. **Materialize registries** — `config-transform.ts` stage 2 (calls the shared `populateRegistries`; +the
   in-window `areas` column renames): `devices` (`rid`=old `systems.id`), `points` (`id`=`point_uid`,
   `rid`=`point_info.rid`), areas carryover + areas-of-one, `primary_area_id` NOT NULL.
3. **Foundation backfill (idempotent) + freeze `legacy_handles`** — close the writer-deployment race; verify
   full coverage/uniqueness.
4. **Hot rewrite** — stage 4: build `(point_rid, time)` twins → batched JOIN-copy (15.5M + 6M) → indexes/PK/
   `NOT VALID` FKs after load → `ANALYZE` (D-e) → bounded rename-swap keeping `_old` (D-f). **No `sessions`
   rename** (see the scope audit — the transform never had one); `observations_outbox` likewise deferred to
   Phase 9 (`device_rid == system_id`, so the rename buys nothing here).
5. **Config transform** — stage 5: bindings gain a **dark `point_uid`** (the int `point_id` is untouched —
   D-i) + priority; trackers+HWS→`derivations`/`derived_intervals`; dashboards int→uuid PK swap + v3→v4
   `doc`; unified `share_tokens` (dashboard tokens 1:1 + owner-token auto-create + NOT NULL); grant reshape
   (role CHECK/`user_id`/`created_at`/composite PK).
6. **KV** — **deferred to Phase 9** (decision 1). `latest:system:*` / `subscriptions:system:*` keep integer
   handles, which stay correct because `legacy_handles` and the `?systemId=N` alias are permanent. Note the
   deferral is safe for key NAMES; the registry CONTENT is protected by D-i's decision (bindings stay
   int-keyed), not by the deferral itself.
7. **Deploy the cutover build** (DAO SQL flipped rid-keyed; dashboards uuid-native; dual-grammar
   receiver — virtual-system synthesis deletion is DEFERRED to Phase 9, see the Group B note below,
   not part of this deploy) by merging to `main`; run `parity-check.ts` + `authz-check.ts` **+ the named
   smoke set**; then `cutover-pause.ts clear` → the buffered backlog drains into the rid-keyed tables.
   **This resume is the one-way door.**

### Abort matrix — what to do when a check goes red

Reflects the config-first execution order (`1 → 2 → 5 → 5d → 4`): the config half's destructive DDL (5d) is
the **first** point of no return; the hot rename-swap (stage 4, run last) is the **terminal** one.

| Red at | Recovery |
| --- | --- |
| through stage 5c (registries / `areas` renames / additive `point_uid`, derivations, dashboard `doc`) | abort freely — `cutover-pause.ts clear`, drop the new tables/columns, rename the `areas` columns back; hot tables are still untouched |
| mid-stage-5d (destructive config DDL) | **forward-only or restore config from backup** — 5d is destructive + autocommit (and 5c cannot be re-run once `new_id` is dropped). The **hot tables are still old-shape**, so the data-serving path is unaffected |
| during the stage-4 copy, before the swap | the swap has not committed — drop the twins and re-run stage 4 (idempotent); config (5d) is already reshaped, so aborting the whole cutover means restore-from-backup |
| after the swap commits | transform complete — deploy the new build; aborting now is forward-fix only |
| after resume | forward-fix only |

## Work split (Group A / B / C)

- **Group A — DARK / mergeable before the window** _(✅ landed, #243)_. Completes the transform +
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
- **Group B0 — pre-flight, DARK / mergeable** _(✅ this batch)_. Closes D-h/D-i/D-j, gives Group C a
  sanctioned execution path, and defuses the cutover landmines that are provable no-ops today:
  - `config-transform.ts`: additive stage 5a (`point_uid`); `msToTs()` UTC-explicit epoch-ms conversion.
  - `parity-check.ts`: `--quiescence` pre-stage-4 gate; the `point_uid`/`point_id`-still-int assertions;
    the tightened `timestamp without time zone` checks + a value-level UTC re-derivation.
  - `authz-check.ts`: non-vacuity floors on AC1 and AC3 (both are set algebra over sets a regression can
    empty, resolved through a module that swallows its own failures).
  - `guard.ts`: `CONFIG_V4_TARGET=rehearsal|dev|prod` (+ `--i-understand-this-is-prod`).
  - `app/api/observations/receive/route.ts`: fail-closed `cutoverPaused()` gate;
    `scripts/config-v4/cutover-pause.ts`: the two-button pause as one command.
  - `lib/readings/dao.ts`: the three `.returning()` projections + the two window-around SELECTs moved off
    columns the cutover deletes; `DeviceRegistry.resolveHandle()` added dark.
- **Group B — the cutover BUILD (all-or-nothing, deployed in-window).** Scoped per the audit above:
  DAO internal SQL flipped to `point_rid` (`lib/readings/dao.ts` 16 point-keyed + 7 device-keyed `// SEAM:`
  sites — **plus the 6 outside `dao.ts`**: `lib/readings/prod-dev-sync.ts` ×4, `lib/readings/preview-seed.ts`
  ×2). **Every device-keyed site becomes a `points` join** — the twins carry no `system_id` and no
  per-device index (`pr_system_time_idx`/`pr5m_system_time_idx`/`pr1d_system_day_idx` are not recreated),
  so each needs an `EXPLAIN (ANALYZE, BUFFERS)` on the 15.5M-row twin. Then: the `areas` 3 column renames;
  dashboards uuid-native incl. the client surface (decision 4); unify `lib/dashboard/sharing.ts` onto
  `share_tokens` + narrow `lib/dashboard/grants.ts` to admin/viewer; delete virtual-system synthesis
  (`synthesizeAreaView`/`getViewableSystem`/`isAreaHandle`/`AREA_HANDLE_BASE`) via `resolveHandle` — **decide
  D-l's handle-13 precedence here; it is a silent 6-point scope change, not a refactor**; extend
  the area-of-one parity test; DAO-equivalence sweep.
  **Explicitly OUT (→ Phase 9):** the `systems`→`devices` code rename, the KV keyspace move, the
  `user_systems`/`isViewer` drop, the `sessions`/`outbox` column renames.

  **Progress — branch `simonhac/config-v4-group-b-v2` — BUILD DONE + VALIDATED (2026-07-26).** All of
  Group B is built and green, on top of the `areas` renames (`c4f2e8e0`, also the fix for Run 5's AC1
  "lockout": `fetchAreaByHandle` used a projection-less `.select()`):
  - **`09838094` dashboards + sharing/grants uuid-native** — all `db_↔uuid` translation confined to the
    DAO seam via a new codec primitive `EntityCodec.toUuidOrNull` (routes/pages/components pass an opaque
    handle, never touch `lib/ids`); legacy owner-scoped share tokens retired; `/dashboard/id/{n}` → 308.
  - **`45cc9e2f` DAO rid-flip** — 23 `// SEAM:` sites + the 6 external → `point_rid` twins.
  - **`c5b8b626` parity NOT-NULL alignment** — `dashboards.doc`/`areas.day_offset_min`/
    `devices.primary_area_id` (the mint mirror already supplies the latter two; `createDashboard` now
    builds the doc via `rewriteV3ToV4`).
  - **Synthesis deletion (Item D) — DEFERRED to Phase 9** (device-first is already the status quo; see
    the D-l row) — so the "decide D-l precedence" work above is moot for Group B.
  - **Run 7 (today's prod restore): parity 61/61 · authz-check 13/13 · DAO-equivalence 215/215 · window
    ✅ GO.** A new `dao-equivalence` sweep (the sweep noted above) validated the rid-flip point- and
    device-keyed. Each `type-check` + full unit suite (1224) + `build:local` green.
  - ⚠️ **This branch must not reach `main` before the window** — `schema.ts` names post-transform columns.
  - **Pending before the window:** device-keyed `EXPLAIN (ANALYZE,BUFFERS)` on the twin (Run 7's ad-hoc
    equivalence sweep was slow due to sequential round-trips, not a bad plan — confirm during the dev
    dress-rehearsal); rebase onto current `main` (drops the #246-duplicate commits).
- **Group C — the WINDOW (ops).** Schedule; run the ordered steps above; `liveone-dev` first, prod next day.

## Verification

**Runs 8 (dev) and 9 (prod) — THE REAL WINDOW, DONE (2026-07-26).** Group C executed both cutovers
in one session (dev dress rehearsal, then prod the same day). Full detail in
[config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md) §§ Run 8/9. Headline:

- **Run 8 (dev):** transform 246.0s · parity 61/61 · authz-check 13/13 · window GO. Found and fixed a
  **29s device-keyed query regression** the rid-flip introduced (`lib/readings/dao.ts`, commit
  `bb58dbe5`) — the twins don't recreate `pr5m_system_time_idx`, so the two `ORDER BY interval_end DESC
  LIMIT 1` device-keyed seams walked the global time index backwards for a stale device (29.5s /
  3.08M rows). Rewritten as a per-rid `LATERAL` against the existing PK: 66ms (~39,000×), no new index
  needed. Also fixed a latent bug in `lib/kv.ts` (commit `2d304dab`) where KV credentials were resolved
  at import time — before `dotenv.config()` runs in every `scripts/config-v4/*` driver's body — so
  `cutover-pause.ts clear` could silently no-op and report `✅ LIVE` while the cutover flag stayed set.
  Named smoke set (6/6) all green, run locally (`npm run dev` against transformed `liveone-dev` — the
  Vercel preview sits behind SSO deployment protection with no bypass secret).
- **Run 9 (prod):** transform 263.1s · authz-check 13/13 (both pre- and post-deploy) · window GO
  (13.2 min ≤ 30). **Parity 60/61** — one deviation, root-caused and reproduced: `device_state content
  == polling_status` cannot pass in a LIVE window, because the pause deliberately gates only
  materialization crons, not pollers (by design), so `polling_status` keeps ticking while
  `device_state` is a periodic batch snapshot with zero live readers/writers in the deployed code.
  Every rehearsal ran on an idle DB (no pollers), so this never surfaced before Run 9; it's a
  structural gap in that one parity assertion, not a data-loss defect — every content checksum
  (point_readings/agg_5m/agg_1d) was clean. Deploy = PR
  [#248](https://github.com/simonhac/LiveOne/pull/248), squash-merged, Vercel prod READY in 53s. Named
  smoke set (6/6, see below) green against `www.liveone.energy` with a real prod Clerk session and real
  prod QStash signing keys. Resumed (`cutover-pause.ts clear --env=prod`); backlog (outbox depth 222 at
  resume) drained to steady-state within ~2 minutes, confirmed by `point_readings`/`agg_5m` freshness
  tracking `now()` within seconds, sustained.
- **Operational finding — prod DDL needs a role that inherits `postgres`, not the app's own pooled
  connection.** `registry-sync.ts`/`config-transform.ts` do DDL (`ALTER TABLE … SET NOT NULL`, column
  renames); the app's `pscale_api_lmkcwljm7fcb` role 42501'd with "must be owner of table areas".
  Minted a TTL-bounded `pscale role create liveone sydney <name> --inherited-roles postgres --ttl 3h`
  for each DDL step; did NOT use `pscale role reset-default` (rotates the shared `postgres` password,
  risking backup credentials mid-window). **Nuance on the CLAUDE.md ownership-trap warning:** the app
  reaches all tables via `pg_read_all_data`/`pg_write_all_data` role MEMBERSHIP, not per-table
  ownership or grants (`information_schema.role_table_grants` on `point_readings` is empty) — so a
  temp-role-owned twin table does NOT lock the app out; the residual risk is purely that a future
  `postgres`-run migration hits "must be owner" until the temp role is reassigned
  (`pscale role reassign … --successor postgres --force`) and deleted.
- **Post-cutover:** `sync-prod-to-dev.yml` re-enabled and manually triggered to verify — failed with a
  new, real defect: `users.default_dashboard_id` FK violation, because `dashboards.id` is now
  `gen_random_uuid()`-minted independently per environment (only `legacy_id` is stable cross-env). Not
  caught by any single-environment rehearsal. Tracked as a Phase 9 follow-up in the execution plan
  (not a Group C blocker — prod itself is unaffected; only the dev-mirror config-table sync leg is
  blocked until fixed).

**Run 7 — DONE (2026-07-26), full Group-B build in: parity 61/61 · authz-check 13/13 · DAO-equivalence
215/215 · window ✅ GO (5.3 min × 3 = 15.9 min).** Every Run-5 red is now green: the 4 W-series
(schema.ts flipped) + the 3 AC1-vacuity reds. The rid-flip is validated by a new `dao-equivalence` sweep
(`scripts/temp/dao-equivalence.ts`, gitignored): the flipped DAO's point- and device-keyed reads ==
independent twin reads keyed on each point's real rid (which, with parity's twin==`_old` checksums, proves
the flip preserves the pre-flip semantics). Item D (synthesis deletion) is deferred, so D-l does not fire.

> **Run-7 RUNBOOK FINDING — capture the AC1 snapshot on the PRE-CUTOVER build.** `authz-check --snapshot`
> resolves the v3 descriptor leg through `resolveDashboardReadPoints` → `getViewableSystem` → the AREA path,
> which reads the RENAMED `areas` columns. Run from the CUTOVER branch against a pre-transform DB, those
> columns don't exist → 42703 → `access.ts`'s per-area `catch{}` vacates the scope (the area-path dashboards
> resolve to 0 → the non-vacuity guard refuses). The real window is immune because **step 0 runs on the
> still-deployed prod (pre-cutover) build**, before the cutover build deploys at S7. A single-branch
> rehearsal must therefore `git checkout origin/main` for step 0 (main-code snapshot = 62 points,
> non-vacuous), then transform + verify with the cutover branch. Add this to the ordered steps' step 0.

**Run 5 — DONE (2026-07-26): parity 48/52 · authz 10/13 · window ✅ GO · D-f finally exercised.** Full
detail in [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md). The config-first
reorder is verified (`stage5` completes before `stage4` begins) and `T_window` = 5.4 min × 3 = 16.1 min.
The reds are **not** transform defects — all seven are the same root cause, *v3 code reading a v4 database*:

- **4 parity W-series reds** = `areas.name`, `dashboards.owner_user_id`, `dashboard_grants.created_at`+`user_id`,
  `share_tokens.dashboard_id`. All in the FORCED column of the scope audit. **This is Group B's `schema.ts`
  definition-of-done: the suite must read 52/52 once the model + writers are flipped.**
- **3 authz AC1 reds (vacuity)** = AC1 resolves the v3 `descriptor` leg through live code *after* the
  transform renamed `areas.display_name`→`name`; drizzle 42703s and `access.ts`'s per-area `catch {}` swallows
  it, so the scope is empty. **This retroactively invalidates Run 4's AC1 "9/9"** — without the Group-B0
  non-vacuity floor, "descriptor ⊆ doc" passed trivially over an empty set. **Required harness fix (do before
  the window): snapshot the descriptor scope BEFORE the transform and compare against the post-transform doc
  scope.** Until then AC1 is INCONCLUSIVE, not a pass. AC2a–d and AC3 are green and unaffected.

**Group A acceptance gate — PASSED (Run 4: parity 36/36 · authz 9/9 · window GO)** *(AC1 now known vacuous —
see Run 5).* Recorded in
[config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md). Group B0 changes what the
transform does and what the suite can catch, so **Run 5 re-runs the whole gate against a CURRENT prod
backup** on a fresh PS-5 branch: `backfill-foundation` → `config-transform` → `parity-check` →
`authz-check` → `window-report`. Hold an open reader (`BEGIN; SELECT count(*) FROM point_readings;`)
across the stage-4 swap — the D-f bounded-retry path has never been exercised; if the swap wins on the
first attempt the reader was not held and D-f is still unrehearsed.

**Named smoke set — required before the prod window,** on a preview bound to the transformed branch. Every
gate above proves DATA or SET ALGEBRA; none proves the deployed CODE reads that data correctly. In
particular `authz-check` never imports `lib/dashboard/grants.ts` or `lib/dashboard/sharing.ts`, so it
certifies the fold, not the access path. "Walk every page" is not a gate — this list is:

| Route | Catches |
| --- | --- |
| `/api/data?systemId=` for a device handle **and** a multi-device-area handle | `area_bindings`, handle resolution (D-l device-first — synthesis deletion is deferred to Phase 9, so this exercises today's already-device-first path, not a deletion) |
| `/admin/systems/{id}/point-readings` | `readAdminPivot` — whose unit test cannot fail (the fake ignores SQL) |
| `/api/admin/point/{sys}.{pt}/readings` | the dropped `pr.id`/`system_id`/`point_id` projections |
| `/api/history`; a granted-dashboard SSR load; a share-token SSR load | `grants.ts`/`sharing.ts` |
| `/api/system/{id}/points` + `/series`; `/dashboard/id/{n}` | the `requireSystemAccess` collapse, `legacy_id` routing |
| one old-grammar `{systemId}.{pointIndex}` observation POSTed to the receiver | the dual-grammar backlog drain |

**Run 8 (dev, 2026-07-26) — all 6 rows green**, driven locally (`npm run dev` against the transformed
`liveone-dev`; the Vercel preview is behind SSO deployment protection with no bypass secret, so it
couldn't be driven headlessly). Auth via a real Clerk session JWT (`get-test-token.ts`) + real
`?access=` share tokens; the dual-grammar row used a genuinely HS256-signed QStash JWT (Development-scope
signing key) POSTed to the local receiver — `{rawInserted:1}`, verified in `point_readings` by
`point_rid`, then deleted.

**Run 9 (prod, 2026-07-26) — all 6 rows green** (plus the owner-dashboard-SSR substitute below), driven
against `www.liveone.energy` with a real prod Clerk session (`get-test-token.ts` against the prod
Clerk instance — reuses an existing session, does not create one) and real prod QStash signing keys.
One substitution: prod had **zero** `dashboard_grants` rows at cutover time (dev's test grants don't
exist in prod), so the granted-dashboard row was covered by an owner-dashboard SSR load instead (same
DAO/access path, minus the grant-specific branch — the grant branch itself was only exercised in Run
8). The dual-grammar row got a real signed JWT that correctly hit the still-armed pause gate
(`500 cutover_paused` — not a signature error, proving the key AND the fail-closed gate both work) since
prod was paused at test time; the resolution logic itself was already proven end-to-end in Run 8.
Confirmed `/api/data?systemId=13` resolves `vendorType:"sigenergy"` (the device) — **D-l device-first
verified live in production**, not just on a rehearsal branch.

**Window-report's `W_target` (30 min) is the TRANSFORM ONLY** — `T_window` in the timing ledger. It does
NOT include the quiescence gate (a fixed ~5-min floor: `2 × CONFIG_V4_QUIESCE_SEC`), S0's snapshot, or
S7's deploy/verify/smoke — all of which sit inside the real paused window. Run 9's actual pause ran
longer than the 4.4-min `T_window` alone; budget the whole runbook, not just the transform, against any
outage-duration target.

**Honesty ledger.** `liveone-dev` has no crons and no pollers (`CRONS_ENABLED` unset), so the dev cutover
rehearses the DEPLOY and the RUNBOOK — **not** pause/resume mechanics, outbox-backlog drain at volume, the
C7 mid-window mint, or planner behaviour under live load. Those are first exercised in the prod window.
Saying "dev cut over fine" about a database that never ingested a row during the window would be exactly
the false-green this project already paid for once.
