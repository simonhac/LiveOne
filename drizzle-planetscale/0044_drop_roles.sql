-- 0044 config-v4 Phase 12 (slice G): drop the `roles` table.
--
-- WHAT DIES: the `roles` table (9 columns, 6 rows) and the last FK into it,
-- `area_bindings_role_roles_role_fk`. `roles` was only ever a SQL PROJECTION of the code registry in
-- lib/roles/registry.ts (`ROLES`) — the seed script that wrote it is long deleted, so the table has had
-- no writer for months, and it has ZERO query sites: nothing joins it for role metadata. Phase 11's
-- 0041 released two of its three FKs (device_trackers / device_run_periods); this releases the third.
--
-- WHY THIS IS SAFE, MECHANICALLY: enforcement of the role vocabulary does NOT depend on the FK.
-- Migration 0032 added `area_bindings_role_check` — `role IN
-- ('solar','battery','load','grid','ev','generator')` — explicitly so that dropping this table would
-- leave enforcement intact (see the `roleCheck` comment in lib/db/planetscale/schema.ts). The FK and the
-- CHECK have been redundant with each other ever since; this removes the redundant one. Role METADATA
-- (category / stem / label / ha_* / summary_*) is read from lib/roles/registry.ts. After this migration
-- there is no SQL-joinable copy — by design — so ADDING A ROLE needs a migration that widens
-- `area_bindings_role_check` and `derivations_role_check`; nothing derives them from the code registry.
--
-- WHY HAND-WRITTEN: drizzle-kit emits `DROP TABLE "roles" CASCADE` with no validation — precisely the
-- migration-0016 failure mode (345K rows lost to an unvalidated drop), and 0037 is the local proof it
-- still bites. So: assert the CHECK is actually there BEFORE removing the FK that currently backstops
-- it, assert no OTHER FK depends on `roles`, and drop WITHOUT cascade so an unexpected dependent aborts
-- the migration instead of being silently removed.
--
-- Idempotent: a re-run finds the table absent and skips. IRREVERSIBLE (this project has no rollback
-- migrations — undo is a new forward migration), but `roles` is fully rederivable from
-- lib/roles/registry.ts, and prod PITR + the 2-hourly R2 pg_dump cover recovery either way.
-- Preconditions: the slice-G code is merged and DEPLOYED first (this is a [D] slice), then prod
-- `sydney`, then `liveone-dev`. See the config-v4 epic record § Phase 12 slice G.

DO $$
DECLARE
  role_rows     bigint;
  binding_roles text;
  bad_roles     text;
  extra_fks     text;
BEGIN
  IF to_regclass('public.roles') IS NULL THEN
    RAISE NOTICE 'roles already absent — nothing to validate';
    RETURN;
  END IF;

  -- 1. The CHECK must exist before the FK goes, or `area_bindings.role` ends up unconstrained.
  --    Scope by conrelid, not conname alone: a constraint name is unique per TABLE, not per schema.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.area_bindings'::regclass
      AND conname = 'area_bindings_role_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'refusing to drop roles: area_bindings_role_check is missing, so dropping the FK would leave area_bindings.role unconstrained';
  END IF;

  -- 2. Every live binding role must already satisfy the 6-set the CHECK enforces. This cannot fail
  --    while the FK is in place, which is exactly why it is worth asserting: if it DOES fail, the
  --    premise of this migration is wrong and the CHECK is not equivalent to the FK.
  SELECT string_agg(DISTINCT role, ', ') INTO binding_roles FROM area_bindings;
  SELECT string_agg(DISTINCT role, ', ') INTO bad_roles
    FROM area_bindings
   WHERE role NOT IN ('solar','battery','load','grid','ev','generator');
  IF bad_roles IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop roles: area_bindings holds role(s) outside the CHECK set: %', bad_roles;
  END IF;

  -- 3. `area_bindings_role_roles_role_fk` must be the ONLY remaining dependent. Anything else means a
  --    reader/writer this slice did not account for, and CASCADE would remove it silently.
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO extra_fks
    FROM pg_constraint
   WHERE confrelid = 'public.roles'::regclass
     AND conname <> 'area_bindings_role_roles_role_fk';
  IF extra_fks IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop roles: unexpected FK dependent(s): %', extra_fks;
  END IF;

  SELECT count(*) INTO role_rows FROM roles;
  RAISE NOTICE 'checks ok: roles has % rows; area_bindings roles in use: %; CHECK present; no unexpected FK dependents',
    role_rows, binding_roles;
END $$;
--> statement-breakpoint
ALTER TABLE "area_bindings" DROP CONSTRAINT IF EXISTS "area_bindings_role_roles_role_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "roles";
