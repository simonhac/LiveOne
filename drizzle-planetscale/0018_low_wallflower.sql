CREATE TABLE "area_devices" (
	"area_id" uuid NOT NULL,
	"system_id" integer NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "area_devices_area_id_system_id_pk" PRIMARY KEY("area_id","system_id")
);
--> statement-breakpoint
ALTER TABLE "area_devices" ADD CONSTRAINT "area_devices_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Backfill (composite retirement, Phase B): explicit area→member-device membership, idempotent.
-- Composite Areas → one member per DISTINCT area_bindings.point_system_id (its child systems).
INSERT INTO "area_devices" ("area_id", "system_id", "ordinal")
SELECT DISTINCT ab."area_id", ab."point_system_id", 0
FROM "area_bindings" ab
JOIN "areas" a ON a."id" = ab."area_id"
WHERE a."kind" = 'composite'
ON CONFLICT ("area_id", "system_id") DO NOTHING;
--> statement-breakpoint
-- Identity Areas → a single member: their source system.
INSERT INTO "area_devices" ("area_id", "system_id", "ordinal")
SELECT a."id", a."source_system_id", 0
FROM "areas" a
WHERE a."kind" = 'identity' AND a."source_system_id" IS NOT NULL
ON CONFLICT ("area_id", "system_id") DO NOTHING;
--> statement-breakpoint
-- Guard (the migration-0016 lesson — validate before trusting): every composite Area that HAS
-- bindings must have gained >= 1 member row. A binding-less composite is legitimately empty and is
-- not flagged; a composite with bindings but no members means the backfill silently failed → abort.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "areas" a
    WHERE a."kind" = 'composite'
      AND EXISTS (SELECT 1 FROM "area_bindings" ab WHERE ab."area_id" = a."id")
      AND NOT EXISTS (SELECT 1 FROM "area_devices" d WHERE d."area_id" = a."id")
  ) THEN
    RAISE EXCEPTION 'area_devices backfill failed: a composite area with bindings has no member rows';
  END IF;
END $$;
--> statement-breakpoint
-- Guard: every identity Area with a source system must carry that source as a member.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "areas" a
    WHERE a."kind" = 'identity' AND a."source_system_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "area_devices" d
        WHERE d."area_id" = a."id" AND d."system_id" = a."source_system_id"
      )
  ) THEN
    RAISE EXCEPTION 'area_devices backfill failed: an identity area is missing its source-system member';
  END IF;
END $$;
