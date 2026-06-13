ALTER TABLE "dashboards" ADD COLUMN "area_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboards_area_idx" ON "dashboards" USING btree ("area_id");