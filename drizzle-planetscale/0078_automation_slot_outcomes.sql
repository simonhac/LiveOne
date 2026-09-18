CREATE TABLE "automation_slot_outcomes" (
	"automation_id" uuid NOT NULL,
	"slot_at" timestamp (3) NOT NULL,
	"outcome" text NOT NULL,
	"decided_at" timestamp (3) NOT NULL,
	"context" jsonb NOT NULL,
	CONSTRAINT "automation_slot_outcomes_pk" PRIMARY KEY("automation_id","slot_at"),
	CONSTRAINT "automation_slot_outcomes_outcome_check" CHECK ("automation_slot_outcomes"."outcome" IN ('fired','satisfied','missed','missed-running','skipped-full','aborted-complete','aborted-unloaded'))
);
--> statement-breakpoint
ALTER TABLE "automation_slot_outcomes" ADD CONSTRAINT "automation_slot_outcomes_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Seed from what survives: `automations.armed_context` holds the LATEST decision per rule, so
-- exactly one slot per exercise rule is still recoverable (5 rows on prod at the time of writing).
-- Everything older was overwritten tick by tick and is simply gone — which is the whole reason this
-- table exists. Without the seed the calendar feed would show the most recent decided slot as ⛔️
-- (no record, grace expired) on the very first render.
--
-- `waiting` is excluded because it is not a decision, and ON CONFLICT DO NOTHING makes the
-- statement idempotent — a re-run after the evaluator has written real rows must not clobber them.
INSERT INTO "automation_slot_outcomes" ("automation_id", "slot_at", "outcome", "decided_at", "context")
SELECT
	"id",
	to_timestamp(("armed_context" ->> 'slotAt')::bigint / 1000.0) AT TIME ZONE 'UTC',
	"armed_context" ->> 'outcome',
	to_timestamp(("armed_context" ->> 'at')::bigint / 1000.0) AT TIME ZONE 'UTC',
	"armed_context"
FROM "automations"
WHERE "armed_context" ->> 'kind' = 'exercise'
	AND "armed_context" ->> 'outcome' <> 'waiting'
	AND "armed_context" ->> 'slotAt' IS NOT NULL
	AND "armed_context" ->> 'at' IS NOT NULL
ON CONFLICT DO NOTHING;
