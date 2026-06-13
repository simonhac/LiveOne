CREATE TABLE "device_run_periods" (
	"system_id" integer NOT NULL,
	"role" text NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp,
	"signal_system_id" integer NOT NULL,
	"signal_point_id" integer NOT NULL,
	"tracker_id" uuid,
	"area_id" uuid,
	"duration_seconds" integer,
	"energy_kwh" double precision,
	"max_power_w" double precision,
	"min_power_w" double precision,
	"avg_power_w" double precision,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"detector_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_run_periods_system_id_role_start_time_pk" PRIMARY KEY("system_id","role","start_time")
);
--> statement-breakpoint
CREATE TABLE "device_trackers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_id" integer NOT NULL,
	"role" text NOT NULL,
	"area_id" uuid,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"signal_kind" text DEFAULT 'power-threshold' NOT NULL,
	"signal_system_id" integer NOT NULL,
	"signal_point_id" integer NOT NULL,
	"lower_w" double precision,
	"upper_w" double precision,
	"hysteresis_w" double precision,
	"energy_system_id" integer,
	"energy_point_id" integer,
	"delay_on_seconds" integer,
	"delay_off_seconds" integer,
	"detector_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_run_periods" ADD CONSTRAINT "device_run_periods_role_roles_role_fk" FOREIGN KEY ("role") REFERENCES "public"."roles"("role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_run_periods" ADD CONSTRAINT "device_run_periods_tracker_id_device_trackers_id_fk" FOREIGN KEY ("tracker_id") REFERENCES "public"."device_trackers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_run_periods" ADD CONSTRAINT "device_run_periods_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_run_periods" ADD CONSTRAINT "device_run_periods_signal_point_fk" FOREIGN KEY ("signal_system_id","signal_point_id") REFERENCES "public"."point_info"("system_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_trackers" ADD CONSTRAINT "device_trackers_role_roles_role_fk" FOREIGN KEY ("role") REFERENCES "public"."roles"("role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_trackers" ADD CONSTRAINT "device_trackers_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_trackers" ADD CONSTRAINT "device_trackers_signal_point_fk" FOREIGN KEY ("signal_system_id","signal_point_id") REFERENCES "public"."point_info"("system_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drp_open_unique" ON "device_run_periods" USING btree ("system_id","role") WHERE end_time IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "device_trackers_system_role_unique" ON "device_trackers" USING btree ("system_id","role");