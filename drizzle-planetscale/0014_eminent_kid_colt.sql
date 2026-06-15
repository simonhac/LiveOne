-- Retire composite-as-system: drop the systems FKs that block/cascade/null the delete, then DELETE
-- the fake composite `systems` rows. Composites are now areas-backed virtual systems (SystemsManager
-- synthesizes them from `areas` by `legacy_system_id`), so the rows are redundant. Guarded: aborts
-- (transactionally, before any destructive statement) unless every composite has a backing Area with
-- bindings. flow_1d is already area-keyed (0013) and composites own no point_readings, so no
-- measurement data is touched. See docs/deferred/areas-p3-tail-and-p4-plan.md.

-- Guard 1: every composite system must have a backing composite Area (so the synthesized virtual
-- system covers its integer handle after the delete).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM systems s
    WHERE s.vendor_type = 'composite'
      AND NOT EXISTS (
        SELECT 1 FROM areas a WHERE a.kind = 'composite' AND a.legacy_system_id = s.id
      )
  ) THEN RAISE EXCEPTION 'a composite system has no backing composite Area — aborting before delete'; END IF;
END $$;--> statement-breakpoint

-- Guard 2: each such composite Area must have >=1 binding (never strand a composite with no points).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM areas a
    WHERE a.kind = 'composite'
      AND a.legacy_system_id IN (SELECT id FROM systems WHERE vendor_type = 'composite')
      AND NOT EXISTS (SELECT 1 FROM area_bindings b WHERE b.area_id = a.id)
  ) THEN RAISE EXCEPTION 'a composite Area has no bindings — aborting before delete'; END IF;
END $$;--> statement-breakpoint

-- Drop the systems FKs that would otherwise destroy/null/refuse the delete. All three columns become
-- plain integer addressing handles (resolved via getSystem → the synthesized virtual system):
--   areas.legacy_system_id   (no-action)  → would REFUSE the delete
--   dashboards.system_id     (cascade)    → would DELETE the composite dashboard
--   users.default_system_id  (set-null)   → would NULL a user's composite default (un-re-settable)
-- areas_legacy_system_unique stays as the addressing invariant.
ALTER TABLE "areas" DROP CONSTRAINT IF EXISTS "areas_legacy_system_id_systems_id_fk";--> statement-breakpoint
ALTER TABLE "dashboards" DROP CONSTRAINT IF EXISTS "dashboards_system_id_systems_id_fk";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_default_system_id_systems_id_fk";--> statement-breakpoint

-- The delete: only composites that have a backing composite Area (belt + suspenders with Guard 1).
DELETE FROM "systems"
  WHERE vendor_type = 'composite'
    AND id IN (SELECT legacy_system_id FROM areas WHERE kind = 'composite');--> statement-breakpoint

-- Guard 3: no composite systems rows remain.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM systems WHERE vendor_type = 'composite')
  THEN RAISE EXCEPTION 'composite systems still present after delete'; END IF;
END $$;
