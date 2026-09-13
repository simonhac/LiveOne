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
 * The floor of the resolution chain: what a device with no area (and, from migration 0070, no owner
 * default) is placed at.
 *
 * 🛑 These two values are NOT self-consistent, and that is deliberate — they reproduce
 * `insertDeviceToPg`'s existing `?? 600` / `?? "Australia/Melbourne"` defaults byte-for-byte.
 * `Australia/Melbourne` observes DST so it is +660 for part of the year, while the offset is a fixed
 * +600; `lib/date-utils.ts:126` maps offset 600 to `Australia/Brisbane` precisely because Brisbane is
 * the zone that actually equals it year-round. Changing the default to Brisbane would be a defensible
 * fix but it would silently move the display timezone of every device onboarded through
 * `POST /api/devices` and the Enphase OAuth callback, neither of which passes one — a data change
 * dressed as a cleanup. Left alone; fix it deliberately or not at all.
 */
export const PLATFORM_DEFAULT_PLACEMENT: ResolvedPlacement = {
  timezoneOffsetMin: 600, // AEST
  displayTimezone: "Australia/Melbourne",
  location: null,
};

/**
 * Resolve a device's placement from its area, falling back to the platform default.
 *
 * Pass `null` for a device with no area. The owner tier of the chain lands with migration 0070's
 * `users.{day_offset_min,display_timezone,location}` columns; until then the chain is two-tier and
 * the fallback branch is unreachable, because `devices.primary_area_id` is still NOT NULL.
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
