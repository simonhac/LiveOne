-- config-v4 Phase 11 — derived_intervals.derivation_id gains ON DELETE CASCADE.
--
-- Intervals are disposable derived output: every row is reproducible from the readings by a plain
-- recompute (lib/run-tracking/recompute.ts). So they should follow their derivation rather than
-- block its delete — which is also what lets the prod→dev sync clear a drifted area's `derivations`
-- children without a bespoke two-step delete.
--
-- Metadata-only and instant: re-validating the FK touches only `derived_intervals`, which is empty
-- until the Phase-11 fill runs. Guarded so the file is idempotent and no-op-safe on any DB shape.
DO $$
BEGIN
  -- Scope by conrelid, not conname alone: a constraint name is unique per TABLE, not per schema.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.derived_intervals'::regclass
      AND conname = 'derived_intervals_derivation_id_derivations_id_fk'
      AND confdeltype <> 'c'  -- 'c' = CASCADE; an already-converted FK is left alone
  ) THEN
    ALTER TABLE "derived_intervals"
      DROP CONSTRAINT "derived_intervals_derivation_id_derivations_id_fk";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.derived_intervals'::regclass
      AND conname = 'derived_intervals_derivation_id_derivations_id_fk'
  ) THEN
    ALTER TABLE "derived_intervals"
      ADD CONSTRAINT "derived_intervals_derivation_id_derivations_id_fk"
      FOREIGN KEY ("derivation_id") REFERENCES "public"."derivations"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
