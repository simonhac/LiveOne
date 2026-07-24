ALTER TABLE "area_bindings" ADD COLUMN "priority" integer;--> statement-breakpoint
WITH ranked AS (
  SELECT
    id,
    (row_number() OVER (
      PARTITION BY area_id, role, metric_type
      ORDER BY ordinal, id
    ) - 1)::integer AS priority
  FROM area_bindings
)
UPDATE area_bindings AS binding
SET priority = ranked.priority
FROM ranked
WHERE binding.id = ranked.id;--> statement-breakpoint
ALTER TABLE "area_bindings" ALTER COLUMN "priority" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "area_bindings" ALTER COLUMN "priority" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "area_bindings_slot_priority_unique" ON "area_bindings" USING btree ("area_id","role","metric_type","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_handles_device_unique" ON "legacy_handles" USING btree ("device_id") WHERE "legacy_handles"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_handles_area_unique" ON "legacy_handles" USING btree ("area_id") WHERE "legacy_handles"."area_id" IS NOT NULL;
