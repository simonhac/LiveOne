-- 0070 — device placement, and the Home-Assistant-shaped device→area edge.
--
-- ADDITIVE ONLY. Nothing reads `devices.area_id`, `devices.day_offset_min` or the three `users`
-- columns until the resolver flip (stage 3) and the bucketing flip (stage 3b); this migration is
-- revertible by dropping them. 0071 backfills `area_id`; 0072 drops `area_members` and
-- `devices.primary_area_id`.
--
-- Why `day_offset_min` lands on the DEVICE: `point_readings_agg_1d` is PK'd on `(point_rid, day)`
-- with no area column, and `recomputeAgg1dForDay` buckets per device. A bucketing key whose grain is
-- coarser than the table it buckets cannot answer for a device with no area — which is precisely what
-- made an area-less device unrepresentable. `areas.day_offset_min` keeps its own, different job: the
-- bucket for the AREA-keyed tables (`point_readings_flow_attr_1d.day`, `battery_provenance_daily.day`).

--> statement-breakpoint
-- 1a. The device's own day bucket. Added NULLABLE, backfilled, gated, then SET NOT NULL — the plain
-- `ADD COLUMN ... NOT NULL` drizzle generates cannot work on a populated table.
ALTER TABLE "devices" ADD COLUMN "day_offset_min" integer;--> statement-breakpoint

-- Seed from `areas.timezone_offset_min` — the value 1d aggregation ACTUALLY used (via
-- DeviceConfigRegistry.toRecord → recomputeAgg1dForDay), NOT `areas.day_offset_min`. They agree
-- today, and the second gate below is what proves it rather than assuming it.
UPDATE "devices" d SET "day_offset_min" = a."timezone_offset_min"
  FROM "areas" a WHERE a."id" = d."primary_area_id";--> statement-breakpoint

DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM "devices" WHERE "day_offset_min" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing 0070: % device(s) still have a NULL day_offset_min after the backfill — a dangling primary_area_id?', n;
  END IF;

  -- The invariant the stage-3b bucketing flip depends on. `areas.day_offset_min` is documented as the
  -- canonical day key but NOTHING in the aggregation path reads it; the aggregation reads
  -- `timezone_offset_min`. They are written together and so agree by construction. If this ever fires,
  -- some device's agg_1d history is bucketed on a key nothing names, and flipping the reader to
  -- `devices.day_offset_min` would silently re-bucket it. STOP and resolve by hand.
  SELECT count(*) INTO n FROM "devices" d JOIN "areas" a ON a."id" = d."primary_area_id"
   WHERE a."timezone_offset_min" IS DISTINCT FROM a."day_offset_min";
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing 0070: % device(s) sit in an area whose timezone_offset_min and day_offset_min disagree — the agg_1d bucketing key is ambiguous for them', n;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "devices" ALTER COLUMN "day_offset_min" SET NOT NULL;--> statement-breakpoint

-- 1b. Owner-level placement defaults — the middle tier of `area → owner → platform default`.
-- Deliberately all-NULL: NULL means "fall through to the platform default".
ALTER TABLE "users" ADD COLUMN "day_offset_min" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "location" jsonb;--> statement-breakpoint

-- 1c. The new edge: 0 or 1 area per device, nullable and unbackfilled until 0071.
-- ON DELETE SET NULL — deleting an area moves its devices to the unassigned bucket. This does NOT
-- touch `point_readings_flow_attr_1d.area_id`'s NO ACTION data-loss firewall.
ALTER TABLE "devices" ADD COLUMN "area_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_area_idx" ON "devices" USING btree ("area_id");
