ALTER TABLE "dashboards" ALTER COLUMN "system_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "alias" text;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_owner_alias_unique" ON "dashboards" USING btree ("clerk_user_id","alias");