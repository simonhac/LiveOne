/**
 * PLACEMENT — where a device is, and which fixed-offset day its readings bucket into.
 *
 * ## Why this exists
 *
 * `areas` has been the SOLE home for `timezone_offset_min` / `display_timezone` / `location`, which
 * worked only because `devices.primary_area_id` was NOT NULL and every device got an eagerly-minted
 * area-of-one. Moving to Home Assistant's shape — a device has 0 or 1 area — makes an area-less
 * device representable, and an area-less device would otherwise have no timezone and no day bucket.
 *
 * HA's answer is a single global home-location object on the core config, with the Area as the finer
 * grain. The direct translation fails here for one reason: HA is single-home, we are
 * many-sites-per-owner. So HA's "core config" maps to the OWNER, not the platform, and the resolution
 * chain is `area → owner → platform default`. This module owns that chain; nothing else should
 * re-implement it.
 *
 * ## What is NOT here
 *
 * **The day bucket.** `point_readings_agg_1d` is PK'd on `(point_rid, day)` — no area column — and
 * `recomputeAgg1dForDay` buckets on the DEVICE. A bucketing key whose grain is coarser than the table
 * it buckets cannot answer for an area-less row, so the device's own `day_offset_min` column is the
 * canonical key for point aggregates (added in migration 0070) and is read straight off the device
 * rather than resolved here. `areas.day_offset_min` keeps its own meaning — the bucket for the
 * AREA-keyed tables (`point_readings_flow_attr_1d.day`, `battery_provenance_daily.day`).
 */
import type { AreaLocation } from "./types";

/**
 * The placement fields an area contributes. Structurally `Pick<Area, …>` rather than the row type, so
 * callers can pass a projection without dragging in every `areas` column (the projection-less
 * `.select()` trap the `areas` schema comment warns about).
 */
export interface AreaPlacement {
  readonly timezoneOffsetMin: number;
  readonly displayTimezone: string;
  readonly location: AreaLocation | null;
}

/** What every consumer of a device's placement gets, with no nulls left to handle. */
export interface ResolvedPlacement {
  readonly timezoneOffsetMin: number;
  readonly displayTimezone: string;
  readonly location: AreaLocation | null;
}

/**
 * The floor of the resolution chain: what an AMBIENT device — one in no area, with no owner default
 * (migration 0070) — is placed at.
 *
 * 🛑 **`Australia/Brisbane`, not Melbourne, and the two halves must stay self-consistent.** Brisbane
 * is the only Australian zone that actually equals the +600 beside it, year-round;
 * `lib/date-utils.ts:126` already maps offset 600 → Brisbane for exactly that reason. Melbourne
 * observes DST, so pairing it with a fixed +600 states a contradiction for half the year.
 *
 * An earlier pass left this as Melbourne on the reasoning that changing it "would silently move the
 * display timezone of every device onboarded through `POST /api/devices` and the Enphase OAuth
 * callback, neither of which passes one". **That was measured and is wrong.** Those two paths never
 * reach this constant: `insertDeviceToPg` carries its OWN `?? 600` / `?? "Australia/Melbourne"`
 * literals for the area it mints (`device-writer.ts`), which are the ONBOARDING default and a
 * separate decision — a new household connection in Victoria really is Melbourne. This constant has
 * exactly one production reader, `toRecord`'s `resolvePlacement(row.areas)`, and it is only reached
 * when the joined area is NULL.
 *
 * So who is actually placed here: the ownerless OpenElectricity NEM regions, and nothing else. They
 * are ambient by design (Home Assistant's `entry_type=SERVICE`) and were deliberately SEEDED with
 * `Australia/Brisbane` — `scripts/openelectricity/seed-devices.ts` says "AEST (UTC+10), no DST",
 * because NEM market time has no DST. This makes the floor agree with the only thing standing on it.
 *
 * **This is also the answer to "do the OE devices need to be in areas?" — no.** Everything an area
 * was giving them is now either on the device (`day_offset_min`) or correct here.
 */
export const PLATFORM_DEFAULT_PLACEMENT: ResolvedPlacement = {
  timezoneOffsetMin: 600, // AEST (UTC+10), no DST — the NEM market clock
  displayTimezone: "Australia/Brisbane", // the only zone that equals +600 all year
  location: null,
};

/**
 * Resolve a device's placement from its area, falling back to the platform default.
 *
 * Pass `null` for an AMBIENT device — one in no area. That branch is live now that `device-config.ts`
 * joins `devices.area_id`: the two ownerless OpenElectricity NEM regions take it. The owner tier
 * (migration 0070's `users.{day_offset_min,display_timezone,location}`) is still unwired, so the
 * chain is two-tier in practice.
 */
export function resolvePlacement(
  area: AreaPlacement | null | undefined,
): ResolvedPlacement {
  if (!area) return PLATFORM_DEFAULT_PLACEMENT;
  return {
    timezoneOffsetMin: area.timezoneOffsetMin,
    displayTimezone: area.displayTimezone,
    location: area.location,
  };
}
