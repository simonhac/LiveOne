import { describe, it, expect } from "@jest/globals";
import {
  mergeAreaLocation,
  areaLocationPatchError,
} from "@/lib/areas/location";

describe("mergeAreaLocation", () => {
  it("defaults country to AU when none is present", () => {
    expect(mergeAreaLocation(null, {})).toEqual({ country: "AU" });
    expect(mergeAreaLocation(null, { state: "nsw" })).toEqual({
      country: "AU",
      state: "NSW",
    });
  });

  it("upper-cases country and state, leaves postcode as-is", () => {
    expect(
      mergeAreaLocation(null, {
        country: "au",
        state: "vic",
        postcode: "3000",
      }),
    ).toEqual({ country: "AU", state: "VIC", postcode: "3000" });
  });

  it("preserves fields the patch does not mention (incl. lat/lng)", () => {
    const existing = { country: "AU", state: "NSW", lat: -33.8, lng: 151.2 };
    expect(mergeAreaLocation(existing, { state: "QLD" })).toEqual({
      country: "AU",
      state: "QLD",
      lat: -33.8,
      lng: 151.2,
    });
  });

  it("clears a field when the patch value is empty string or null", () => {
    const existing = { country: "AU", state: "NSW", postcode: "2000" };
    expect(mergeAreaLocation(existing, { postcode: "" })).toEqual({
      country: "AU",
      state: "NSW",
    });
    expect(mergeAreaLocation(existing, { state: null })).toEqual({
      country: "AU",
      postcode: "2000",
    });
  });

  it("trims whitespace and accepts numeric lat/lng, clearing on null", () => {
    expect(mergeAreaLocation(null, { state: "  sa  ", lat: -34.9 })).toEqual({
      country: "AU",
      state: "SA",
      lat: -34.9,
    });
    expect(
      mergeAreaLocation(
        { country: "AU", lat: -34.9, lng: 138.6 },
        { lat: null },
      ),
    ).toEqual({ country: "AU", lng: 138.6 });
  });
});

describe("areaLocationPatchError", () => {
  it.each(["VIC", "WA", "NT", "ACT", "", null])("accepts state %s", (state) => {
    expect(
      areaLocationPatchError({ state, postcode: "0800" }, null),
    ).toBeNull();
  });

  it("preserves international location semantics", () => {
    expect(
      areaLocationPatchError(
        { state: "London", postcode: "SW1A 1AA" },
        { country: "GB" },
      ),
    ).toBeNull();
  });

  it.each([
    { country: 7 },
    { country: "Australia" },
    { state: 7 },
    { lat: "-37" },
    { lat: Infinity },
    { lng: -181 },
  ])("rejects malformed location %j", (patch) => {
    expect(areaLocationPatchError(patch, null)).not.toBeNull();
  });

  it("accepts coordinate bounds and field clearing", () => {
    expect(
      areaLocationPatchError({ lat: -90, lng: 180, postcode: null }, null),
    ).toBeNull();
  });
});
