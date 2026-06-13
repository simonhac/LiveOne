CREATE TABLE "area_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"role" text NOT NULL,
	"metric_type" text NOT NULL,
	"point_system_id" integer NOT NULL,
	"point_id" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"transform" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_clerk_user_id" text,
	"kind" text NOT NULL,
	"source_system_id" integer,
	"legacy_system_id" integer,
	"display_name" text NOT NULL,
	"alias" text,
	"timezone_offset_min" integer NOT NULL,
	"display_timezone" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"role" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"stem" text NOT NULL,
	"label" text NOT NULL,
	"ha_device_class" text NOT NULL,
	"ha_state_class" text NOT NULL,
	"ha_unit" text NOT NULL,
	"summary_metric" text,
	"summary_aggregable" boolean
);
--> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" ADD COLUMN "area_id" uuid;--> statement-breakpoint
ALTER TABLE "area_bindings" ADD CONSTRAINT "area_bindings_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_bindings" ADD CONSTRAINT "area_bindings_role_roles_role_fk" FOREIGN KEY ("role") REFERENCES "public"."roles"("role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_bindings" ADD CONSTRAINT "area_bindings_point_info_fk" FOREIGN KEY ("point_system_id","point_id") REFERENCES "public"."point_info"("system_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_source_system_id_systems_id_fk" FOREIGN KEY ("source_system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_legacy_system_id_systems_id_fk" FOREIGN KEY ("legacy_system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "area_bindings_unique" ON "area_bindings" USING btree ("area_id","role","metric_type","point_system_id","point_id");--> statement-breakpoint
CREATE INDEX "area_bindings_point_idx" ON "area_bindings" USING btree ("point_system_id","point_id");--> statement-breakpoint
CREATE INDEX "area_bindings_area_idx" ON "area_bindings" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "areas_owner_alias_unique" ON "areas" USING btree ("owner_clerk_user_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "areas_legacy_system_unique" ON "areas" USING btree ("legacy_system_id");--> statement-breakpoint
CREATE INDEX "areas_source_system_idx" ON "areas" USING btree ("source_system_id");--> statement-breakpoint
ALTER TABLE "point_readings_flow_1d" ADD CONSTRAINT "point_readings_flow_1d_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prf1d_area_day_idx" ON "point_readings_flow_1d" USING btree ("area_id","day");