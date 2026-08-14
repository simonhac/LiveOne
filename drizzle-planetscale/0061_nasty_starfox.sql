ALTER TABLE "amber_forecast_history" DROP CONSTRAINT "afh_pkey";
--> statement-breakpoint
ALTER TABLE "amber_forecast_history" ADD CONSTRAINT "afh_pkey" PRIMARY KEY("device_rid","interval_end","channel","observed_at");