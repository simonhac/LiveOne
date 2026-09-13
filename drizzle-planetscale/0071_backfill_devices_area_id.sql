-- 0071 — backfill `devices.area_id`, the Home-Assistant-shaped device→area edge.
--
-- DATA ONLY: no DDL. `area_members` is untouched and still authoritative; nothing reads `area_id`
-- until the stage-3 resolver flip. Revert is `UPDATE devices SET area_id = NULL`.
--
-- THE RULES, in precedence order:
--   1. ownerless `openelectricity` → NULL. HA's `entry_type=DeviceEntryType.SERVICE`: an ambient
--      producer belongs to no area, and consumers reach it by REFERENCE (`lib/grid/context.ts`
--      resolves area.location → NEM region → the public device), never by membership. This is the
--      only rule that produces NULL.
--   2. everything else → its single ACTIVE site area (a membership that is not its own
--      `primary_area_id`), falling back to `primary_area_id` when it has none.
--
-- `status = 'active'` is load-bearing rather than defensive. Kutis [sigenergy] is a member of THREE
-- areas — High Street Kew, Kuti House and its own — and looked like it needed a human call. Kuti
-- House is `archived`, so the filter resolves it to High Street Kew on its own, which is also the
-- only correct answer: HSK binds the Amber meter and the Kutis area-of-one does not, so homing the
-- battery to Kutis would reproduce the $0.00-EV-run defect migration 0066 was written to kill.
--
-- Helpers need no rule of their own. `helperSiteId(areaId)` mints `helper:area:ar_…`, so a helper's
-- site area is recoverable from its own row — but that decode needs the TypeID codec and cannot live
-- in SQL. Verified out-of-band that the decode agrees with membership for all 5 helpers on prod, and
-- the post-gates below assert the invariant STRUCTURALLY (a helper must land in an area that has a
-- non-helper member, and no area may end up with two), which is environment-independent in a way a
-- hardcoded uuid table would not be.

--> statement-breakpoint
-- GATE A (pre): no device may be in two ACTIVE site areas. Measured 0 on prod and dev; if this fires,
-- some device genuinely needs a human decision and the rule below would pick arbitrarily.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM (
    SELECT am.device_id FROM area_members am
      JOIN devices d ON d.id = am.device_id
      JOIN areas   a ON a.id = am.area_id
     WHERE a.status = 'active'
       AND am.area_id <> d.primary_area_id
       AND d.vendor NOT IN ('openelectricity', 'helper')
     GROUP BY am.device_id HAVING count(*) > 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing 0071: % device(s) are in more than one active site area — resolve by hand first', n;
  END IF;
END $$;--> statement-breakpoint

-- rule 1
UPDATE devices SET area_id = NULL
 WHERE vendor = 'openelectricity' AND owner_user_id IS NULL;--> statement-breakpoint

-- rule 2
UPDATE devices d SET area_id = COALESCE(
  (SELECT am.area_id FROM area_members am
     JOIN areas a ON a.id = am.area_id
    WHERE am.device_id = d.id AND a.status = 'active' AND am.area_id <> d.primary_area_id
    LIMIT 1),
  d.primary_area_id)
 WHERE NOT (d.vendor = 'openelectricity' AND d.owner_user_id IS NULL);--> statement-breakpoint

DO $$ DECLARE n int; BEGIN
  -- GATE B: NULL is reserved for ambient producers. Any other area-less device is a device that
  -- would stop being polled, aggregated or visible the moment stage 3 reads this column.
  SELECT count(*) INTO n FROM devices
   WHERE area_id IS NULL AND NOT (vendor = 'openelectricity' AND owner_user_id IS NULL);
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing 0071: % non-service device(s) ended up with no area_id', n;
  END IF;

  -- GATE C: no invented edges. Every surviving edge must have existed as a membership. The converse
  -- is deliberately NOT asserted — collapsing the many-to-many is the entire point.
  SELECT count(*) INTO n FROM devices d
   WHERE d.area_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM area_members am
                      WHERE am.area_id = d.area_id AND am.device_id = d.id);
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing 0071: % device(s) point at an area they were never a member of', n;
  END IF;

  -- GATE D: a helper must land on the area whose COMPUTED points it owns — i.e. the area it was a
  -- MEMBER of, never its own area-of-one shell. That is the failure `ensureHelperDevice`'s
  -- missing-membership bug produces: with no membership row, rule 2 falls back to `primary_area_id`
  -- and the area's battery-provenance blend silently loses its writer.
  --
  -- 🛑 This deliberately does NOT require the area to still have a non-helper member. That was the
  -- first version of this gate and it was wrong: Kutis [sigenergy] correctly moves to High Street
  -- Kew, which leaves the Kutis area holding only its helper — the retirement this migration is
  -- supposed to perform, not a fault. The helper stays attached to the area whose (frozen) blend
  -- history it owns.
  SELECT count(*) INTO n FROM devices h
   WHERE h.vendor = 'helper'
     AND (h.area_id IS NULL OR h.area_id = h.primary_area_id);
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing 0071: % helper(s) fell back to their own area-of-one instead of their site area', n;
  END IF;

  -- GATE E: one helper per area, the invariant `devices_helper_area_unique` carries for site ids.
  SELECT count(*) INTO n FROM (
    SELECT area_id FROM devices WHERE vendor = 'helper' AND area_id IS NOT NULL
     GROUP BY area_id HAVING count(*) > 1) y;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing 0071: % area(s) would hold more than one helper device', n;
  END IF;
END $$;
