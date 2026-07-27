-- config-v4 Phase 10 — cutover reconciliation (catch-up entry).
--
-- WHY THIS EXISTS. Phase 8's cutover ran OUT-OF-BAND: `scripts/config-v4/config-transform.ts` reshaped
-- the database by hand, so migrations 0000–0035 stopped describing reality. `db:pg:generate` reads ONLY
-- the latest snapshot as its diff base, so the chain had to be given a correct latest snapshot before it
-- could be trusted again. `meta/0036_snapshot.json` is that snapshot — generated from `schema.ts` against
-- an empty journal (drizzle's own serialization), with `prevId` patched to 0035's id.
--
-- ⚠️ REPLAY FIDELITY (known and accepted). Replaying 0000→0036 onto an EMPTY database yields the
-- PRE-cutover schema: this migration does NOT re-do the cutover. That fidelity was already gone in
-- reality — the transform was out-of-band and pre-cutover backups cannot be rolled forward — and this
-- project bootstraps environments from R2 dumps, never from migration replay. The transform itself is
-- preserved in git history:
--     git show ad007463^:scripts/config-v4/config-transform.ts
--
-- WHAT THIS MIGRATION ACTUALLY DOES. Only metadata renames, aligning the transform's hand-chosen
-- constraint names with the drizzle defaults that `schema.ts` now implies, so that generate reports
-- "No schema changes". All are instant catalog updates — no table rewrite, no lock of consequence.
--
-- NOT DONE HERE — the hot-table INDEX and PK names. They keep the transform's `_new` suffix
-- (`point_readings_new_pkey`, `pr_new_*`, `pr5m_new_*`, `pr1d_new_*`) and `schema.ts` declares them that
-- way, so snapshot, schema and database already agree. They CANNOT be renamed to canonical yet: index
-- and PK-constraint names are schema-GLOBALLY unique in Postgres, and the retained `_old` tables still
-- own `point_readings_pkey` / `pr_measurement_time_idx` / `pr_created_at_idx` / `pr5m_*` / `pr1d_day_idx`.
-- An early rename is a 42P07. Migration 0038 drops `_old`; 0039 then renames these to canonical.
-- (FOREIGN KEY names, renamed below, are per-TABLE and so are free of that constraint — verified
-- empirically, including `point_readings_session_id_sessions_id_fk`, which `point_readings_old` also
-- holds.)
--
-- Every rename is wrapped in a guard so this file is idempotent and no-op-safe on any DB shape. The
-- guards scope by `conrelid`, NOT by `conname` alone — `conname` is unique per table, not per schema, so
-- a bare name match would see `point_readings_old`'s copy and wrongly skip the rename.

--> statement-breakpoint
-- ── hot-table FKs: transform names → drizzle defaults ──────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pr_new_point_fk' AND conrelid = to_regclass('point_readings'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_readings_point_rid_points_rid_fk' AND conrelid = to_regclass('point_readings')) THEN
    ALTER TABLE point_readings RENAME CONSTRAINT pr_new_point_fk TO point_readings_point_rid_points_rid_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pr_new_session_fk' AND conrelid = to_regclass('point_readings'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_readings_session_id_sessions_id_fk' AND conrelid = to_regclass('point_readings')) THEN
    ALTER TABLE point_readings RENAME CONSTRAINT pr_new_session_fk TO point_readings_session_id_sessions_id_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pr5m_new_point_fk' AND conrelid = to_regclass('point_readings_agg_5m'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_readings_agg_5m_point_rid_points_rid_fk' AND conrelid = to_regclass('point_readings_agg_5m')) THEN
    ALTER TABLE point_readings_agg_5m RENAME CONSTRAINT pr5m_new_point_fk TO point_readings_agg_5m_point_rid_points_rid_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pr1d_new_point_fk' AND conrelid = to_regclass('point_readings_agg_1d'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_readings_agg_1d_point_rid_points_rid_fk' AND conrelid = to_regclass('point_readings_agg_1d')) THEN
    ALTER TABLE point_readings_agg_1d RENAME CONSTRAINT pr1d_new_point_fk TO point_readings_agg_1d_point_rid_points_rid_fk;
  END IF;
END $$;--> statement-breakpoint

-- ── config-table FKs: the transform wrote `…_dashboards_fk`, drizzle expects `…_dashboards_id_fk` ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'area_bindings_point_uid_points_fk' AND conrelid = to_regclass('area_bindings'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'area_bindings_point_uid_points_id_fk' AND conrelid = to_regclass('area_bindings')) THEN
    ALTER TABLE area_bindings RENAME CONSTRAINT area_bindings_point_uid_points_fk TO area_bindings_point_uid_points_id_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_grants_dashboard_id_dashboards_fk' AND conrelid = to_regclass('dashboard_grants'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_grants_dashboard_id_dashboards_id_fk' AND conrelid = to_regclass('dashboard_grants')) THEN
    ALTER TABLE dashboard_grants RENAME CONSTRAINT dashboard_grants_dashboard_id_dashboards_fk TO dashboard_grants_dashboard_id_dashboards_id_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_revisions_dashboard_id_dashboards_fk' AND conrelid = to_regclass('dashboard_revisions'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_revisions_dashboard_id_dashboards_id_fk' AND conrelid = to_regclass('dashboard_revisions')) THEN
    ALTER TABLE dashboard_revisions RENAME CONSTRAINT dashboard_revisions_dashboard_id_dashboards_fk TO dashboard_revisions_dashboard_id_dashboards_id_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_tokens_dashboard_id_dashboards_fk' AND conrelid = to_regclass('share_tokens'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_tokens_dashboard_id_dashboards_id_fk' AND conrelid = to_regclass('share_tokens')) THEN
    ALTER TABLE share_tokens RENAME CONSTRAINT share_tokens_dashboard_id_dashboards_fk TO share_tokens_dashboard_id_dashboards_id_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_default_dashboard_id_dashboards_fk' AND conrelid = to_regclass('users'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_default_dashboard_id_dashboards_id_fk' AND conrelid = to_regclass('users')) THEN
    ALTER TABLE users RENAME CONSTRAINT users_default_dashboard_id_dashboards_fk TO users_default_dashboard_id_dashboards_id_fk;
  END IF;
END $$;--> statement-breakpoint

-- ── FKs that were LIVE but UNDECLARED ──────────────────────────────────────────────────────────────
-- Both were added by config-transform stage 5 but never declared in `schema.ts`, whose comments still
-- said "DEFERRED to cutover". Found by the step-5 audit: with the column undeclared, generate wanted to
-- DROP the live constraint. 0036 declares them and aligns their names to the drizzle defaults. (This is
-- the same class of defect as `area_bindings.point_uid`.)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'derivations_output_point_id_points_fk' AND conrelid = to_regclass('derivations'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'derivations_output_point_id_points_id_fk' AND conrelid = to_regclass('derivations')) THEN
    ALTER TABLE derivations RENAME CONSTRAINT derivations_output_point_id_points_fk TO derivations_output_point_id_points_id_fk;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legacy_handles_device_id_devices_fk' AND conrelid = to_regclass('legacy_handles'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legacy_handles_device_id_devices_id_fk' AND conrelid = to_regclass('legacy_handles')) THEN
    ALTER TABLE legacy_handles RENAME CONSTRAINT legacy_handles_device_id_devices_fk TO legacy_handles_device_id_devices_id_fk;
  END IF;
END $$;
