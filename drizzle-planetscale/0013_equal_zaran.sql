-- Guard (P3-tail-1): refuse to re-key if any flow row is un-keyed. Runs first, so the table is
-- untouched on abort. area_id is backfilled forward-only + proven 1:1 with system_id, so this
-- should pass; if it trips, backfill the NULLs (area_id = area whose legacy_system_id = system_id)
-- before re-running. See docs/deferred/areas-p3-tail-and-p4-plan.md.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM point_readings_flow_1d WHERE area_id IS NULL)
  THEN RAISE EXCEPTION 'flow_1d has NULL area_id — aborting before re-key'; END IF;
END $$;--> statement-breakpoint
DROP INDEX "prf1d_system_day_idx";--> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" DROP CONSTRAINT "point_readings_flow_1d_system_id_day_source_path_load_path_pk";--> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" ALTER COLUMN "area_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" ADD CONSTRAINT "point_readings_flow_1d_area_id_day_source_path_load_path_pk" PRIMARY KEY("area_id","day","source_path","load_path");--> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" DROP COLUMN "system_id";