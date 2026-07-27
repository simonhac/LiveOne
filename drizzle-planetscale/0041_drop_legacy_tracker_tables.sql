-- config-v4 Phase 11 (PR 2): drop the legacy run-tracking tables.
--
-- `derivations` / `derived_intervals` have been the sole read+write path since PR 1 (#256) shipped;
-- these two tables have had no reader or writer since, and PR 2 deleted the last references (the
-- fill/verify scripts and their schema declarations). Dropping them releases two of the three
-- composite FKs into `point_info` and two of the three FKs into `roles` — the Phase-12 unblock this
-- phase exists for.
--
-- Guarded, per the migration checklist: drizzle emits a bare `DROP TABLE ... CASCADE`, which would
-- happily drop a table whose replacement never got populated. So assert coverage first, and drop
-- WITHOUT cascade so an unexpected dependent aborts the migration instead of being silently removed.
-- Idempotent: a re-run finds the tables absent and skips.

DO $$
DECLARE
  legacy_count  bigint;
  live_count    bigint;
  legacy_latest timestamp;
  live_latest   timestamp;
BEGIN
  IF to_regclass('public.device_run_periods') IS NULL THEN
    RAISE NOTICE 'device_run_periods already absent — nothing to validate';
    RETURN;
  END IF;

  SELECT count(*), max(start_time) INTO legacy_count, legacy_latest FROM device_run_periods;
  SELECT count(*), max(start_time) INTO live_count,   live_latest   FROM derived_intervals;

  -- derived_intervals is the live store and only grows (the minutely cron keeps reconciling), while
  -- device_run_periods has been frozen since the fill. Fewer live rows, or a live store that trails
  -- the frozen one, means the re-key lost runs — stop before the data is unrecoverable.
  IF live_count < legacy_count THEN
    RAISE EXCEPTION 'refusing to drop: derived_intervals has % rows, device_run_periods has %',
      live_count, legacy_count;
  END IF;

  IF legacy_latest IS NOT NULL AND (live_latest IS NULL OR live_latest < legacy_latest) THEN
    RAISE EXCEPTION 'refusing to drop: derived_intervals latest start_time % trails device_run_periods %',
      live_latest, legacy_latest;
  END IF;

  RAISE NOTICE 'coverage ok: derived_intervals % rows (latest %), device_run_periods % rows (latest %)',
    live_count, live_latest, legacy_count, legacy_latest;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "device_run_periods";--> statement-breakpoint
DROP TABLE IF EXISTS "device_trackers";
