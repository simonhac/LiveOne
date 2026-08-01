-- 0046 config-v4 Phase 12 (slice H): drop the `area_devices` table.
--
-- WHAT DIES: the `area_devices` table (3 columns — `area_id uuid`, `system_id integer`, `ordinal integer`
-- — PK `area_devices_area_id_system_id_pk`, FK `area_devices_area_id_areas_id_fk`). Nothing references
-- it: its own PK is the only constraint on it, and no other table FKs into it. Membership now lives in
-- `area_members (area_id, device_id → devices.id, ordinal)`, which the slice-H code reads and writes
-- exclusively (lib/areas/members.ts).
--
-- WHY THIS IS SAFE, MECHANICALLY: `area_members` is the same relation keyed on the device uuid instead
-- of the integer handle, and the two are bridged by the seam invariant `devices.rid == systems.id`
-- (lib/registry/v4-mirror.ts). So `area_devices` is redundant iff every one of its rows has a matching
-- `area_members` row under that bridge — which is exactly what the guard below asserts, per row, naming
-- any offender. Row COUNTS are deliberately not compared: by the time this runs the new code has been
-- writing `area_members` alone for at least one deploy, so `area_members ⊇ area_devices` is the correct
-- invariant and equality would spuriously fail on any membership edited after that deploy.
--
-- The old column had NO foreign key by design — migration 0014 could delete a member's `systems` row —
-- so the guard also checks the converse direction: an `area_devices.system_id` with no `devices.rid` is
-- UNREPRESENTABLE in `area_members` and must abort rather than vanish. (In practice `deleteSystem`
-- orphans its `devices` row rather than deleting it, which is what keeps that case satisfiable; see the
-- `area_members` header in lib/db/planetscale/schema.ts.)
--
-- WHY HAND-WRITTEN: drizzle-kit emits `DROP TABLE "area_devices" CASCADE` with no validation —
-- precisely the migration-0016 failure mode (345K rows lost to an unvalidated drop), and 0037 is the
-- local proof it still bites. So: assert coverage first, assert nothing unexpected depends on the
-- table, and drop WITHOUT cascade so an unexpected dependent aborts the migration instead of being
-- silently removed. `meta/0046_snapshot.json` and the journal entry stay machine-written so a future
-- `db:pg:generate` still diffs clean.
--
-- NOTE the guard's RAISE NOTICEs are SWALLOWED under `npm run db:pg:migrate` (drizzle-orm's migrator
-- attaches no 'notice' listener — the slice-G lesson). Capture the row inventory by hand before
-- applying if you want it on the record.
--
-- Idempotent: a re-run finds the table absent and skips. IRREVERSIBLE (this project has no rollback
-- migrations — undo is a new forward migration); prod PITR + the 2-hourly R2 pg_dump cover recovery,
-- and the table is in any case rederivable from `area_members ⋈ devices`.
-- Preconditions: the slice-H code is merged and DEPLOYED first (this is a [D] slice), then prod
-- `sydney`, then `liveone-dev`. See the config-v4 epic record § Phase 12 slice H.

DO $$
DECLARE
  legacy_rows bigint;
  live_rows   bigint;
  unmappable  text;
  uncovered   text;
  extra_fks   text;
BEGIN
  IF to_regclass('public.area_devices') IS NULL THEN
    RAISE NOTICE 'area_devices already absent — nothing to validate';
    RETURN;
  END IF;

  SELECT count(*) INTO legacy_rows FROM area_devices;
  SELECT count(*) INTO live_rows   FROM area_members;

  -- 1. Every legacy member must be REPRESENTABLE: `area_members.device_id` is a hard FK into `devices`,
  --    so a member whose handle has no `devices.rid` could never have been mirrored across. Catch it
  --    here rather than discovering the membership silently gone after the drop.
  SELECT string_agg(format('(%s, %s)', ad.area_id, ad.system_id), ', ' ORDER BY ad.system_id)
    INTO unmappable
    FROM area_devices ad
   WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = ad.system_id);

  IF unmappable IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop area_devices: row(s) with no devices.rid to map onto: %',
      unmappable;
  END IF;

  -- 2. Coverage, one-directional: area_devices ⊆ area_members, matched through the rid bridge. An
  --    extra `area_members` row is EXPECTED (the deployed code writes only that table); a leftover
  --    `area_devices` row is the fault, and means a membership edit predating the deploy never crossed.
  SELECT string_agg(format('(%s, %s)', ad.area_id, ad.system_id), ', ' ORDER BY ad.system_id)
    INTO uncovered
    FROM area_devices ad
    JOIN devices d ON d.rid = ad.system_id
   WHERE NOT EXISTS (
     SELECT 1 FROM area_members am
      WHERE am.area_id = ad.area_id AND am.device_id = d.id
   );

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop area_devices: row(s) absent from area_members (of % legacy row(s)): %',
      legacy_rows, uncovered;
  END IF;

  -- 3. Nothing may FK into the table. There is none today (the mirror of 0044's check); if one has
  --    appeared, a CASCADE would remove it silently — so abort instead.
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO extra_fks
    FROM pg_constraint
   WHERE confrelid = 'public.area_devices'::regclass;

  IF extra_fks IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop area_devices: unexpected FK dependent(s): %', extra_fks;
  END IF;

  RAISE NOTICE 'checks ok: area_devices has % row(s), all covered by area_members (% row(s)); no FK dependents',
    legacy_rows, live_rows;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "area_devices";
