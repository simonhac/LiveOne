-- config-v4 Phase 10 — rename the hot-table index/PK names from the cutover's `_new` to canonical.
--
-- The last cosmetic residue of the Phase 8 cutover. config-transform stage 4 built the replacement hot
-- tables as `*_new` and, per its own D-g note, could NOT rename their indexes to canonical inside the
-- swap: index and PK-constraint names are schema-GLOBALLY unique in Postgres, and the retained `_old`
-- tables still owned `point_readings_pkey` / `pr_measurement_time_idx` / `pr_created_at_idx` / the
-- `pr5m_*` / `pr1d_day_idx` set. Any earlier attempt is a 42P07. Migration 0038 dropped `_old`, so the
-- names are finally free (verified: all 9 targets unoccupied before this ran).
--
-- WHY HAND-WRITTEN. drizzle-kit cannot express a rename — it emits DROP INDEX + CREATE INDEX, which on
-- the 15M-row `point_readings` is a multi-minute rebuild that would lock the serving path. `ALTER INDEX
-- … RENAME` is an instant catalog-only update. `meta/0039_snapshot.json` is therefore transplanted from
-- a scratch generate-from-empty (the same technique as 0036) rather than produced by generate.
--
-- Renames a PRIMARY KEY by its backing index: `ALTER INDEX` renames both the index and its constraint,
-- so the `*_pkey` entries below cover the PK constraints too.
--
-- Guarded + idempotent: each rename fires only if the old name exists and the new one does not.

--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('point_readings_new_pkey') IS NOT NULL AND to_regclass('point_readings_pkey') IS NULL THEN
    ALTER INDEX point_readings_new_pkey RENAME TO point_readings_pkey;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr_new_measurement_time_idx') IS NOT NULL AND to_regclass('pr_measurement_time_idx') IS NULL THEN
    ALTER INDEX pr_new_measurement_time_idx RENAME TO pr_measurement_time_idx;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr_new_created_at_idx') IS NOT NULL AND to_regclass('pr_created_at_idx') IS NULL THEN
    ALTER INDEX pr_new_created_at_idx RENAME TO pr_created_at_idx;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr5m_new_pkey') IS NOT NULL AND to_regclass('pr5m_pkey') IS NULL THEN
    ALTER INDEX pr5m_new_pkey RENAME TO pr5m_pkey;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr5m_new_interval_end_idx') IS NOT NULL AND to_regclass('pr5m_interval_end_idx') IS NULL THEN
    ALTER INDEX pr5m_new_interval_end_idx RENAME TO pr5m_interval_end_idx;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr5m_new_created_at_idx') IS NOT NULL AND to_regclass('pr5m_created_at_idx') IS NULL THEN
    ALTER INDEX pr5m_new_created_at_idx RENAME TO pr5m_created_at_idx;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr5m_new_updated_at_idx') IS NOT NULL AND to_regclass('pr5m_updated_at_idx') IS NULL THEN
    ALTER INDEX pr5m_new_updated_at_idx RENAME TO pr5m_updated_at_idx;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr1d_new_pkey') IS NOT NULL AND to_regclass('pr1d_pkey') IS NULL THEN
    ALTER INDEX pr1d_new_pkey RENAME TO pr1d_pkey;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('pr1d_new_day_idx') IS NOT NULL AND to_regclass('pr1d_day_idx') IS NULL THEN
    ALTER INDEX pr1d_new_day_idx RENAME TO pr1d_day_idx;
  END IF;
END $$;
