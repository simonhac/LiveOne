CREATE TABLE "point_readings_flow_1d" (
	"system_id" integer NOT NULL,
	"day" text NOT NULL,
	"source_path" text NOT NULL,
	"load_path" text NOT NULL,
	"energy_kwh" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "point_readings_flow_1d_system_id_day_source_path_load_path_pk" PRIMARY KEY("system_id","day","source_path","load_path")
);
--> statement-breakpoint
CREATE INDEX "prf1d_system_day_idx" ON "point_readings_flow_1d" USING btree ("system_id","day");--> statement-breakpoint
CREATE INDEX "prf1d_day_idx" ON "point_readings_flow_1d" USING btree ("day");