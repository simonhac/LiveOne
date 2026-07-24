-- 0032 config-v4 Phase 4: additive DARK columns + area_bindings.role CHECK.
-- Adds areas.day_offset_min (backfilled) / areas.config, dashboards.doc / dashboards.revision, and a
-- CHECK enumerating the 6-role registry on area_bindings.role (alongside the surviving roles FK).
-- Hand-finished to add the day_offset_min backfill + coverage guard (drizzle emits only ADD COLUMN);
-- meta/0032_snapshot.json is kept machine-written so future db:pg:generate diffs clean.
-- Applied in a single transaction (all statements are transactional DDL) — a guard abort rolls the whole
-- migration back. Every column is nullable or DEFAULT-carrying, so the UNCHANGED v3 app keeps inserting
-- into areas/dashboards; the columns are dark (unread by v3). The CHECK cannot fail on apply: every live
-- area_bindings.role already comes from the 6-role registry (lib/roles/registry.ts) via the existing FK.
-- Creates no new sequences/tables, so there is no PlanetScale role-ownership step (cf. 0030).

ALTER TABLE "areas" ADD COLUMN "day_offset_min" integer;--> statement-breakpoint
-- Backfill the fixed-offset day-bucketing key from the existing offset. Idempotent (WHERE … IS NULL).
-- The column stays NULLABLE on purpose: v3 createArea omits it, so any area the live app creates after
-- this migration carries NULL day_offset_min (dark, unread) until the cutover re-backfills + SET NOT NULL.
UPDATE "areas" SET "day_offset_min" = "timezone_offset_min" WHERE "day_offset_min" IS NULL;
--> statement-breakpoint
-- Coverage guard: prove the backfill reached every existing row before proceeding (0030 idiom).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM areas WHERE day_offset_min IS NULL) THEN
    RAISE EXCEPTION 'Refusing 0032: % area(s) still have NULL day_offset_min after backfill',
      (SELECT count(*) FROM areas WHERE day_offset_min IS NULL);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "doc" jsonb;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "area_bindings" ADD CONSTRAINT "area_bindings_role_check" CHECK ("area_bindings"."role" IN ('solar','battery','load','grid','ev','generator'));
