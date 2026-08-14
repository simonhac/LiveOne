CREATE TABLE "amber_forecast_history" (
	"device_rid" integer NOT NULL,
	"channel" text NOT NULL,
	"interval_end" timestamp NOT NULL,
	"observed_at" timestamp NOT NULL,
	"interval_type" text NOT NULL,
	"duration_min" integer DEFAULT 30 NOT NULL,
	"per_kwh" double precision,
	"adv_low" double precision,
	"adv_predicted" double precision,
	"adv_high" double precision,
	"descriptor" text,
	"spike_status" text,
	"estimate" boolean,
	"spot_per_kwh" double precision,
	"renewables" double precision,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "afh_pkey" PRIMARY KEY("device_rid","channel","interval_end","observed_at"),
	CONSTRAINT "afh_channel_check" CHECK ("amber_forecast_history"."channel" IN ('general', 'feedIn', 'controlledLoad', 'site')),
	CONSTRAINT "afh_interval_type_check" CHECK ("amber_forecast_history"."interval_type" IN ('f', 'c'))
);
--> statement-breakpoint
ALTER TABLE "amber_forecast_history" ADD CONSTRAINT "amber_forecast_history_device_rid_devices_rid_fk" FOREIGN KEY ("device_rid") REFERENCES "public"."devices"("rid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "afh_observed_at_idx" ON "amber_forecast_history" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "afh_created_at_idx" ON "amber_forecast_history" USING btree ("created_at");