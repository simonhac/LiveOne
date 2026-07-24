CREATE TABLE "dashboard_revisions" (
	"dashboard_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"doc" jsonb NOT NULL,
	"saved_by" text NOT NULL,
	"saved_at" timestamp NOT NULL,
	CONSTRAINT "dashboard_revisions_dashboard_id_revision_pk" PRIMARY KEY("dashboard_id","revision")
);
--> statement-breakpoint
CREATE TABLE "derivations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"output" text NOT NULL,
	"output_point_id" uuid,
	"params" jsonb NOT NULL,
	"source_points" jsonb NOT NULL,
	"detector_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "derivations_role_check" CHECK ("derivations"."role" IN ('solar','battery','load','grid','ev','generator')),
	CONSTRAINT "derivations_output_check" CHECK ("derivations"."output" IN ('point','intervals'))
);
--> statement-breakpoint
CREATE TABLE "derived_intervals" (
	"derivation_id" uuid NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp,
	"duration_seconds" integer,
	"energy_kwh" double precision,
	"max_power_w" double precision,
	"min_power_w" double precision,
	"avg_power_w" double precision,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"detector_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "derived_intervals_derivation_id_start_time_pk" PRIMARY KEY("derivation_id","start_time")
);
--> statement-breakpoint
CREATE TABLE "legacy_handles" (
	"handle" integer PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"area_id" uuid
);
--> statement-breakpoint
ALTER TABLE "derivations" ADD CONSTRAINT "derivations_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_intervals" ADD CONSTRAINT "derived_intervals_derivation_id_derivations_id_fk" FOREIGN KEY ("derivation_id") REFERENCES "public"."derivations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_handles" ADD CONSTRAINT "legacy_handles_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "derivations_area_role_unique" ON "derivations" USING btree ("area_id","role") WHERE role IS NOT NULL;--> statement-breakpoint
CREATE INDEX "derivations_area_idx" ON "derivations" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "derived_intervals_open_unique" ON "derived_intervals" USING btree ("derivation_id") WHERE end_time IS NULL;