-- 0052 config-v4 Phase 13 PR 6 — the integer handle leaves `areas`.
--
-- Drops `areas_legacy_system_unique`, then `areas.legacy_system_id`. Two statements, one gate block.
-- Nothing else changes; no table is dropped, no data is copied.
--
-- ============================================================================================
-- 🛑 IRREVERSIBLE, but NOT unrecoverable — and the distinction is the whole reason this is cheap.
-- The column's contents are FULLY reconstructible from the surviving schema: `legacy_handles(area_id,
-- handle)` is set-identical to `areas(id, legacy_system_id)`, asserted by G1 below and measured 22/22
-- with difference 0 in BOTH directions on `liveone-dev` (Phase 13 PR 5) before either was touched. So
-- unlike 0051 this is not a "restore from backup or lose it" drop: if the column ever had to come back,
-- `UPDATE areas a SET legacy_system_id = lh.handle FROM legacy_handles lh WHERE lh.area_id = a.id`
-- rebuilds it exactly. The PITR window + the 2-hourly R2 `pg_dump` remain the backstop; a one-off
-- `pscale backup create` is prudent, not load-bearing.
-- ============================================================================================
--
-- 🛑 DEPLOY THE CODE FIRST. Drops INVERT the project's usual "migration leads code" rule (learned by
-- breaking prod during 0037): a projection-less `.select()` expands to the columns declared in the
-- RUNNING build, so this column must already be absent from the deployed build before it is dropped.
-- Phase 13 PRs 1-5 moved every reader onto `legacy_handles`; PR 6 (this migration's own PR) removes the
-- last two writers, the one reader PR 5 missed (`lib/admin/get-areas-data.ts`), and the field from
-- `schema.ts`. Order:
--
--      1. MERGE PR 6 and let Vercel deploy it. Confirm the deploy is `Ready` and aliased, `/api/health`
--         200. Nothing in the running build may name `legacy_system_id`.
--      2. Apply THIS migration to prod `sydney`.
--      3. Post-check the CATALOG (see below), not the migrator's exit line.
--      4. Apply to `liveone-dev`, re-post-check, and re-run
--         `npx tsx --env-file=.env.local scripts/utils/verify-areas-drift-key.ts` — see the note below,
--         because this migration removes that harness's backstop.
--      5. `npm run db:pg:generate` must report *No schema changes*.
--
-- **No maintenance window, no queue pause, no continuity gates.** This is a nullable column on a
-- 22-row table, off the hot ingest path and off the serving path. `ALTER TABLE … DROP COLUMN` is a
-- catalog-only operation in Postgres (the column is marked dropped; no table rewrite), so the
-- `ACCESS EXCLUSIVE` lock is held for microseconds. `DROP INDEX` is likewise instant on 22 rows. Both
-- are wrapped in the migrator's transaction. Set `lock_timeout` (e.g. `SET lock_timeout = '5s'`) on the
-- session so a long-running reader makes this fail fast instead of queueing behind a lock.
--
-- 🛑 A MISSING MIGRATION FILE LOOKS IDENTICAL TO A SUCCESSFUL APPLY. `db:pg:migrate` run from a tree
-- lacking this file prints "migrations applied successfully" and does nothing at all — and on a branch
-- whose journal already carries the entry it does the same. Only the CATALOG distinguishes them:
--
--      SELECT count(*) FROM pg_attribute
--       WHERE attrelid = 'public.areas'::regclass AND attname = 'legacy_system_id' AND NOT attisdropped;
--      SELECT count(*) FROM pg_class WHERE relname = 'areas_legacy_system_unique';
--
-- Both must be 0 afterwards. Related: `db:pg:migrate` swallows `RAISE NOTICE`, so the advisory
-- inventory below is invisible in its output — capture it BY HAND, before applying, or the record is
-- lost.
--
-- ## What this REMOVES that was load-bearing, and what replaces it
--
-- `areas_legacy_system_unique` was doing three jobs, not one. Each has a named successor:
--
--   (1) **One Area per integer handle.** → `legacy_handles_area_unique`, a partial UNIQUE on
--       `legacy_handles.area_id`, plus `legacy_handles`' PK on `handle`. Gate G3 refuses to drop the
--       old index unless the replacement is present in the catalog.
--   (2) **The `createArea` handle-race retry.** It caught SQLSTATE 23505 on this index and
--       re-allocated. → `HandleAreaConflictError`, raised by `DeviceRegistry.ensureAreaForHandle` when
--       the handle's `area_id` is already claimed by a DIFFERENT area. NOT the PK on its own: that
--       upsert is `ON CONFLICT DO UPDATE … coalesce(area_id, new)`, which SWALLOWS the conflict, so
--       after this drop a lost race would otherwise have silently left the handle naming the incumbent
--       area while `devices.primary_area_id` named the new one.
--   (3) **The prod->dev sync's last backstop.** With the column present, an `areas` drift key that had
--       stopped matching ABORTED the sync on this index — loud, and survivable. Without it the same
--       miss is a silent no-op that exits 0. This is exactly why PR 5 moved that key onto a cross-table
--       `legacy_handles.handle` key STRICTLY BEFORE this drop, and why
--       `scripts/utils/verify-areas-drift-key.ts` is retained: post-0052 it is the ONLY instrument that
--       can tell a working drift key from a broken one. Re-run it after applying.
--
-- ## Preconditions read the CATALOG, never the drizzle journal
--
-- The journal records INTENT; the catalog records what is true of THIS branch. Every gate below is a
-- `pg_catalog` lookup or a live row count, inside ONE `DO` block with `RAISE EXCEPTION` — the only form
-- of validation that cannot be raced between probe and apply. Constraint names are unique PER TABLE,
-- not per schema (the 0044 lesson), so the constraint lookup is `conrelid`-scoped.
--
-- ## 🛑 G1 is ASYMMETRIC, deliberately — mirroring 0051's G2
--
-- Only the LOSING direction is gated:
--
--   * an `areas` row with a non-NULL `legacy_system_id` and NO `legacy_handles` row agreeing on BOTH
--     `handle` and `area_id` -> **HARD ABORT**. That handle's only record is the column about to be
--     dropped, so the drop would destroy it and `?systemId=N` would stop resolving that area forever.
--   * a `legacy_handles` area row with no counterpart in the column -> **REPORTED ONLY**, because it is
--     the DESIGNED END STATE and not merely tolerated: the code deploys at step 1 and this applies at
--     step 2, and from step 1 onward `createArea` / `DeviceWriter.createDevice` mint into
--     `legacy_handles` ALONE. An area created in that window is `legacy_handles`-only BY CONSTRUCTION.
--     A symmetric gate would abort on exactly the rows the correct sequence produces.
--
-- There is **NO foreign key on this column** — `0014_eminent_kid_colt.sql:36` dropped the last one and
-- no migration since has touched it. G2 asserts that against the catalog rather than trusting the
-- claim, and there is **no `CASCADE` anywhere below**: an unexpected dependent (a view, a generated
-- column, an unforeseen constraint) must ABORT the migration, not vanish silently. That is the 0041
-- lesson, and drizzle-kit's machine diff — which emitted exactly these two statements and nothing
-- else — offers no such protection.
--
-- Not idempotent, and deliberately not: it drops an index and a column, and G0 turns a second run into
-- an explicit failure rather than a confusing no-op. The journal is what prevents a second run. To
-- re-check a branch, run the gate predicates by hand as plain `SELECT`s.
--
-- See docs/plans/config-v4-phase13-prs.md § "PR 6".

-- ── Gates. All of them, before anything is touched. ──────────────────────────────────────────
DO $$
DECLARE
  n_areas             bigint;
  n_areas_handled     bigint;
  n_col_no_handle_row bigint;
  n_handle_row_no_col bigint;
  n_constraints_on    bigint;
  n_fks_on            bigint;
  n_other_deps        bigint;
  col_attnum          smallint;
BEGIN
  -- 0. The column AND its index must BOTH still exist. Together these prove the migration is being
  --    applied to the state it was written against — the CATALOG saying so, not the journal — and catch
  --    a PARTIAL apply (one statement landed, the other did not), which is otherwise invisible.
  SELECT attnum INTO col_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.areas'::regclass AND attname = 'legacy_system_id' AND NOT attisdropped;

  IF col_attnum IS NULL THEN
    RAISE EXCEPTION '0052: areas.legacy_system_id is already gone — already applied to this branch, or a partial apply; reconcile by hand';
  END IF;

  IF to_regclass('public.areas_legacy_system_unique') IS NULL THEN
    RAISE EXCEPTION '0052: areas_legacy_system_unique is already gone while the column remains — a PARTIAL apply; reconcile this branch by hand before re-running';
  END IF;

  -- 1. G1 — the identity proof, ASYMMETRIC. See the header for why only one direction can be gated.
  SELECT count(*) INTO n_areas FROM areas;
  SELECT count(*) INTO n_areas_handled FROM areas WHERE legacy_system_id IS NOT NULL;

  IF n_areas = 0 THEN
    RAISE EXCEPTION '0052: areas is EMPTY — this is not a database anything has been served from; refusing to drop';
  END IF;

  -- The losing direction: a handle recorded ONLY in the column. Matched on BOTH `handle` and `area_id`,
  -- so a row that agrees on the handle but points at a DIFFERENT area also aborts — that mismatch would
  -- silently re-point `?systemId=N` at another area the moment the column went.
  SELECT count(*) INTO n_col_no_handle_row
  FROM areas a
  WHERE a.legacy_system_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM legacy_handles lh
      WHERE lh.handle = a.legacy_system_id AND lh.area_id = a.id
    );

  IF n_col_no_handle_row <> 0 THEN
    RAISE EXCEPTION '0052: % area(s) carry a legacy_system_id with no matching legacy_handles row (same handle AND area_id) — dropping the column would destroy the only record of those handles and ?systemId=N would stop resolving them. Backfill legacy_handles first: INSERT INTO legacy_handles (handle, area_id) SELECT legacy_system_id, id FROM areas WHERE legacy_system_id IS NOT NULL ON CONFLICT (handle) DO UPDATE SET area_id = coalesce(legacy_handles.area_id, excluded.area_id)',
      n_col_no_handle_row;
  END IF;

  -- The winning direction: REPORTED ONLY. An area minted between the step-1 deploy and this migration is
  -- `legacy_handles`-only by construction.
  SELECT count(*) INTO n_handle_row_no_col
  FROM legacy_handles lh
  WHERE lh.area_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM areas a
      WHERE a.id = lh.area_id AND a.legacy_system_id = lh.handle
    );

  RAISE NOTICE '0052 G1: % areas (% with a handle); column-without-legacy_handles = 0 (gated); legacy_handles-without-column = % (expected end state, NOT gated)',
    n_areas, n_areas_handled, n_handle_row_no_col;

  -- 2. G2 — zero dependents on the column. `conkey` is `conrelid`-scoped (the 0044 lesson) and covers
  --    every constraint TYPE, not just foreign keys: a CHECK or a UNIQUE naming this column would make
  --    the DROP fail — or, with a CASCADE this file deliberately does not carry, vanish silently.
  --    0014_eminent_kid_colt.sql:36 dropped the last FK; this asserts it rather than trusting it.
  SELECT count(*) INTO n_constraints_on
  FROM pg_constraint
  WHERE conrelid = 'public.areas'::regclass AND conkey @> ARRAY[col_attnum];

  SELECT count(*) INTO n_fks_on
  FROM pg_constraint
  WHERE conrelid = 'public.areas'::regclass AND contype = 'f' AND conkey @> ARRAY[col_attnum];

  IF n_constraints_on <> 0 THEN
    RAISE EXCEPTION '0052: % constraint(s) on areas name legacy_system_id (of which % are FKs) — an unexpected dependent must be understood before the column is dropped, not CASCADEd away',
      n_constraints_on, n_fks_on;
  END IF;

  -- Any OTHER catalog dependent — a view, a rule, a trigger, a generated column, a default expression
  -- elsewhere. `deptype = 'a'` (auto) is the column's own attribute wiring, and its unique index is
  -- excluded by name because that index is precisely what the first DDL statement below drops. Anything
  -- else means this is not the local change it looks like.
  SELECT count(*) INTO n_other_deps
  FROM pg_depend d
  WHERE d.refobjid = 'public.areas'::regclass
    AND d.refobjsubid = col_attnum
    AND d.deptype <> 'a'
    AND d.objid <> to_regclass('public.areas_legacy_system_unique')::oid;

  IF n_other_deps <> 0 THEN
    RAISE EXCEPTION '0052: % unexpected catalog dependent(s) on areas.legacy_system_id besides its own unique index — inspect pg_depend before dropping',
      n_other_deps;
  END IF;

  -- 3. G3 — the REPLACEMENT invariant must already exist. `areas_legacy_system_unique` enforced one Area
  --    per handle; after this drop that job belongs entirely to `legacy_handles_area_unique` (partial
  --    UNIQUE on `area_id`) plus `legacy_handles`' PK on `handle`. Dropping the old guard without the new
  --    one in place would leave the addressing invariant unenforced.
  IF to_regclass('public.legacy_handles_area_unique') IS NULL THEN
    RAISE EXCEPTION '0052: legacy_handles_area_unique is MISSING — it is the successor to areas_legacy_system_unique (one Area per handle); refusing to drop the old guard with no replacement';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.legacy_handles'::regclass AND contype = 'p'
  ) THEN
    RAISE EXCEPTION '0052: legacy_handles has no PRIMARY KEY on `handle` — the other half of the replacement invariant is missing';
  END IF;

  RAISE NOTICE '0052 pre-check OK: % areas, % with a handle, 0 dependents on the column, legacy_handles_area_unique + PK present',
    n_areas, n_areas_handled;
END $$;
--> statement-breakpoint

-- ── The drop. Index first (it depends on the column), then the column. NO CASCADE on either. ──
-- Without CASCADE an unexpected dependent raises `2BP01 … other objects depend on it` and aborts the
-- whole transaction — which is the desired outcome. G2 has already proven there is none.
DROP INDEX "areas_legacy_system_unique";--> statement-breakpoint
ALTER TABLE "areas" DROP COLUMN "legacy_system_id";
