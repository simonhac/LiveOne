-- config-v4 Phase 10 — drop the retained `_old` hot tables + the `backfill_progress` orphan.
--
-- WHAT DIES.
--   * `point_readings_old` / `point_readings_agg_5m_old` / `point_readings_agg_1d_old` — the
--     pre-cutover copies kept by config-transform stage 4's rename-swap as the abort path. The swap is
--     ~2 days behind us, parity was 60/61 green, and the live (point_rid, time)-keyed tables have been
--     the sole serving store since. ~4.2 GB.
--   * `backfill_progress` — an orphan from the June-2026 Turso decommission: never declared in
--     `schema.ts`, never in a migration, zero repo references, 29 rows.
--
-- WHY HAND-WRITTEN. drizzle-kit emits a bare `DROP TABLE … CASCADE` with no validation — precisely the
-- migration-0016 failure mode (345K rows lost to an unvalidated drop). Each drop below is gated by a
-- `DO` / `RAISE EXCEPTION` guard that aborts the whole transaction if the live table does not still
-- contain everything its `_old` counterpart holds.
--
-- GUARD SEMANTICS — `>=`, NOT `>`. The obvious "live is strictly ahead of _old" check is WRONG for
-- `liveone-dev`: crons are disabled there (CRONS_ENABLED unset), so nothing has been written to the
-- live tables since the cutover copy and live == _old exactly (verified 2026-07-27:
-- point_readings 15,355,536 both sides, identical max(measurement_time)). A `>` guard would abort on
-- dev for a perfectly healthy database. The real invariant is containment: live must hold AT LEAST
-- what _old held, on both row count and high-water mark. On prod live is genuinely ahead.
--
-- IRREVERSIBLE. Preconditions (checklist, the config-v4 epic record §Phase 10 step 6):
-- the validation window has passed, a one-off `pscale backup create` has been taken, and the 2-hourly
-- R2 dumps from before this migration still contain the `_old` data (retention: daily 21d / weekly 91d
-- / monthly 365d).

--> statement-breakpoint
DO $$
DECLARE live_n bigint; old_n bigint; live_t timestamp; old_t timestamp;
BEGIN
  IF to_regclass('point_readings_old') IS NULL THEN RAISE NOTICE 'point_readings_old absent — skipping'; RETURN; END IF;
  SELECT count(*), max(measurement_time) INTO live_n, live_t FROM point_readings;
  SELECT count(*), max(measurement_time) INTO old_n,  old_t  FROM point_readings_old;
  IF live_n < old_n THEN
    RAISE EXCEPTION 'ABORT: point_readings has % rows, fewer than point_readings_old (%). The cutover copy is INCOMPLETE — do not drop.', live_n, old_n;
  END IF;
  IF live_t IS NULL OR old_t IS NULL OR live_t < old_t THEN
    RAISE EXCEPTION 'ABORT: point_readings max(measurement_time)=% is behind point_readings_old (%).', live_t, old_t;
  END IF;
  RAISE NOTICE 'point_readings guard OK: live % rows (max %) >= old % rows (max %)', live_n, live_t, old_n, old_t;
  DROP TABLE point_readings_old;
END $$;--> statement-breakpoint

DO $$
DECLARE live_n bigint; old_n bigint; live_t timestamp; old_t timestamp;
BEGIN
  IF to_regclass('point_readings_agg_5m_old') IS NULL THEN RAISE NOTICE 'agg_5m_old absent — skipping'; RETURN; END IF;
  SELECT count(*), max(interval_end) INTO live_n, live_t FROM point_readings_agg_5m;
  SELECT count(*), max(interval_end) INTO old_n,  old_t  FROM point_readings_agg_5m_old;
  IF live_n < old_n THEN
    RAISE EXCEPTION 'ABORT: point_readings_agg_5m has % rows, fewer than _old (%).', live_n, old_n;
  END IF;
  IF live_t IS NULL OR old_t IS NULL OR live_t < old_t THEN
    RAISE EXCEPTION 'ABORT: point_readings_agg_5m max(interval_end)=% is behind _old (%).', live_t, old_t;
  END IF;
  RAISE NOTICE 'agg_5m guard OK: live % rows (max %) >= old % rows (max %)', live_n, live_t, old_n, old_t;
  DROP TABLE point_readings_agg_5m_old;
END $$;--> statement-breakpoint

DO $$
DECLARE live_n bigint; old_n bigint; live_d text; old_d text;
BEGIN
  IF to_regclass('point_readings_agg_1d_old') IS NULL THEN RAISE NOTICE 'agg_1d_old absent — skipping'; RETURN; END IF;
  SELECT count(*), max(day) INTO live_n, live_d FROM point_readings_agg_1d;
  SELECT count(*), max(day) INTO old_n,  old_d  FROM point_readings_agg_1d_old;
  IF live_n < old_n THEN
    RAISE EXCEPTION 'ABORT: point_readings_agg_1d has % rows, fewer than _old (%).', live_n, old_n;
  END IF;
  IF live_d IS NULL OR old_d IS NULL OR live_d < old_d THEN
    RAISE EXCEPTION 'ABORT: point_readings_agg_1d max(day)=% is behind _old (%).', live_d, old_d;
  END IF;
  RAISE NOTICE 'agg_1d guard OK: live % rows (max %) >= old % rows (max %)', live_n, live_d, old_n, old_d;
  DROP TABLE point_readings_agg_1d_old;
END $$;--> statement-breakpoint

-- backfill_progress: no guard to write — it is referenced by nothing, in no migration, and in no
-- schema. Dropped unconditionally, but IF EXISTS so the file stays no-op-safe / re-runnable.
DROP TABLE IF EXISTS backfill_progress;
