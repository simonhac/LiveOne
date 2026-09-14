/**
 * The placement resolution chain (`area → platform default`).
 *
 * These are cheap tests for a small pure function, and they are here for one reason: `resolvePlacement`
 * is what lets `device-config.ts`'s area join be LEFT instead of INNER. If it ever starts returning a
 * nullable `timezoneOffsetMin`, or stops falling back, an area-less device goes back to being
 * unrepresentable — silently, because the failure is a dropped row rather than a thrown error.
 */
import { describe, it, expect } from "@jest/globals";
import {
  PLATFORM_DEFAULT_PLACEMENT,
  resolvePlacement,
  type AreaPlacement,
} from "../placement";

const MELBOURNE: AreaPlacement = {
  timezoneOffsetMin: 600,
  displayTimezone: "Australia/Melbourne",
  location: { country: "AU", state: "VIC", postcode: "3460" },
};

describe("resolvePlacement", () => {
  it("takes every field from the area when the device has one", () => {
    expect(resolvePlacement(MELBOURNE)).toEqual({
      timezoneOffsetMin: 600,
      displayTimezone: "Australia/Melbourne",
      location: { country: "AU", state: "VIC", postcode: "3460" },
    });
  });

  it("passes a null area location through rather than substituting the default", () => {
    // An area that exists but has no location is NOT the same as no area: the device is placed, we
    // just do not know where. Falling back here would invent a location for the NEM-region derivation.
    const placed = resolvePlacement({ ...MELBOURNE, location: null });
    expect(placed.location).toBeNull();
    expect(placed.displayTimezone).toBe("Australia/Melbourne");
  });

  it("falls back to the platform default for an area-less device", () => {
    expect(resolvePlacement(null)).toEqual(PLATFORM_DEFAULT_PLACEMENT);
    expect(resolvePlacement(undefined)).toEqual(PLATFORM_DEFAULT_PLACEMENT);
  });

  it("never yields a nullable offset or timezone — that is the whole point of the seam", () => {
    for (const area of [MELBOURNE, null, undefined]) {
      const p = resolvePlacement(area);
      expect(typeof p.timezoneOffsetMin).toBe("number");
      expect(typeof p.displayTimezone).toBe("string");
    }
  });

  it("pins the platform default to a SELF-CONSISTENT +600 — Brisbane, not Melbourne", () => {
    // 🛑 The offset and the zone must name the same clock. Brisbane is the only Australian zone that
    // equals +600 year-round; Melbourne observes DST, so pairing it with a fixed +600 states a
    // contradiction for half the year. This constant is reached only by an AMBIENT device, which
    // today means the ownerless OpenElectricity NEM regions — seeded with exactly this pair because
    // NEM market time has no DST. It is NOT the onboarding default: `insertDeviceToPg` carries its
    // own `?? 600` / `?? Melbourne` literals for the area it mints, and a new household connection
    // in Victoria really is Melbourne.
    expect(PLATFORM_DEFAULT_PLACEMENT).toEqual({
      timezoneOffsetMin: 600,
      displayTimezone: "Australia/Brisbane",
      location: null,
    });
  });
});
