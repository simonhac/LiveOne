CREATE TABLE "observations_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"system_id" integer NOT NULL,
	"session_id" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "observations_outbox" USING btree ("created_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_session_seq_unique" ON "observations_outbox" USING btree ("system_id","session_id","seq") WHERE session_id IS NOT NULL;