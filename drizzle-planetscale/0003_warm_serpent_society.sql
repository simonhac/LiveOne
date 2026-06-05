-- PR-7b: add the session FK and drop the now-redundant dedup unique.
--
-- ORDER / GATING (run during the cutover, AFTER PR-7b co-enqueue is deployed and
-- the queue has drained to lag=0): co-enqueue guarantees the receiver inserts the
-- session BEFORE its readings in one transaction, so the FK is satisfiable for
-- new rows. PRECONDITION — the orphan check must return 0 first:
--   SELECT count(*) FROM point_readings pr
--   WHERE pr.session_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = pr.session_id);
-- (If > 0, null out / backfill the offending session_ids before VALIDATE.)
--
-- Postgres is mirror-only here, so even VALIDATE's SHARE UPDATE EXCLUSIVE scan
-- does not block production reads.

-- Drop the old (system_id, created_at) unique: it was a dedup crutch for the
-- separate-session-publish path. With UUIDv7 text PKs the id guarantees
-- distinctness, and the unique would reject legitimate same-instant sessions
-- (and could itself have orphaned readings by dropping a duplicate session).
DROP INDEX "sessions_system_created_at_unique";--> statement-breakpoint

-- Add the FK NOT VALID first (brief lock; enforces NEW rows immediately,
-- skips the full-table scan), then VALIDATE (scans existing ~13M rows under a
-- non-blocking lock to prove they comply).
ALTER TABLE "point_readings" ADD CONSTRAINT "point_readings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "point_readings" VALIDATE CONSTRAINT "point_readings_session_id_sessions_id_fk";
