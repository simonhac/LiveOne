-- P6 guard: refuse to drop dashboards.system_id while any legacy per-system row survives. The Phase-3
-- data migration (delete the vestigial legacy rows / convert the rest in place) MUST run first, nulling
-- every dashboards.system_id. This aborts the whole migration (single implicit tx) if it hasn't.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dashboards WHERE system_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing 0022: % dashboard(s) still carry a non-null system_id — run the P6 data migration first',
      (SELECT count(*) FROM dashboards WHERE system_id IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "areas" DROP CONSTRAINT "areas_source_system_id_systems_id_fk";
--> statement-breakpoint
ALTER TABLE "dashboards" DROP CONSTRAINT "dashboards_area_id_areas_id_fk";
--> statement-breakpoint
DROP INDEX "areas_source_system_idx";--> statement-breakpoint
DROP INDEX "dashboards_user_system_unique";--> statement-breakpoint
DROP INDEX "dashboards_area_idx";--> statement-breakpoint
DROP INDEX "users_default_system_idx";--> statement-breakpoint
ALTER TABLE "areas" DROP COLUMN "source_system_id";--> statement-breakpoint
ALTER TABLE "dashboards" DROP COLUMN "system_id";--> statement-breakpoint
ALTER TABLE "dashboards" DROP COLUMN "area_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "default_system_id";