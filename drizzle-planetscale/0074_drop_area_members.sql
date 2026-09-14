-- 0074 — drop `area_members` and `devices.primary_area_id`. The CONTRACT half, and IRREVERSIBLE.
--
-- 🛑 APPLY ONLY AFTER THE CODE IS DEPLOYED, where "deployed" includes the 2-hourly prod→dev sync
-- Action, which runs `main`. Its manifest listed `area_members` and repointed `primary_area_id`; a
-- drop ahead of that merge makes every sync run abort on a 42P01.
--
-- WHAT IS ACTUALLY BEING LOST, said plainly rather than gated ceremonially. `area_members` holds the
-- PRE-0071 membership and has had no reader and no writer since Stage 4; `primary_area_id` holds the
-- eagerly-minted area-of-one each device was born with and lost its last reader when `baseSelect`
-- moved onto `devices.area_id`. Both are superseded, not summarised — and neither is a backup of the
-- other, because they have DISAGREED by design for weeks: a device re-homed since the flip has a
-- stale `area_members` row and a `primary_area_id` naming a shell it left. So "does the frozen table
-- still match the live column" is NOT a useful gate; it is false on purpose, and gating on it would
-- only teach the next person to delete the gate.
--
-- The areas themselves are NOT deleted. The emptied areas-of-one stay, still addressable through
-- `legacy_handles.area_id`, which is what keeps any retained `point_readings_flow_attr_1d` /
-- `battery_provenance_daily` history readable. Measured at 0 rows on prod for every one of them, but
-- the NO ACTION firewall stays regardless.
--
-- In particular there is deliberately NO gate comparing `area_members` to `devices.area_id` on an
-- area that still holds flow or provenance history. That gate was written, run, and deleted: it
-- fires five times on dev, and all five are the settled decisions of this change — Kutis leaving
-- the Kutis and Kuti House areas for High Street Kew, OpenElectricity NEM Victoria going ambient
-- out of two site areas, Daylesford Selectronic leaving its own shell. Frozen history attributing
-- energy to a device that has since moved is the INTENDED outcome ("freeze, do not purge"), so a
-- gate on it is a gate that is false on purpose — which only teaches the next person to delete
-- gates.
--
-- So what remains below are the two invariants that survive scrutiny, both measured at 0 on dev and
-- both of which must stay 0. Note what is NOT there: "every owned device has an area". That is an
-- onboarding policy, not an invariant — see gate A.

--> statement-breakpoint
-- GATE A: no OWNERLESS device is in an area.
--
-- The ambient invariant, and the only half of "owned XOR ambient" that is actually an invariant. An
-- ownerless device is an OpenElectricity NEM region — Home Assistant's `entry_type=SERVICE`, an
-- ambient producer consumed by every area in its state and contained by none — and
-- `assertDevicesRehomable` refuses to place one. So a placed ownerless device is not merely odd, it
-- is TRAPPED: nothing, not even an admin, can take it out again.
--
-- 🛑 The converse is deliberately NOT gated, and an earlier cut of this file got that wrong. An
-- OWNED device with no area is a supported, first-class state, not a defect:
-- `PATCH /api/v4/devices/{id} { "areaId": null }` exists precisely to produce it and is documented
-- as "the ONLY way to say not assigned", and `PUT …/members` orphans a device by omission. Gating
-- on it would mean a user's deliberate unassignment blocks this migration until somebody undoes it.
-- "An owned device is placed" is an ONBOARDING policy (`resolveOnboardingArea`), not a property of
-- the data model.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM devices
   WHERE owner_user_id IS NULL AND area_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'GATE A: % ownerless device(s) are placed in an area. `assertDevicesRehomable` refuses to move an ownerless device, so each is trapped there permanently — free them before dropping.', n;
  END IF;
END $$;

--> statement-breakpoint
-- GATE B: no ACTIVE, ORDINARY device sits in a non-active area.
--
-- The other way a device becomes unreachable with nothing left to say where it came from. An active
-- device parked in an archived area is not served, not listed and not obviously broken — and after
-- `primary_area_id` goes there is no second opinion about where it belongs. Measured 0 on dev.
--
-- 🛑 `vendor='helper'` is EXCLUDED, and the exclusion is not a loophole — it is the same exception
-- the writer makes. A helper is an area's own derived output; `ensureHelperDevice` deliberately
-- opts out of `insertDeviceToPg`'s active-area precheck so that recomputing provenance for an
-- ARCHIVED area still works, which means an active helper inside an archived area is a state this
-- code produces ON PURPOSE. Gating on it would abort the migration over a row whose suggested
-- remedy — re-home it — is both refused by `assertDevicesRehomable` and semantically wrong: a
-- helper belongs to the area that mints it and nowhere else. Caught in review, after the writer's
-- exception had been written and this gate had not been told about it.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM devices d JOIN areas a ON a.id = d.area_id
   WHERE d.status = 'active' AND a.status <> 'active' AND d.vendor <> 'helper';
  IF n > 0 THEN
    RAISE EXCEPTION 'GATE B: % active device(s) sit in a non-active area. Re-home them first — after this migration nothing records where they came from.', n;
  END IF;
END $$;

--> statement-breakpoint
-- What is being discarded, on the record. Not a gate: both numbers are expected to be non-zero and
-- neither is recoverable or wanted. They are here so the apply log says how much frozen membership
-- this migration threw away, which is the only place that will ever be written down.
DO $$ DECLARE m int; p int; BEGIN
  SELECT count(*) INTO m FROM area_members;
  SELECT count(*) INTO p FROM devices WHERE primary_area_id IS NOT NULL;
  RAISE NOTICE 'dropping % frozen area_members row(s) and % primary_area_id value(s)', m, p;
END $$;

--> statement-breakpoint
-- No CASCADE. Nothing references `area_members`, and if that turns out to be wrong the right
-- outcome is a refusal naming the dependant, not a silent drop of whatever it was.
DROP TABLE "area_members";--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_primary_area_id_areas_id_fk";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "primary_area_id";
