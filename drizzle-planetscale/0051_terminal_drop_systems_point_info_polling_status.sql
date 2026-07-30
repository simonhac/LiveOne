-- 0051 config-v4 Phase 12 — THE TERMINAL WINDOW. Two renames, then three tables die.
--
-- ============================================================================================
-- 🛑 THIS MIGRATION IS IRREVERSIBLE. There is no rollback and no forward migration that undoes it.
--
--   * `polling_status` and `point_info` hold values that are NOT RECONSTRUCTIBLE from the surviving
--     schema. `polling_status` is a frozen snapshot of pre-slice-C poll health with no live equivalent
--     (`device_state` was populated forward, not backfilled); `point_info`'s `(system_id, id)` composite
--     ADDRESS has no home in `points` at all. If you need either back, you need the backup.
--   * `systems` is the one exception in principle — every column has a `devices` counterpart — but
--     nothing in this migration copies it, so in practice it is the backup for that too.
--
-- RECOVERY PATH: PlanetScale PITR (12h-keep-2d immutable + 3-day-keep-6mo) plus the 2-hourly `pg_dump`
-- shipped off-site to R2 by the `pg-backup` GitHub Action. Take a one-off `pscale backup create` on
-- `sydney` and CONFIRM the PITR window before applying. There is no cheaper undo.
-- ============================================================================================
--
-- 🛑 DEPLOY THE CODE FIRST. This is a `[D]` slice and it follows the project's NORMAL drop rule, unlike
-- 0050 (which inverted it, because relaxing a constraint is safe ahead of its code). A projection-less
-- `.select()` expands to the columns declared in the RUNNING build, so `sessions.system_id` must already
-- be gone from the deployed build before this renames it. Order:
--
--      1. `pscale backup create` on `sydney`; confirm PITR. Disable the prod->dev sync workflow.
--      2. Pause the QStash queue (`POST /api/admin/observations/info {"action":"pause"}`).
--      3. Run the pre-flight gates (the same predicates the DO block below re-asserts).
--      4. MERGE + DEPLOY the terminal build. Confirm `/api/health` 200 and the deploy aliased.
--      5. Apply THIS migration to prod `sydney`.
--      6. Post-check the CATALOG (not the migrate output — see the note below).
--      7. Resume the queue at parallelism 1, watch one message land, then restore parallelism.
--      8. Apply to `liveone-dev`, re-post-check, re-enable the sync workflow.
--
-- Keep 4 -> 5 under ~10 minutes. During that skew `persistOutbox` fails (the new build writes
-- `device_rid` before the column exists) and is DELIBERATELY swallowed — the direct QStash enqueue is
-- independent and the paused queue buffers it. Confirm the queue `lag` is still CLIMBING; a flat lag
-- means the direct leg is failing too, which is an abort. `CRONS_ENABLED` stays `true` throughout: the
-- one unrecoverable loss path here is STOPPED POLLERS, because vendors serve _latest_, not history.
--
-- 🛑 A MISSING MIGRATION FILE LOOKS IDENTICAL TO A SUCCESSFUL APPLY. `db:pg:migrate` run from a tree that
-- does not contain this file prints "migrations applied successfully" and does nothing at all — and on a
-- branch whose journal already carries the entry it does the same. Only the CATALOG distinguishes the two.
-- After applying, check the three `to_regclass` values and the new FK's `convalidated`, never the
-- migrator's exit line. Related: `db:pg:migrate` swallows `RAISE NOTICE`, so every advisory below is
-- invisible in its output — capture the inventories BY HAND, before you apply, or the record is lost.
--
-- ## What changes
--
-- (1) `sessions.system_id` -> `device_rid`, plus a replacement FK -> `devices.rid`. `devices.rid` IS the
--     old `systems.id`, verbatim and asserted at three independent points, so the rename is CATALOG-ONLY:
--     no backfill, no rewrite. The FK is added `NOT VALID` and then `VALIDATE`d as a separate statement,
--     which is the whole reason for splitting it: `ADD CONSTRAINT` alone takes `ACCESS EXCLUSIVE` but
--     validates nothing, and `VALIDATE CONSTRAINT` then scans the ~10^6 rows under
--     `SHARE UPDATE EXCLUSIVE`, which blocks neither reads nor writes. Adding it validated would hold
--     `ACCESS EXCLUSIVE` for the whole scan and stall the ingest path.
--
--     ⚠️ A `RENAME COLUMN` does NOT rename the indexes over the column, so `sessions_system_idx` is
--     renamed BY HAND below. `outbox_session_seq_unique` is deliberately left alone: its name references
--     no column. `schema.ts` matches both decisions — leaving either side alone ships permanent
--     `db:pg:generate` drift. (Index DEFINITIONS follow a column rename automatically, which is why the
--     partial unique needs no DDL at all; drizzle-kit's machine diff wanted to drop and recreate it, and
--     that was removed from this body as unnecessary churn on a live index.)
--
-- (2) `observations_outbox.system_id` -> `device_rid`. **NO FK, and none is to be added.** An outbox is a
--     BUFFER: an FK there turns a device delete into an ingest-path failure, and a stale published row
--     for a since-deleted device would become a migration blocker. This is why the outbox reachability
--     gate below is ADVISORY.
--
-- (3) `DROP TABLE polling_status`, then `point_info`, then `systems` — in FK order, and **no `CASCADE` on
--     any of them** (the 0041 lesson: an unexpected dependent must ABORT the migration, not vanish
--     silently). drizzle-kit's machine diff emitted `CASCADE` on all three; that is precisely the
--     behaviour this file exists to refuse. It also emitted three `DISABLE ROW LEVEL SECURITY` statements
--     for tables that never had RLS — removed as noise.
--
-- (4) `setval` floors for `device_rid_seq` and `point_rid_seq`, LAST, after every guard. `setval` is NOT
--     transactional (the 0043 lesson), so a stranded one must be a harmless no-op — which a
--     `greatest(…, last_value)` floor is by construction: it can only move a sequence forward.
--     `device_rid_seq` becomes the SOLE allocator of device handles the moment `systems_id_seq` dies with
--     its table, so this floor is load-bearing rather than a re-assert of 0049's. `point_rid_seq` is
--     expected to be a NO-OP (`points.rid`'s DEFAULT has been the sole point allocator since slice M) and
--     is re-floored only so both sequences are provably above their tables at the same instant.
--
-- ## Preconditions read the CATALOG, never the drizzle journal
--
-- The journal records INTENT; the catalog records what is true of THIS branch. Every check below is a
-- `pg_catalog` lookup or a live row count, inside ONE `DO` block with `RAISE EXCEPTION` — the only form of
-- validation that cannot be raced between probe and apply. Constraint names are unique PER TABLE, not per
-- schema (the 0044 lesson), so every constraint lookup is `conrelid`-scoped.
--
-- ## The gates, and why three of them are asymmetric
--
-- 🛑 **G2 is ASYMMETRIC, deliberately.** `systems`-without-`devices` is a HARD ABORT: it means a handle
-- exists that no device row claims, so the drop would destroy the only record of it.
-- `devices`-without-`systems` is REPORTED ONLY: that is `DeviceWriter.deleteSystem`'s sanctioned orphan
-- (it deletes the `systems` row and leaves the `devices` row standing), and every device created since
-- slice 1a is one by construction. A symmetric check here would abort the window on a benign row.
--
-- 🛑 **The `observations_outbox` reachability leg is ADVISORY, not gating.** That column has no FK and
-- none is added, so the rename CANNOT fail on it. A stale published row belonging to a since-deleted dev
-- system must not abort the window.
--
-- 🛑 **The `point_info` <-> `points` parity gate is DIRECTIONAL, because the two directions mean opposite
-- things.** `points` is the AUTHORITY (slice M made it primary; slice 1b moved every reader onto it).
--
--   * `point_info`-without-`points` -> HARD ABORT. That point's identity has no home in the surviving
--     table, so the drop destroys it. It is also the standing C7 hole: `point_readings` carries
--     `FK point_rid -> points(rid)`, so such a point's first reading fails to materialise and is retried
--     by QStash forever.
--   * `points`-without-`point_info` -> REPORTED ONLY. That is the DESIGNED END STATE, and not merely
--     tolerated: because the code deploys at step 4 and this migration applies at step 5, with
--     `CRONS_ENABLED` true throughout, a point minted in that window is `points`-only BY CONSTRUCTION.
--     A symmetric check would abort on exactly the rows the correct sequence produces.
--   * COLUMN DRIFT across the joined pairs -> REPORTED ONLY, for the same reason. From the step-4 deploy
--     onward `updatePoint` and battery-provenance's rename write only `points`, so a stale `point_info`
--     row is the expected result of the deploy, not a fault. Nothing reads `point_info`, and it is about
--     to cease to exist. Measured 134 pairs / 0 / 0 with zero drift on prod 2026-07-30, pre-deploy.
--
-- `sessions` reachability IS gating, in one direction: every `sessions.system_id` must resolve to a
-- `devices.rid`, because the new FK enforces exactly that and `VALIDATE CONSTRAINT` would otherwise fail
-- partway through an irreversible migration.
--
-- `systems.status` conformance IS gating: `systems.status` is unconstrained `text` while `devices.status`
-- carries `devices_status_check IN ('active','disabled','removed')`, so a non-conforming value is one
-- that CANNOT move. Nothing here copies it, which is the point — a non-conforming value means there is
-- state on this branch the surviving schema cannot express, and a human should see it before it is gone.
--
-- Not idempotent, and deliberately not: it drops tables. The journal is what prevents a second run. To
-- re-check a branch, run the gate predicates by hand as plain `SELECT`s.
--
-- See docs/plans/config-v4-execution-plan.md § "The collapsed terminal window".

-- ── Gates. All of them, before anything is touched. ──────────────────────────────────────────
DO $$
DECLARE
  n_sys_no_dev      bigint;
  n_dev_no_sys      bigint;
  n_sess_unresolved bigint;
  n_outbox_unres    bigint;
  n_pi_no_points    bigint;
  n_points_no_pi    bigint;
  n_pairs           bigint;
  n_drift           bigint;
  n_bad_status      bigint;
  n_fk_into_systems bigint;
  n_fk_into_pi      bigint;
  n_fk_into_ps      bigint;
  n_devices         bigint;
  max_device_rid    bigint;
  max_point_rid     bigint;
  sess_rows         bigint;
BEGIN
  -- 0. The three doomed tables must still exist, and neither rename may have happened. Together these
  --    prove the migration is being applied to the state it was written against — the CATALOG saying so,
  --    not the journal.
  IF to_regclass('public.systems') IS NULL
     OR to_regclass('public.point_info') IS NULL
     OR to_regclass('public.polling_status') IS NULL THEN
    RAISE EXCEPTION '0051: one or more of systems/point_info/polling_status is already gone (systems=%, point_info=%, polling_status=%) — already applied to this branch, or applied out of order',
      to_regclass('public.systems'), to_regclass('public.point_info'), to_regclass('public.polling_status');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.sessions'::regclass
                    AND attname = 'system_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0051: sessions.system_id is missing — already renamed to device_rid?';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.sessions'::regclass
                AND attname = 'device_rid' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0051: sessions.device_rid already exists — a partial apply; reconcile this branch by hand';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.observations_outbox'::regclass
                    AND attname = 'system_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0051: observations_outbox.system_id is missing — already renamed?';
  END IF;

  -- 1. Exactly ONE foreign key may still point INTO `systems`, and it must be polling_status'. 0050
  --    dropped the `point_info` and `sessions` ones. Any OTHER FK is an unexpected dependent, and the
  --    whole reason these drops carry no CASCADE is that such a thing must abort rather than vanish.
  SELECT count(*) INTO n_fk_into_systems
  FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.systems'::regclass;

  IF n_fk_into_systems <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE contype = 'f'
                       AND confrelid = 'public.systems'::regclass
                       AND conrelid  = 'public.polling_status'::regclass) THEN
    RAISE EXCEPTION '0051: expected exactly 1 FK into systems (polling_status''), found % — an unexpected dependent must be understood before systems is dropped, not CASCADEd away',
      n_fk_into_systems;
  END IF;

  SELECT count(*) INTO n_fk_into_pi
  FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.point_info'::regclass;
  SELECT count(*) INTO n_fk_into_ps
  FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.polling_status'::regclass;

  IF n_fk_into_pi <> 0 OR n_fk_into_ps <> 0 THEN
    RAISE EXCEPTION '0051: expected ZERO FKs into point_info and polling_status, found point_info=%, polling_status=% — 0047 dropped the last point_info FK; an unexpected dependent must abort',
      n_fk_into_pi, n_fk_into_ps;
  END IF;

  -- 2. G2 — identity proof, ASYMMETRIC. See the header.
  SELECT count(*) INTO n_sys_no_dev
  FROM systems s WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = s.id);

  IF n_sys_no_dev <> 0 THEN
    RAISE EXCEPTION '0051: % systems row(s) have no devices.rid — dropping systems would destroy the only record of those handles. Mirror them into devices first',
      n_sys_no_dev;
  END IF;

  SELECT count(*) INTO n_dev_no_sys
  FROM devices d WHERE NOT EXISTS (SELECT 1 FROM systems s WHERE s.id = d.rid);
  -- REPORTED ONLY. `deleteSystem`'s sanctioned orphan, plus every device created since slice 1a.
  RAISE NOTICE '0051 G2: systems-without-devices = 0 (gated); devices-without-systems = % (expected, NOT gated)',
    n_dev_no_sys;

  SELECT count(*) INTO n_devices FROM devices;
  IF n_devices = 0 THEN
    RAISE EXCEPTION '0051: devices is EMPTY — the registry is not populated; refusing to drop systems';
  END IF;

  -- 3. Every `sessions` row must resolve to a `devices.rid`. GATING: the FK added below is exactly this
  --    predicate, and `VALIDATE CONSTRAINT` would otherwise fail partway through an irreversible
  --    migration. This is an index-assisted anti-join against devices_rid_unique, not a parity scan.
  SELECT count(*) INTO n_sess_unresolved
  FROM sessions se WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = se.system_id);

  IF n_sess_unresolved <> 0 THEN
    RAISE EXCEPTION '0051: % sessions row(s) do not resolve to a devices.rid — the new FK (sessions.device_rid -> devices.rid) cannot be validated. Re-point or delete them first',
      n_sess_unresolved;
  END IF;

  -- 4. Outbox reachability — ADVISORY ONLY. No FK exists here and none is added, so the rename cannot
  --    fail on it, and a stale published row for a deleted dev system must not abort the window.
  SELECT count(*) INTO n_outbox_unres
  FROM observations_outbox o WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = o.system_id);
  RAISE NOTICE '0051: observations_outbox rows not resolving to a devices.rid = % (ADVISORY — no FK here, and none is added)',
    n_outbox_unres;

  -- 5. `point_info` <-> `points`. DIRECTIONAL: `points` is the authority. See the header for why only one
  --    direction can be gated once the code has deployed ahead of this migration.
  SELECT count(*) INTO n_pi_no_points
  FROM point_info pi WHERE NOT EXISTS (SELECT 1 FROM points p WHERE p.id = pi.point_uid);

  IF n_pi_no_points <> 0 THEN
    RAISE EXCEPTION '0051: % point_info row(s) have no points row — dropping point_info would destroy those points. This is also the standing C7 hole (their readings fail FK point_rid -> points(rid) and are retried by QStash forever)',
      n_pi_no_points;
  END IF;

  SELECT count(*) INTO n_points_no_pi
  FROM points p WHERE NOT EXISTS (SELECT 1 FROM point_info pi WHERE pi.point_uid = p.id);

  SELECT count(*) INTO n_pairs
  FROM point_info pi JOIN points p ON p.id = pi.point_uid;

  -- Full-column drift across the joined pairs, INCLUDING rid and the device linkage. Advisory: from the
  -- step-4 deploy onward the edit paths write only `points`, so a stale copy here is expected.
  SELECT count(*) INTO n_drift
  FROM point_info pi
  JOIN points p  ON p.id = pi.point_uid
  JOIN devices d ON d.id = p.device_id
  WHERE p.rid           <> pi.rid
     OR d.rid           <> pi.system_id
     OR p.physical_path IS DISTINCT FROM pi.physical_path_tail
     OR p.logical_path  IS DISTINCT FROM pi.logical_path_stem
     OR p.metric_type   IS DISTINCT FROM pi.metric_type
     OR p.unit          IS DISTINCT FROM pi.metric_unit
     OR p.name          IS DISTINCT FROM pi.display_name
     OR p.default_name  IS DISTINCT FROM pi.point_name
     OR p.subsystem     IS DISTINCT FROM pi.subsystem
     OR p.transform     IS DISTINCT FROM pi.transform
     OR p.active        IS DISTINCT FROM pi.active;

  RAISE NOTICE '0051 point parity: % pairs, point_info-without-points = 0 (gated), points-without-point_info = % (expected end state), column drift = % (both ADVISORY)',
    n_pairs, n_points_no_pi, n_drift;

  -- 6. `systems.status` must be a value the surviving schema can express. GATING — see the header.
  SELECT count(*) INTO n_bad_status
  FROM systems WHERE status IS NULL OR status NOT IN ('active', 'disabled', 'removed');

  IF n_bad_status <> 0 THEN
    RAISE EXCEPTION '0051: % systems row(s) carry a status outside devices_status_check (active/disabled/removed) — that value cannot be represented after the drop',
      n_bad_status;
  END IF;

  -- 7. Sequence sanity, checked HERE so the (non-transactional) setvals at the end cannot be reached
  --    unless the tables they floor against are sane. The >= 1,000,000 band is AREA_HANDLE_BASE
  --    (lib/areas/handles.ts): a device rid inside it would mean the two allocators have already
  --    collided, which is a pre-existing corruption to diagnose, not to cement into a sequence.
  SELECT coalesce(max(rid), 0) INTO max_device_rid FROM devices;
  SELECT coalesce(max(rid), 0) INTO max_point_rid  FROM points;

  IF max_device_rid <= 0 OR max_device_rid >= 1000000 THEN
    RAISE EXCEPTION '0051: max(devices.rid) = % is outside the sane device band (1 .. 999999)', max_device_rid;
  END IF;
  IF max_point_rid <= 0 THEN
    RAISE EXCEPTION '0051: max(points.rid) = % is not positive — points looks empty or corrupt', max_point_rid;
  END IF;

  -- Planner estimate, not COUNT(*): `sessions` is the second-biggest table on the branch and an exact
  -- count buys nothing here. For the record only (and swallowed by the migrator — capture it by hand).
  SELECT n_live_tup INTO sess_rows FROM pg_stat_user_tables WHERE relname = 'sessions';
  RAISE NOTICE '0051 pre-check OK: % devices (max rid %), max(points.rid) %, sessions ~% rows',
    n_devices, max_device_rid, max_point_rid, coalesce(sess_rows, -1);
END $$;
--> statement-breakpoint

-- ── (1) sessions: rename the column, rename its index, then constrain in two steps. ──────────
ALTER TABLE "sessions" RENAME COLUMN "system_id" TO "device_rid";--> statement-breakpoint
-- A RENAME COLUMN leaves index NAMES alone. `schema.ts` declares `sessions_device_rid_idx`, so without
-- this the branch carries permanent `db:pg:generate` drift.
ALTER INDEX "sessions_system_idx" RENAME TO "sessions_device_rid_idx";--> statement-breakpoint
-- NOT VALID: catalog-only, `ACCESS EXCLUSIVE` for microseconds. It enforces every SUBSEQUENT write
-- immediately; it simply does not scan the existing rows.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_rid_devices_rid_fk"
  FOREIGN KEY ("device_rid") REFERENCES "public"."devices"("rid")
  ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
-- The scan, under `SHARE UPDATE EXCLUSIVE` — blocks neither reads nor writes. Gate 3 has already proven
-- it cannot fail. Post-check `convalidated` in the catalog: a `NOT VALID` constraint that was never
-- validated looks identical to a valid one everywhere except `pg_constraint.convalidated`.
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_device_rid_devices_rid_fk";--> statement-breakpoint

-- ── (2) observations_outbox: rename ONLY. No FK — an outbox is a buffer. ─────────────────────
-- `outbox_session_seq_unique` needs no DDL: its DEFINITION follows the column rename automatically, and
-- its NAME references no column, so it is correct on both counts afterwards.
ALTER TABLE "observations_outbox" RENAME COLUMN "system_id" TO "device_rid";--> statement-breakpoint

-- ── (3) The drops, in FK order, and NO CASCADE on any of them. ───────────────────────────────
-- polling_status first: it holds the last FK into `systems`, so dropping it is what releases `systems`.
-- Without CASCADE an unexpected dependent raises `2BP01 … other objects depend on it` and aborts the
-- whole transaction — which is the desired outcome. Gate 1 has already proven there is none.
DROP TABLE "polling_status";--> statement-breakpoint
DROP TABLE "point_info";--> statement-breakpoint
DROP TABLE "systems";--> statement-breakpoint

-- ── (4) The sequence floors. LAST, after every guard, because setval is not transactional. ───
-- `device_rid_seq` is now the SOLE allocator of device handles: `systems_id_seq` died with its table
-- above, so `devices.rid`'s DEFAULT is the only thing issuing them. `greatest(…, last_value)` makes this
-- a pure floor — it can only move forward, so a run stranded by a later failure is a no-op, and a re-run
-- writes the value the sequence already holds.
SELECT setval(
  'device_rid_seq',
  greatest(
    (SELECT coalesce(max(rid), 0) FROM devices),
    (SELECT last_value FROM device_rid_seq)
  ),
  true
);--> statement-breakpoint
-- Expected to be a NO-OP: `points.rid`'s DEFAULT has drawn from this sequence as the sole point allocator
-- since slice M, so `last_value` should already be >= max(points.rid). Re-floored anyway so both
-- sequences are provably above their tables at the same instant, and because a no-op costs nothing.
SELECT setval(
  'point_rid_seq',
  greatest(
    (SELECT coalesce(max(rid), 0) FROM points),
    (SELECT last_value FROM point_rid_seq)
  ),
  true
);
