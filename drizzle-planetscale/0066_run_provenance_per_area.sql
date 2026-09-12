CREATE TABLE "derived_interval_provenance" (
	"derivation_id" uuid NOT NULL,
	"start_time" timestamp (3) NOT NULL,
	"area_id" uuid NOT NULL,
	"cost_c" double precision,
	"emissions_g" double precision,
	"renewable_kwh" double precision,
	"estimated_kwh" double precision,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "derived_interval_provenance_derivation_id_start_time_area_id_pk" PRIMARY KEY("derivation_id","start_time","area_id")
);
--> statement-breakpoint
ALTER TABLE "derived_interval_provenance" ADD CONSTRAINT "derived_interval_provenance_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_interval_provenance" ADD CONSTRAINT "derived_interval_provenance_run_fk" FOREIGN KEY ("derivation_id","start_time") REFERENCES "public"."derived_intervals"("derivation_id","start_time") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dip_area_start_idx" ON "derived_interval_provenance" USING btree ("area_id","start_time");