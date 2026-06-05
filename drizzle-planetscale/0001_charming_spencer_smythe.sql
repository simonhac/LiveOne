CREATE TABLE "share_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"owner_clerk_user_id" text NOT NULL,
	"label" text,
	"created_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint,
	"revoked_at_ms" bigint,
	"last_used_at_ms" bigint
);
--> statement-breakpoint
CREATE INDEX "share_tokens_owner_idx" ON "share_tokens" USING btree ("owner_clerk_user_id");