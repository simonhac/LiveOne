-- 0075 — `devices.status`: rename the value `removed` → `archived`.
--
-- ## Why
--
-- Two tables spell the same idea two different ways. `areas.status` has always used `archived`;
-- `devices.status` has always used `removed`. Nothing turns on the difference — both mean "this row
-- is retained but retired" — and the cost of the split is paid every time anyone reads across them.
-- `liveone tree` prints both side by side, `[removed]` on a device and `[archived]` on an area, and
-- an operator has to know that those are the same state before they can act on either.
--
-- So this is a vocabulary change, not a semantic one. No row changes meaning; four rows change
-- spelling.
--
-- ## 🛑 THIS MIGRATION AND ITS DEPLOY ARE NOT INTERCHANGEABLE IN ORDER
--
-- Migrations here are MANUAL and are normally applied BEFORE the dependent code ships, which is the
-- right order for an additive change and the WRONG order for this one. Between this migration and
-- the deploy, the running build still writes `'removed'` — and the constraint below rejects it. The
-- symptom would be a 23514 on any device status write (`POST /api/admin/devices/{id}/status`, the
-- Enphase and Tesla disconnect routes), not a silent divergence.
--
-- That window is accepted deliberately rather than engineered away with a three-landing
-- expand/contract, because the exposure is a few minutes of one operator's own admin surface on a
-- single-user deployment, and nothing on the collection path writes `status` at all. Apply it
-- IMMEDIATELY BEFORE the deploy that carries the code, and do not leave it half-done overnight.
--
-- ## 🛑 APPLY TO **BOTH** DATABASES, OR THE PROD→DEV SYNC STOPS
--
-- This is the constraint that actually widens the window, and it is not about the app at all.
-- `assertManifestSchemaParity` (`lib/readings/prod-dev-sync.ts`) compares `pg_get_constraintdef` for
-- every table in the sync manifest before it stages ANY data, and `devices` is in that manifest. So
-- a `devices_status_check` that reads `…'removed')` on one side and `…'archived')` on the other is a
-- schema mismatch, and the 2-hourly `sync-prod-to-dev` Action aborts WHOLESALE — not just the
-- `devices` leg. The dev mirror silently stops advancing until both sides match.
--
-- Apply to prod (`npm run pg-migrate -- --apply`) AND to `liveone-dev`
-- (`npm run db:pg:migrate`) in the same sitting. Order between them does not matter; the gap does.
--
-- Re-runnable: the UPDATE is a no-op the second time and both constraint statements are guarded.

--> statement-breakpoint
-- The old constraint has to go first — it forbids the very value the UPDATE is about to write.
-- `IF EXISTS` so a partially-applied run can be finished rather than unpicked.
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_status_check";

--> statement-breakpoint
-- On the record: how many rows this actually touched. Not a gate — zero is a perfectly good answer
-- (it means the code deployed first, or the migration is being re-run), and so is four.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM devices WHERE status = 'removed';
  UPDATE devices SET status = 'archived' WHERE status = 'removed';
  RAISE NOTICE 're-spelled % device(s) from removed to archived', n;
END $$;

--> statement-breakpoint
-- GATE: nothing is left holding the retired spelling.
--
-- Cheap, and it is the one thing that would make the constraint below fail with a message about a
-- constraint rather than about the data. `devices` is a small config table, so an exact count is
-- free here in a way it would never be on `point_readings`.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM devices WHERE status = 'removed';
  IF n > 0 THEN
    RAISE EXCEPTION 'GATE: % device(s) still have status=removed after the rewrite — the UPDATE above did not take, and adding the new constraint would fail with a constraint name instead of this sentence.', n;
  END IF;
END $$;

--> statement-breakpoint
-- The new vocabulary, matching `areas.status`. Guarded so a re-run does not fail on a duplicate.
-- 🛑 `conrelid` is NOT optional here. Constraint names are unique per TABLE, not per database, so
-- a bare `conname` lookup can be satisfied by an identically-named constraint on some other table —
-- at which point this block silently skips the ADD, having already dropped the real one and
-- rewritten the rows, and reports success on a `devices` table with NO status constraint at all.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devices_status_check'
       AND conrelid = 'public.devices'::regclass
  ) THEN
    ALTER TABLE "devices"
      ADD CONSTRAINT "devices_status_check"
      CHECK ("status" IN ('active','disabled','archived'));
  END IF;
END $$;
