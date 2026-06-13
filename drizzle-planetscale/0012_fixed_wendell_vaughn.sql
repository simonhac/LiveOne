CREATE TABLE "dashboard_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" integer NOT NULL,
	"clerk_user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_share_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"dashboard_id" integer NOT NULL,
	"label" text,
	"created_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint,
	"revoked_at_ms" bigint,
	"last_used_at_ms" bigint
);
--> statement-breakpoint
ALTER TABLE "dashboard_grants" ADD CONSTRAINT "dashboard_grants_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_share_tokens" ADD CONSTRAINT "dashboard_share_tokens_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_grants_dashboard_user_unique" ON "dashboard_grants" USING btree ("dashboard_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "dashboard_grants_user_idx" ON "dashboard_grants" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "dashboard_share_tokens_dashboard_idx" ON "dashboard_share_tokens" USING btree ("dashboard_id");