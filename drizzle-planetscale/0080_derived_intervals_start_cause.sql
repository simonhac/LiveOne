-- Why a run started (lib/run-tracking/start-cause.ts). Additive + nullable, no CHECK: NULL = unknown,
-- and a constraint would have to land on prod and liveone-dev together or the prod→dev sync aborts.
ALTER TABLE "derived_intervals" ADD COLUMN IF NOT EXISTS "start_cause" text;--> statement-breakpoint
ALTER TABLE "derived_intervals" ADD COLUMN IF NOT EXISTS "start_requested_by" text;
