CREATE TABLE "device_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_rid" integer NOT NULL,
	"source" text NOT NULL,
	"log_type" text,
	"code" integer NOT NULL,
	"description" text,
	"source_time_text" text NOT NULL,
	"source_timezone" text,
	"occurred_at" timestamp (3),
	"cleared_time_text" text,
	"cleared_at" timestamp (3),
	"observed_at" timestamp (3) NOT NULL,
	"snapshot" jsonb,
	"raw" text,
	"dedupe_key" text NOT NULL,
	"capture_id" uuid,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "device_events_source_check" CHECK ("device_events"."source" IN ('portal','inverter')),
	CONSTRAINT "device_events_log_type_check" CHECK (("device_events"."source" = 'inverter' AND "device_events"."log_type" IS NOT NULL AND "device_events"."log_type" IN ('alert','operational'))
          OR ("device_events"."source" = 'portal' AND "device_events"."log_type" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "diagnostic_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_rid" integer NOT NULL,
	"job_id" uuid,
	"started_at" timestamp (3) NOT NULL,
	"finished_at" timestamp (3),
	"complete" boolean DEFAULT false NOT NULL,
	"identity" jsonb,
	"metadata" jsonb,
	"scales" jsonb,
	"clock" jsonb,
	"decoder_version" integer NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"new_record_count" integer DEFAULT 0 NOT NULL,
	"coverage" jsonb,
	"sha256" text,
	"raw" jsonb,
	"error" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_rid" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reasons" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3),
	"lease_expires_at" timestamp (3),
	"lease_token" text,
	"last_error" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "diagnostic_jobs_status_check" CHECK ("diagnostic_jobs"."status" IN ('pending','running','done','failed','abandoned')),
	CONSTRAINT "diagnostic_jobs_requested_by_check" CHECK ("diagnostic_jobs"."requested_by" IN ('trigger','cli','baseline'))
);
--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_device_rid_devices_rid_fk" FOREIGN KEY ("device_rid") REFERENCES "public"."devices"("rid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_capture_id_diagnostic_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."diagnostic_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_captures" ADD CONSTRAINT "diagnostic_captures_device_rid_devices_rid_fk" FOREIGN KEY ("device_rid") REFERENCES "public"."devices"("rid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_captures" ADD CONSTRAINT "diagnostic_captures_job_id_diagnostic_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."diagnostic_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_jobs" ADD CONSTRAINT "diagnostic_jobs_device_rid_devices_rid_fk" FOREIGN KEY ("device_rid") REFERENCES "public"."devices"("rid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_events_identity_unique" ON "device_events" USING btree ("device_rid","source","dedupe_key");--> statement-breakpoint
CREATE INDEX "device_events_timeline_idx" ON "device_events" USING btree ("device_rid","occurred_at");--> statement-breakpoint
CREATE INDEX "diagnostic_captures_device_idx" ON "diagnostic_captures" USING btree ("device_rid","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnostic_jobs_open_unique" ON "diagnostic_jobs" USING btree ("device_rid") WHERE status IN ('pending','running');--> statement-breakpoint
CREATE INDEX "diagnostic_jobs_due_idx" ON "diagnostic_jobs" USING btree ("status","next_attempt_at");