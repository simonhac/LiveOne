-- 0006 — PG foreign-key rebuild (decommission-time hardening).
--
-- ⚠️ STAGED / NOT YET APPLIED. Apply attended, AFTER re-running the read-only
-- orphan pre-flight (scripts/audit-pg-fk-orphans.ts) immediately beforehand
-- (0-orphan is a point-in-time fact) and confirming PG PITR + a fresh base backup.
-- Adding a constraint never fires a cascade, so this mutates no rows.
--
-- Group A (trivial rows → systems CASCADE/SET NULL, plus the small tables) validates
-- inline. The large tables (sessions ~870K, point_readings ~13.4M, agg_5m ~3.3M) are
-- added NOT VALID first (brief lock) and VALIDATEd in separate statements (validating
-- scan under non-blocking SHARE UPDATE EXCLUSIVE) — run those VALIDATEs one at a time
-- if lock duration matters. All wrapped in pg_constraint guards so re-runs are no-ops.
-- Rollback: ALTER TABLE <child> DROP CONSTRAINT IF EXISTS <name>; (no data risk).

-- Group A — validate inline
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='polling_status_system_id_systems_id_fk') THEN
    ALTER TABLE "polling_status" ADD CONSTRAINT "polling_status_system_id_systems_id_fk"
      FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE cascade ON UPDATE no action; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_systems_system_id_systems_id_fk') THEN
    ALTER TABLE "user_systems" ADD CONSTRAINT "user_systems_system_id_systems_id_fk"
      FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE cascade ON UPDATE no action; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_default_system_id_systems_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_default_system_id_systems_id_fk"
      FOREIGN KEY ("default_system_id") REFERENCES "public"."systems"("id") ON DELETE set null ON UPDATE no action; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_info_system_id_systems_id_fk') THEN
    ALTER TABLE "point_info" ADD CONSTRAINT "point_info_system_id_systems_id_fk"
      FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action; END IF;  -- ~73 rows
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_readings_agg_1d_system_id_point_id_point_info_fk') THEN
    ALTER TABLE "point_readings_agg_1d" ADD CONSTRAINT "point_readings_agg_1d_system_id_point_id_point_info_fk"
      FOREIGN KEY ("system_id","point_id") REFERENCES "public"."point_info"("system_id","id") ON DELETE no action ON UPDATE no action; END IF;  -- ~11.9K rows
END $$;--> statement-breakpoint

-- Large tables — add NOT VALID first (brief lock), VALIDATE separately below
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sessions_system_id_systems_id_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_system_id_systems_id_fk"
      FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action NOT VALID; END IF;  -- ~870K rows
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_readings_system_id_point_id_point_info_fk') THEN
    ALTER TABLE "point_readings" ADD CONSTRAINT "point_readings_system_id_point_id_point_info_fk"
      FOREIGN KEY ("system_id","point_id") REFERENCES "public"."point_info"("system_id","id") ON DELETE no action ON UPDATE no action NOT VALID; END IF;  -- ~13.4M rows
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_readings_agg_5m_system_id_point_id_point_info_fk') THEN
    ALTER TABLE "point_readings_agg_5m" ADD CONSTRAINT "point_readings_agg_5m_system_id_point_id_point_info_fk"
      FOREIGN KEY ("system_id","point_id") REFERENCES "public"."point_info"("system_id","id") ON DELETE no action ON UPDATE no action NOT VALID; END IF;  -- ~3.3M rows
END $$;--> statement-breakpoint

ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_system_id_systems_id_fk";--> statement-breakpoint
ALTER TABLE "point_readings" VALIDATE CONSTRAINT "point_readings_system_id_point_id_point_info_fk";--> statement-breakpoint
ALTER TABLE "point_readings_agg_5m" VALIDATE CONSTRAINT "point_readings_agg_5m_system_id_point_id_point_info_fk";
