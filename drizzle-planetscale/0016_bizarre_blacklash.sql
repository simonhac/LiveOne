ALTER TABLE "users" ADD COLUMN "default_dashboard_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_default_dashboard_id_dashboards_id_fk" FOREIGN KEY ("default_dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_default_dashboard_idx" ON "users" USING btree ("default_dashboard_id");