-- 0069 — CONTRACT. Drop `derivations.area_id` and `derivations.source_points`.
--
-- The closing half of 0063's expand/contract. 0063 created `derivation_sources` — a derivation's
-- typed input ports as rows, with the wiring PROVED by a composite FK rather than trusted — and
-- demoted both of these columns to dual-written vestiges that nothing resolves a derivation
-- through. Every reader moved off them in the PRs that followed; this drops them.
--
-- 🛑 **Order, and it is three steps, not two:**
--
--   1. apply 0068 (`source_points` nullable) — BEFORE the deploy;
--   2. merge and DEPLOY the `schema.ts` removal — and wait for it to be live;
--   3. apply THIS — AFTER that deploy.
--
-- Step 2 before step 3 because four reads of `derivations` are whole-table projections
-- (`.select({ d: derivations, … })` in lib/derivations/scope.ts and resolve.ts, and a bare
-- `.returning()` in v4-routes.ts) and drizzle expands those to the DECLARED columns: a deployment
-- still declaring a dropped column 42703s on every read of the derivations surface. The same trap
-- cost time at 0052 (`areas.legacy_system_id` vs `prod-dev-sync`'s `neutralize`).
-- Step 1 before step 2 because the new code INSERTs without `source_points` — see 0068, which
-- exists for that reason alone.
--
-- What is lost, deliberately:
--
--   • `derivations_area_role_unique` — "one detector per (area, role)". It was already only half
--     alive: every row written since 0063 carries `area_id = NULL`, and a unique index does not
--     constrain NULLs. Its successors are `derivation_sources_signal_role_unique` — partial, on
--     (device_id, kind, role) WHERE role IS NOT NULL AND slot = 'signal' — and
--     `ensureRunDetector`'s `owner-role-taken` check, which is CODE, not a constraint, and honestly
--     so: two detectors whose SIGNALS sit on different devices can still resolve to the same OWNER
--     device and fight over one `<stem>/running` point, and no index can express that. See the note
--     at lib/derivations/resolve.ts.
--   • The FK to `areas`. An area delete no longer touches a derivation at all, because a
--     derivation's site is its owner device. `areaDependents` loses its derivation leg for the same
--     reason — the protection moved to `derivation_sources.point_id`'s FK ("you cannot delete a
--     point a live derivation reads"), which is aimed at the thing that can actually break.
--   • Which area each pre-0063 detector was CREATED under. Irrecoverable, and the only
--     irrecoverable thing here. It was never checked against where the detector's points actually
--     lived, which is why 0063 stopped anything reading it.
--
-- Unlike 0062 (`dashboards_legacy_id_unique`), both indexes here are BARE — verified against the
-- branch via pg_constraint.conindid — so drizzle's generated `DROP INDEX` is correct and needs no
-- hand-correction. `derivations_area_role_unique` is partial (`WHERE role IS NOT NULL`), and a
-- partial unique index cannot back a constraint in the first place.

-- ── Gate. Do not destroy the original until the replacement provably holds every row. ──────────
-- `source_points` is about to go, so `derivation_sources` must already carry the REQUIRED slot for
-- every derivation: 'power' for an hws-model, 'signal' for everything else. A derivation missing it
-- is one whose wiring exists only in the jsonb, and dropping the column would silently unwire it.
DO $$
DECLARE
  unwired int;
  detail  text;
BEGIN
  SELECT count(*), string_agg(d.id::text || ' (' || d.kind || ')', ', ')
    INTO unwired, detail
    FROM derivations d
   WHERE NOT EXISTS (
           SELECT 1 FROM derivation_sources ds
            WHERE ds.derivation_id = d.id
              AND ds.slot = CASE d.kind WHEN 'hws-model' THEN 'power' ELSE 'signal' END);
  IF unwired > 0 THEN
    RAISE EXCEPTION '0069: % derivation(s) have no required slot in derivation_sources — their wiring exists only in the source_points jsonb this migration drops: %', unwired, COALESCE(detail, 'NONE');
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "derivations" DROP CONSTRAINT "derivations_area_id_areas_id_fk";--> statement-breakpoint
DROP INDEX "derivations_area_role_unique";--> statement-breakpoint
DROP INDEX "derivations_area_idx";--> statement-breakpoint
ALTER TABLE "derivations" DROP COLUMN "area_id";--> statement-breakpoint
ALTER TABLE "derivations" DROP COLUMN "source_points";
