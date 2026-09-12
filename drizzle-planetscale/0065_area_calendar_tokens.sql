CREATE TABLE "area_calendar_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"area_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"expires_at" timestamp (3),
	"revoked_at" timestamp (3),
	"last_used_at" timestamp (3)
);
--> statement-breakpoint
ALTER TABLE "area_calendar_tokens" ADD CONSTRAINT "area_calendar_tokens_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "act_area_idx" ON "area_calendar_tokens" USING btree ("area_id");