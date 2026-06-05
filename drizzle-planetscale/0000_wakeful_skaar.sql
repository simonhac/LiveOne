CREATE TABLE "point_info" (
	"system_id" integer NOT NULL,
	"id" integer NOT NULL,
	"physical_path_tail" text NOT NULL,
	"logical_path_stem" text,
	"metric_type" text NOT NULL,
	"metric_unit" text NOT NULL,
	"point_name" text NOT NULL,
	"display_name" text NOT NULL,
	"subsystem" text,
	"transform" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp,
	CONSTRAINT "point_info_system_id_id_pk" PRIMARY KEY("system_id","id")
);
--> statement-breakpoint
CREATE TABLE "point_readings" (
	"id" serial PRIMARY KEY NOT NULL,
	"system_id" integer NOT NULL,
	"point_id" integer NOT NULL,
	"session_id" integer,
	"measurement_time" timestamp NOT NULL,
	"received_time" timestamp NOT NULL,
	"value" double precision,
	"value_str" text,
	"error" text,
	"data_quality" text DEFAULT 'good' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "point_readings_agg_1d" (
	"system_id" integer NOT NULL,
	"point_id" integer NOT NULL,
	"day" text NOT NULL,
	"avg" double precision,
	"min" double precision,
	"max" double precision,
	"last" double precision,
	"delta" double precision,
	"sample_count" integer NOT NULL,
	"error_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "point_readings_agg_1d_system_id_point_id_day_pk" PRIMARY KEY("system_id","point_id","day")
);
--> statement-breakpoint
CREATE TABLE "point_readings_agg_5m" (
	"system_id" integer NOT NULL,
	"point_id" integer NOT NULL,
	"interval_end" timestamp NOT NULL,
	"session_id" integer,
	"avg" double precision,
	"min" double precision,
	"max" double precision,
	"last" double precision,
	"delta" double precision,
	"value_str" text,
	"sample_count" integer NOT NULL,
	"error_count" integer NOT NULL,
	"data_quality" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "point_readings_agg_5m_system_id_point_id_interval_end_pk" PRIMARY KEY("system_id","point_id","interval_end")
);
--> statement-breakpoint
CREATE TABLE "polling_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"system_id" integer NOT NULL,
	"last_poll_time" timestamp,
	"last_success_time" timestamp,
	"last_error_time" timestamp,
	"last_error" text,
	"last_response" jsonb,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"total_polls" integer DEFAULT 0 NOT NULL,
	"successful_polls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_label" text,
	"system_id" integer NOT NULL,
	"cause" text NOT NULL,
	"duration" integer NOT NULL,
	"successful" boolean,
	"error_code" text,
	"error" text,
	"response" jsonb,
	"num_rows" integer NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "systems" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_clerk_user_id" text,
	"vendor_type" text NOT NULL,
	"vendor_site_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"display_name" text NOT NULL,
	"alias" text,
	"model" text,
	"serial" text,
	"ratings" text,
	"solar_size" text,
	"battery_size" text,
	"location" jsonb,
	"metadata" jsonb,
	"timezone_offset_min" integer NOT NULL,
	"display_timezone" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_systems" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"system_id" integer NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"default_system_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pi_system_physical_path_unique" ON "point_info" USING btree ("system_id","physical_path_tail");--> statement-breakpoint
CREATE UNIQUE INDEX "pi_system_stem_metric_unique" ON "point_info" USING btree ("system_id","logical_path_stem","metric_type");--> statement-breakpoint
CREATE INDEX "pi_system_idx" ON "point_info" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "pi_subsystem_idx" ON "point_info" USING btree ("subsystem");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_point_time_unique" ON "point_readings" USING btree ("system_id","point_id","measurement_time");--> statement-breakpoint
CREATE INDEX "pr_system_time_idx" ON "point_readings" USING btree ("system_id","measurement_time");--> statement-breakpoint
CREATE INDEX "pr_measurement_time_idx" ON "point_readings" USING btree ("measurement_time");--> statement-breakpoint
CREATE INDEX "pr_created_at_idx" ON "point_readings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pr1d_system_day_idx" ON "point_readings_agg_1d" USING btree ("system_id","day");--> statement-breakpoint
CREATE INDEX "pr1d_day_idx" ON "point_readings_agg_1d" USING btree ("day");--> statement-breakpoint
CREATE INDEX "pr5m_system_time_idx" ON "point_readings_agg_5m" USING btree ("system_id","interval_end");--> statement-breakpoint
CREATE INDEX "pr5m_interval_end_idx" ON "point_readings_agg_5m" USING btree ("interval_end");--> statement-breakpoint
CREATE INDEX "pr5m_created_at_idx" ON "point_readings_agg_5m" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "polling_system_idx" ON "polling_status" USING btree ("system_id");--> statement-breakpoint
CREATE UNIQUE INDEX "polling_status_system_id_unique" ON "polling_status" USING btree ("system_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_system_created_at_unique" ON "sessions" USING btree ("system_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_system_idx" ON "sessions" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "sessions_created_at_idx" ON "sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_cause_idx" ON "sessions" USING btree ("cause");--> statement-breakpoint
CREATE INDEX "owner_clerk_user_idx" ON "systems" USING btree ("owner_clerk_user_id");--> statement-breakpoint
CREATE INDEX "systems_status_idx" ON "systems" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "alias_unique" ON "systems" USING btree ("owner_clerk_user_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "user_system_unique" ON "user_systems" USING btree ("clerk_user_id","system_id");--> statement-breakpoint
CREATE INDEX "user_systems_user_idx" ON "user_systems" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "user_systems_system_idx" ON "user_systems" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "users_default_system_idx" ON "users" USING btree ("default_system_id");