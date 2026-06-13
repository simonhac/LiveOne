/**
 * Derive the NEM dispatch region for an Area's physical location.
 *
 * The region is a DERIVED fact (never stored on the Area): a dashboard's "Local Grid (NEM)"
 * card maps the Area's `state` (preferred) — falling back to `postcode` — onto one of the five
 * eastern-states NEM regions. WA/NT are not part of the NEM, so they (and any non-Australian or
 * unrecognised location) resolve to `null` → no grid card.
 */

import type { AreaLocation } from "@/lib/areas/types";
import type { NemRegion } from "@/lib/vendors/openelectricity/types";

/** State/territory code → NEM region. NEM-only; WA/NT are intentionally absent (→ null). */
const STATE_TO_REGION: Record<string, NemRegion> = {
  NSW: "NSW1",
  ACT: "NSW1", // the ACT dispatches within NSW1
  QLD: "QLD1",
  VIC: "VIC1",
  SA: "SA1",
  TAS: "TAS1",
};

/**
 * Map an Australian postcode to its NEM region (fallback when `state` is absent/unrecognised).
 * Returns `null` for non-NEM postcodes (WA 6xxx, NT 08xx/09xx) and anything out of range.
 */
function regionForPostcode(postcode: string): NemRegion | null {
  const digits = postcode.trim();
  if (!/^\d{3,4}$/.test(digits)) return null;
  const n = Number(digits);
  if (Number.isNaN(n)) return null;

  // NSW (2xxx) and ACT (2600-2618, 2900-2920) → NSW1
  if (
    (n >= 1000 && n <= 2599) ||
    (n >= 2600 && n <= 2618) || // ACT
    (n >= 2619 && n <= 2899) ||
    (n >= 2900 && n <= 2920) || // ACT
    (n >= 2921 && n <= 2999)
  ) {
    return "NSW1";
  }
  // VIC (3xxx + LVOs 8xxx) → VIC1
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return "VIC1";
  // QLD (4xxx + LVOs 9xxx) → QLD1
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return "QLD1";
  // SA (5xxx) → SA1
  if (n >= 5000 && n <= 5999) return "SA1";
  // WA (6xxx) — not in the NEM
  if (n >= 6000 && n <= 6999) return null;
  // TAS (7xxx) → TAS1
  if (n >= 7000 && n <= 7999) return "TAS1";
  // NT (08xx/09xx) — not in the NEM
  return null;
}

/**
 * Resolve the NEM region for a location, preferring `state` over `postcode`.
 * Returns `null` when off-NEM (WA/NT), non-Australian, or no usable signal is present.
 */
export function nemRegionForLocation(
  loc: AreaLocation | null | undefined,
): NemRegion | null {
  if (!loc) return null;

  // The NEM is Australian-only. A present, non-AU country never maps to a region (a US/NZ "NSW" or a
  // colliding overseas postcode must not be misclassified). Absent country is treated leniently.
  if (loc.country && loc.country.trim().toUpperCase() !== "AU") return null;

  const state = loc.state?.trim().toUpperCase();
  if (state) {
    // A recognised state is authoritative; WA/NT (absent from the map) → null.
    if (state in STATE_TO_REGION) return STATE_TO_REGION[state];
    // Unrecognised state falls through to the postcode fallback below.
  }

  if (loc.postcode) return regionForPostcode(loc.postcode);

  return null;
}

/** Short display label for a region — strips the trailing dispatch "1" ("NSW1" → "NSW"). */
export function nemRegionShortLabel(region: NemRegion): string {
  return region.replace(/1$/, "");
}
