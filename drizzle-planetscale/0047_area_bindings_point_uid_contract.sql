-- 0047 config-v4 Phase 12 (slice E PR 2a): `area_bindings` contracts onto `point_uid`.
--
-- WHAT DIES: `area_bindings_point_info_fk` — the composite FK `(point_system_id, point_id) →
-- point_info(system_id, id)`, and **the only remaining foreign key into `point_info`** (verified by
-- check 3 below rather than asserted). Dropping it takes FKs into that table from 1 to 0, which is
-- precisely what unblocks slice N's terminal `point_info` drop. Also re-based: `area_bindings_unique`
-- (from `(area_id, role, metric_type, point_system_id, point_id)`) and `area_bindings_point_idx`
-- (from the int pair) — both now key on `point_uid`.
--
-- WHAT IS RELAXED, AND WHY IT IS PART OF THIS MIGRATION RATHER THAN THE NEXT: `point_system_id` and
-- `point_id` go NULLable. They are `NOT NULL` with NO DEFAULT, so the instant PR 2b's writers stop
-- naming them, EVERY binding INSERT would fail — a hard outage on the area editor — until the columns
-- were dropped. Expand/contract therefore splits in two: 0047 relaxes (so PR 2b's writers are free to
-- stop naming them), a later 0048 drops. Nothing reads the pair after PR 2b, and this migration is
-- what makes the intervening state representable.
--
-- WHY THIS IS SAFE, MECHANICALLY: `point_uid` is the same address as the pair, wearing a uuid. The
-- whole slice rests on that equivalence, so check 2 ASSERTS it inside the migration — joining every
-- binding back through `point_info(system_id, id)` and refusing if any row disagrees — rather than
-- trusting the out-of-band probe that motivated the work. That is the migration-0056 lesson: a
-- precondition verified in a psql session an hour ago is not a precondition of the DDL. (For the
-- record, both environments read 72/72 populated with ZERO disagreement when this was written, so
-- these checks are expected to be no-ops; they exist for the run where that is no longer true.)
--
-- `SET NOT NULL` on `point_uid` needs check 1 for a clear diagnosis, not for safety — Postgres would
-- refuse anyway, but with a row count instead of the area/role that is actually wrong. The column has
-- had an application writer since #279 (slice E PR 1) and is 100% populated on both environments,
-- which is what lets the slice-E code drop its `bindingPoint(...) → null` miss branches outright
-- instead of carrying dead nullability: nullability that preserves behaviour also HIDES a gap, and
-- the gap this one hid was a writer that never set the column.
--
-- The re-based unique index is STRICTLY STRONGER, not merely equivalent: because `point_uid` is NOT
-- NULL, two bindings on the same (area, role, metric) point can never both slip through as
-- NULL-distinct. Ordering matters for that reason — `SET NOT NULL` runs BEFORE the index is created
-- below; the reverse order would leave the index briefly unenforcing.
--
-- WHY HAND-WRITTEN: drizzle-kit emits the eight DDL statements below with NO validation — it will
-- happily drop the last FK into a table it is about to be told nothing references, and `SET NOT NULL`
-- on a column it has not checked. That is the migration-0016 failure mode in miniature. So: assert
-- the equivalence first, assert the FK inventory is what we think it is, and only then contract.
-- `meta/0047_snapshot.json` and the journal entry stay machine-written so a future `db:pg:generate`
-- still diffs clean.
--
-- NOTE the guard's RAISE NOTICEs are SWALLOWED under `npm run db:pg:migrate` (drizzle-orm's migrator
-- attaches no 'notice' listener — the slice-G lesson). Capture the row inventory by hand before
-- applying if you want it on the record.
--
-- Idempotent: a re-run finds `point_uid` already NOT NULL and skips every check, and each DDL
-- statement below is individually re-runnable (`DROP CONSTRAINT IF EXISTS`, `DROP INDEX IF EXISTS`,
-- and `SET`/`DROP NOT NULL` are no-ops when already applied). IRREVERSIBLE (this project has no
-- rollback migrations — undo is a new forward migration); prod PITR + the 2-hourly R2 pg_dump cover
-- recovery, and the FK itself is in any case recreatable from `area_bindings ⋈ point_info` for as
-- long as the int pair survives.
-- Preconditions: the slice-E PR 2a code is merged and DEPLOYED first (the readers must already be off
-- the int pair, and the prod→dev sync's ON CONFLICT must already name `point_uid` — it names an INDEX
-- BY ITS COLUMNS, so the manifest and this re-base move together), then prod `sydney`, then
-- `liveone-dev`. See the config-v4 epic record § Phase 12 slice E.

DO $$
DECLARE
  total_rows  bigint;
  missing_uid text;
  disagreeing text;
  pi_fks      text;
BEGIN
  IF (SELECT attnotnull
        FROM pg_attribute
       WHERE attrelid = 'public.area_bindings'::regclass
         AND attname  = 'point_uid') THEN
    RAISE NOTICE 'area_bindings.point_uid already NOT NULL — 0047 already applied, skipping checks';
    RETURN;
  END IF;

  SELECT count(*) INTO total_rows FROM area_bindings;

  -- 1. No NULL `point_uid`. `SET NOT NULL` would reject these on its own, but only as an anonymous
  --    "column contains null values" — this names the offending (area, role, metric) so the operator
  --    knows WHICH binding lost its writer rather than merely that one did.
  SELECT string_agg(format('(%s, %s/%s)', ab.area_id, ab.role, ab.metric_type), ', '
                    ORDER BY ab.area_id, ab.role)
    INTO missing_uid
    FROM area_bindings ab
   WHERE ab.point_uid IS NULL;

  IF missing_uid IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to contract area_bindings: binding(s) with a NULL point_uid (of % row(s)): %',
      total_rows, missing_uid;
  END IF;

  -- 2. THE equivalence the whole slice rests on: `point_uid` must name the SAME point as the
  --    `(point_system_id, point_id)` pair it replaces. Every converted reader assumes it, and after
  --    this migration the pair is gone as a cross-check — so if the two ever disagreed, the damage
  --    would be silent and permanent (an Area quietly serving another device's point). Asserted here,
  --    in the migration, and not merely probed beforehand. The LEFT JOIN is deliberate: a pair that
  --    matches NO point_info row yields NULL and is caught by the same IS DISTINCT FROM test.
  SELECT string_agg(format('(%s, %s/%s: uid=%s pair=%s.%s → %s)',
                           ab.area_id, ab.role, ab.metric_type,
                           ab.point_uid, ab.point_system_id, ab.point_id, pi.point_uid), ', ')
    INTO disagreeing
    FROM area_bindings ab
    LEFT JOIN point_info pi
      ON pi.system_id = ab.point_system_id AND pi.id = ab.point_id
   WHERE pi.point_uid IS DISTINCT FROM ab.point_uid;

  IF disagreeing IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to contract area_bindings: point_uid disagrees with the (point_system_id, point_id) pair: %',
      disagreeing;
  END IF;

  -- 3. `area_bindings_point_info_fk` must be the ONLY FK into `point_info`. The headline claim of this
  --    migration is that dropping it takes that count 1 → 0 and unblocks slice N; if a second FK has
  --    appeared since, that claim is false, and slice N would discover it later and further from the
  --    cause.
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO pi_fks
    FROM pg_constraint
   WHERE confrelid = 'public.point_info'::regclass
     AND conname <> 'area_bindings_point_info_fk';

  IF pi_fks IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to contract area_bindings: unexpected FK(s) into point_info besides area_bindings_point_info_fk: %',
      pi_fks;
  END IF;

  RAISE NOTICE 'checks ok: % area_bindings row(s), every point_uid agreeing with the legacy pair; area_bindings_point_info_fk is the only FK into point_info',
    total_rows;
END $$;--> statement-breakpoint
-- `point_uid` becomes the binding's address. FIRST, so the unique index re-based below is fully
-- enforcing the moment it exists (a nullable key would make same-slot NULL rows mutually distinct).
ALTER TABLE "area_bindings" ALTER COLUMN "point_uid" SET NOT NULL;--> statement-breakpoint
-- The last FK into `point_info`: 1 → 0. NO CASCADE anywhere in this migration — an unexpected
-- dependent must abort the run, not be silently removed.
ALTER TABLE "area_bindings" DROP CONSTRAINT IF EXISTS "area_bindings_point_info_fk";--> statement-breakpoint
-- Re-base both indexes off the int pair. Drop-and-recreate rather than CONCURRENTLY: `area_bindings`
-- is 72 rows, so the lock is measured in milliseconds and the transactional (all-or-nothing) form is
-- strictly the safer one here.
DROP INDEX IF EXISTS "area_bindings_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "area_bindings_unique" ON "area_bindings" USING btree ("area_id","role","metric_type","point_uid");--> statement-breakpoint
DROP INDEX IF EXISTS "area_bindings_point_idx";--> statement-breakpoint
CREATE INDEX "area_bindings_point_idx" ON "area_bindings" USING btree ("point_uid");--> statement-breakpoint
-- Relax the legacy pair LAST — see the header. Both are NOT NULL with no default, so PR 2b's writers
-- cannot stop naming them until this lands. 0048 drops the columns outright.
ALTER TABLE "area_bindings" ALTER COLUMN "point_system_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "area_bindings" ALTER COLUMN "point_id" DROP NOT NULL;
