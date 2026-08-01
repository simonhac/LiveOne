-- 0050 config-v4 Phase 12 (slice 1a): `point_info.system_id` and `sessions.system_id` drop their
-- foreign keys into `systems`.
--
-- WHAT DIES: exactly two constraints — `point_info_system_id_systems_id_fk` and
-- `sessions_system_id_systems_id_fk`. No columns, no data, no indexes. Both columns stay exactly as
-- they are, NOT NULL and fully populated; only the referential constraint goes.
--
-- WHY THIS IS NEEDED (and it is not a tidy-up — without it, slice 1a breaks production). Slice 1a
-- converts the last four `systems` writers to write `devices` + `areas`, so from the moment it deploys a
-- newly created device has NO `systems` row at all. Both of these FKs then fire on the very next write
-- against that device:
--
--   * `point_info.system_id -> systems.id` — minting the device's first point raises
--     `23503 … Key (system_id)=(10005) is not present in table "systems"`, so a newly onboarded device
--     can never acquire a point, and therefore can never collect data.
--   * `sessions.system_id -> systems.id` — WORSE, because this is the HOT INGEST path
--     (`app/api/observations/receive/route.ts`): the first session write for a new device 23503s too.
--
-- This was found by DRIVING a create against `liveone-dev`, not by reading the tree — `tsc` cannot see a
-- database constraint, and both failures are invisible until a device is actually created. The wider
-- structural fact is worth recording: **"stop writing `systems`" and "the FKs into `systems`" are ONE
-- atomic change.** That is why the execution plan originally bundled the whole terminal window into a
-- single migration; splitting the code out is only possible because this relaxation goes first.
--
-- WHY IT IS SAFE: dropping a foreign key is catalog-only and instant (no table rewrite, no validation
-- scan, an `ACCESS EXCLUSIVE` lock held for microseconds), it is non-destructive, and it is a
-- RELAXATION — it cannot break code that is already running, because every statement that satisfied the
-- constraint still satisfies its absence. Note the asymmetry with the usual rule: this is the one shape
-- of DDL that is safe to apply BEFORE its code.
--
-- 🛑 APPLY ORDER IS INVERTED FROM THE PROJECT'S NORMAL DROP RULE — READ THIS. The standing rule is
-- "for a DROP, deploy the code that stops referencing the thing FIRST" (learned by breaking prod during
-- 0037). That rule is about dropping COLUMNS, where a projection-less `.select()` in the running build
-- expands to columns that no longer exist. It does not apply to relaxing a CONSTRAINT. Here the order is
-- the reverse, and it must be:
--
--      1. apply 0050 to prod `sydney`
--      2. apply 0050 to `liveone-dev`
--      3. THEN merge + deploy slice 1a
--
-- Applying first is what removes any interval in which the new build runs against the old constraints.
-- Doing it the other way round would 23503 every device create and every new device's first session
-- write for as long as the skew lasted.
--
-- ⚠️ ACCEPTED, BOUNDED COVERAGE GAP. This adds NO replacement FK, deliberately. `sessions` gets its new
-- one (`device_rid -> devices.rid`, `NOT VALID` then `VALIDATE`) in the terminal migration, alongside the
-- rename it belongs to; `point_info` gets none because the table itself is dropped there. So between this
-- migration and the terminal one, nothing at the database level enforces session -> device or
-- point -> device reachability. That is the plan's own trap — "removing a FK turns any join onto the
-- replacement key into a silent filter" — being knowingly accepted for a known interval, not overlooked.
-- The terminal window's G2 gate asserts both reachability directions before it drops anything, which is
-- what closes it. `legacy_handles.device_id -> devices(id)` (0036) and `points.device_id -> devices(id)`
-- both remain in force throughout, so device identity itself is never unconstrained.
--
-- `polling_status_system_id_systems_id_fk` is DELIBERATELY LEFT ALONE. That table is frozen — it has had
-- no writer since slice K2 — so the constraint can never fire, and it dies with its table in the terminal
-- migration. Dropping it here would be scope creep with no benefit.
--
-- WHY HAND-WRITTEN: drizzle-kit emits the two `DROP CONSTRAINT`s below with no preconditions and without
-- `IF EXISTS`, so a re-run errors and a branch that never had the constraints cannot be brought into
-- line. The guard below also pins the constraints by identity rather than by name alone.
-- `meta/0050_snapshot.json` and the journal entry stay machine-written so a future `db:pg:generate`
-- still diffs clean.
--
-- ⚠️ Constraint names are unique PER TABLE, not per schema (the 0044 lesson), so every check below is
-- `conrelid`-scoped. A bare `pg_constraint.conname = '…'` lookup can match another table's constraint.
--
-- NOTE the guard's RAISE NOTICEs are SWALLOWED under `npm run db:pg:migrate` (drizzle-orm's migrator
-- attaches no 'notice' listener — the slice-G lesson). Capture the row inventory by hand first if you
-- want it on the record.
--
-- Idempotent: both drops are `IF EXISTS`, and the guard SKIPS (rather than aborts) when neither
-- constraint is present, so a re-run is a clean no-op. Reversible in principle — re-adding either FK is a
-- forward migration — but not something to do while 1a is deployed.
--
-- Preconditions: none in the code. This migration goes FIRST, before slice 1a merges. Then prod
-- `sydney`, then `liveone-dev`. See the config-v4 epic record § Phase 12.

DO $$
DECLARE
  has_pi_fk  boolean;
  has_se_fk  boolean;
  pi_rows    bigint;
  se_rows    bigint;
BEGIN
  -- conrelid-scoped on BOTH sides: the constraint must live on the table we mean AND point at `systems`.
  SELECT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname   = 'point_info_system_id_systems_id_fk'
                    AND conrelid  = 'public.point_info'::regclass
                    AND confrelid = 'public.systems'::regclass
                    AND contype   = 'f')
    INTO has_pi_fk;

  SELECT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname   = 'sessions_system_id_systems_id_fk'
                    AND conrelid  = 'public.sessions'::regclass
                    AND confrelid = 'public.systems'::regclass
                    AND contype   = 'f')
    INTO has_se_fk;

  IF NOT has_pi_fk AND NOT has_se_fk THEN
    RAISE NOTICE '0050: neither FK present — already applied, skipping checks';
    RETURN;
  END IF;

  -- Both are expected together. One-without-the-other means someone has already hand-edited this branch,
  -- and a half-applied relaxation is exactly the state that makes the 1a deploy fail on only SOME writes
  -- (e.g. point mints succeed but the ingest path 23503s), which is far harder to diagnose than a clean
  -- failure. Refuse rather than guess.
  IF has_pi_fk <> has_se_fk THEN
    RAISE EXCEPTION '0050: exactly one of the two FKs is present (point_info=%, sessions=%) — this branch is in a hand-edited state; reconcile it before applying',
      has_pi_fk, has_se_fk;
  END IF;

  -- The columns themselves must survive untouched. If either is already gone, this migration is being
  -- applied out of order (after the terminal one) and must not run.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.point_info'::regclass
                    AND attname  = 'system_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0050: point_info.system_id is missing — applied out of order (the terminal migration already ran?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.sessions'::regclass
                    AND attname  = 'system_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0050: sessions.system_id is missing — applied out of order (already renamed to device_rid?)';
  END IF;

  -- Inventory for the record. NOT a gate: this migration destroys no rows, so there is no count to
  -- validate against. `sessions` is ~10^6 rows, so both are read from the planner's estimate rather than
  -- with COUNT(*) — an exact count here would buy nothing and scan the biggest table on the branch.
  SELECT n_live_tup INTO pi_rows FROM pg_stat_user_tables WHERE relname = 'point_info';
  SELECT n_live_tup INTO se_rows FROM pg_stat_user_tables WHERE relname = 'sessions';
  RAISE NOTICE '0050: dropping 2 FKs into systems. point_info ~% rows, sessions ~% rows (planner estimates; no rows are touched)',
    coalesce(pi_rows, -1), coalesce(se_rows, -1);
END $$;
--> statement-breakpoint
ALTER TABLE "point_info" DROP CONSTRAINT IF EXISTS "point_info_system_id_systems_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_system_id_systems_id_fk";
