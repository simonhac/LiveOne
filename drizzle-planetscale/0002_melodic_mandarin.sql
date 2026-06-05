-- PR-7a: session id → text (UUIDv7). Historical ids become stringified ints (E1).
--
-- Postgres is a mirror-only DB here (production reads come from Turso until
-- PR-10/PR-12), so the ACCESS EXCLUSIVE locks below only briefly block the QStash
-- receiver — it returns 500 and QStash retries; there is no user-facing downtime.

-- sessions.id was `serial`: drop the serial default + owned sequence first, then
-- retype to text. The receiver always supplies an explicit id, so no default is
-- needed. integer → text uses the built-in assignment cast (no USING required).
ALTER TABLE "sessions" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
DROP SEQUENCE IF EXISTS "sessions_id_seq";--> statement-breakpoint

-- agg_5m is moderate; point_readings is ~13M rows (a full table rewrite under
-- ACCESS EXCLUSIVE — minutes of receiver lag, self-healing via QStash retry).
ALTER TABLE "point_readings_agg_5m" ALTER COLUMN "session_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "point_readings" ALTER COLUMN "session_id" SET DATA TYPE text;
