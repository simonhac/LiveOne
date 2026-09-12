CREATE TABLE "collectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"destination" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_pollers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collector_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"source" text NOT NULL,
	"vendor_site_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"applied_revision" integer DEFAULT 0 NOT NULL,
	"paused" boolean DEFAULT true NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"status" jsonb,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "managed_pollers_revision_check" CHECK ("managed_pollers"."revision" > 0 AND "managed_pollers"."applied_revision" >= 0 AND "managed_pollers"."applied_revision" <= "managed_pollers"."revision"),
	CONSTRAINT "managed_pollers_source_check" CHECK ("managed_pollers"."source" IN ('deepsea','fronius','selectronic','sigenergy'))
);
--> statement-breakpoint
ALTER TABLE "managed_pollers" ADD CONSTRAINT "managed_pollers_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_pollers" ADD CONSTRAINT "managed_pollers_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_pollers_collector_idx" ON "managed_pollers" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "managed_pollers_device_idx" ON "managed_pollers" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_pollers_active_unique" ON "managed_pollers" USING btree ("device_id","source") WHERE NOT "managed_pollers"."deleted";