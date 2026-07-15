CREATE TABLE "battery_provenance_daily" (
	"area_id" uuid NOT NULL,
	"day" text NOT NULL,
	"first_interval_end" timestamp,
	"interval_count" integer DEFAULT 0 NOT NULL,
	"charge_kwh" double precision DEFAULT 0 NOT NULL,
	"discharge_kwh" double precision DEFAULT 0 NOT NULL,
	"soc_first" double precision,
	"soc_last" double precision,
	"soc_samples" integer DEFAULT 0 NOT NULL,
	"cap_discharge_kwh" double precision DEFAULT 0 NOT NULL,
	"down_swing_pct" double precision DEFAULT 0 NOT NULL,
	"recal" boolean DEFAULT false NOT NULL,
	"soc_last_slot_pct" double precision,
	"soc_carry_pct" double precision,
	"net_after_soc_kwh" double precision DEFAULT 0 NOT NULL,
	"probe_charge_kwh" double precision,
	"probe_discharge_kwh" double precision,
	"eta" double precision,
	"capacity_kwh" double precision,
	"charge_eff" double precision,
	"idle_loss_kwh_day" double precision,
	"fold_state" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "battery_provenance_daily_area_id_day_pk" PRIMARY KEY("area_id","day")
);
--> statement-breakpoint
ALTER TABLE "battery_provenance_daily" ADD CONSTRAINT "battery_provenance_daily_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bpd_day_idx" ON "battery_provenance_daily" USING btree ("day");