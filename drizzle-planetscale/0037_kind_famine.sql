ALTER TABLE "dashboard_share_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "dashboard_share_tokens" CASCADE;--> statement-breakpoint
DROP INDEX "share_tokens_owner_idx";--> statement-breakpoint
ALTER TABLE "dashboard_grants" DROP COLUMN "created_at_ms";--> statement-breakpoint
ALTER TABLE "share_tokens" DROP COLUMN "owner_clerk_user_id";--> statement-breakpoint
ALTER TABLE "share_tokens" DROP COLUMN "created_at_ms";--> statement-breakpoint
ALTER TABLE "share_tokens" DROP COLUMN "expires_at_ms";--> statement-breakpoint
ALTER TABLE "share_tokens" DROP COLUMN "revoked_at_ms";--> statement-breakpoint
ALTER TABLE "share_tokens" DROP COLUMN "last_used_at_ms";