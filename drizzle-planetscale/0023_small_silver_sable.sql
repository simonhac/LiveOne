CREATE TABLE "point_readings_flow_attr_1d" (
	"area_id" uuid NOT NULL,
	"day" text NOT NULL,
	"source_path" text NOT NULL,
	"load_path" text NOT NULL,
	"energy_kwh" double precision NOT NULL,
	"emissions_g" double precision,
	"renewable_kwh" double precision,
	"cost_c" double precision,
	"estimated_kwh" double precision DEFAULT 0 NOT NULL,
	"sample_count" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"finalized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "point_readings_flow_attr_1d_area_id_day_source_path_load_path_pk" PRIMARY KEY("area_id","day","source_path","load_path")
);
--> statement-breakpoint
ALTER TABLE "point_readings_flow_attr_1d" ADD CONSTRAINT "point_readings_flow_attr_1d_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prfa1d_day_idx" ON "point_readings_flow_attr_1d" USING btree ("day");--> statement-breakpoint
CREATE INDEX "prfa1d_area_day_idx" ON "point_readings_flow_attr_1d" USING btree ("area_id","day");