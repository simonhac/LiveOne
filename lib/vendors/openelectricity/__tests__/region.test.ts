import { describe, it, expect } from "@jest/globals";
import { nemRegionForLocation, nemRegionShortLabel } from "../region";
import type { AreaLocation } from "@/lib/areas/types";

const loc = (partial: Partial<AreaLocation>): AreaLocation => ({
  country: "AU",
  ...partial,
});

describe("nemRegionForLocation", () => {
  describe("state mapping", () => {
    it("maps NEM states to their region", () => {
      expect(nemRegionForLocation(loc({ state: "NSW" }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ state: "QLD" }))).toBe("QLD1");
      expect(nemRegionForLocation(loc({ state: "VIC" }))).toBe("VIC1");
      expect(nemRegionForLocation(loc({ state: "SA" }))).toBe("SA1");
      expect(nemRegionForLocation(loc({ state: "TAS" }))).toBe("TAS1");
    });

    it("maps ACT to NSW1", () => {
      expect(nemRegionForLocation(loc({ state: "ACT" }))).toBe("NSW1");
    });

    it("returns null for non-NEM states (WA/NT)", () => {
      expect(nemRegionForLocation(loc({ state: "WA" }))).toBeNull();
      expect(nemRegionForLocation(loc({ state: "NT" }))).toBeNull();
    });

    it("is case-insensitive and trims whitespace", () => {
      expect(nemRegionForLocation(loc({ state: "nsw" }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ state: " Vic " }))).toBe("VIC1");
      expect(nemRegionForLocation(loc({ state: "act" }))).toBe("NSW1");
    });
  });

  describe("country guard", () => {
    it("returns null for a present non-AU country even with a NEM-looking state/postcode", () => {
      expect(nemRegionForLocation({ country: "US", state: "NSW" })).toBeNull();
      expect(
        nemRegionForLocation({ country: "NZ", postcode: "9000" }),
      ).toBeNull();
    });

    it("accepts AU case-insensitively", () => {
      expect(nemRegionForLocation({ country: "au", state: "VIC" })).toBe(
        "VIC1",
      );
    });
  });

  describe("postcode fallback", () => {
    it("maps NSW postcodes (2xxx) to NSW1", () => {
      expect(nemRegionForLocation(loc({ postcode: "2000" }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ postcode: "2599" }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ postcode: "2750" }))).toBe("NSW1");
    });

    it("maps ACT postcodes (2600-2618, 2900-2920) to NSW1", () => {
      expect(nemRegionForLocation(loc({ postcode: "2600" }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ postcode: "2618" }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ postcode: "2900" }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ postcode: "2920" }))).toBe("NSW1");
    });

    it("maps VIC postcodes (3xxx, 8xxx) to VIC1", () => {
      expect(nemRegionForLocation(loc({ postcode: "3000" }))).toBe("VIC1");
      expect(nemRegionForLocation(loc({ postcode: "3999" }))).toBe("VIC1");
      expect(nemRegionForLocation(loc({ postcode: "8000" }))).toBe("VIC1");
    });

    it("maps QLD postcodes (4xxx, 9xxx) to QLD1", () => {
      expect(nemRegionForLocation(loc({ postcode: "4000" }))).toBe("QLD1");
      expect(nemRegionForLocation(loc({ postcode: "4999" }))).toBe("QLD1");
      expect(nemRegionForLocation(loc({ postcode: "9000" }))).toBe("QLD1");
    });

    it("maps SA postcodes (5xxx) to SA1", () => {
      expect(nemRegionForLocation(loc({ postcode: "5000" }))).toBe("SA1");
      expect(nemRegionForLocation(loc({ postcode: "5999" }))).toBe("SA1");
    });

    it("maps TAS postcodes (7xxx) to TAS1", () => {
      expect(nemRegionForLocation(loc({ postcode: "7000" }))).toBe("TAS1");
      expect(nemRegionForLocation(loc({ postcode: "7999" }))).toBe("TAS1");
    });

    it("returns null for WA postcodes (6xxx)", () => {
      expect(nemRegionForLocation(loc({ postcode: "6000" }))).toBeNull();
      expect(nemRegionForLocation(loc({ postcode: "6999" }))).toBeNull();
    });

    it("returns null for NT postcodes (08xx/09xx)", () => {
      expect(nemRegionForLocation(loc({ postcode: "0800" }))).toBeNull();
      expect(nemRegionForLocation(loc({ postcode: "0909" }))).toBeNull();
    });

    it("trims whitespace and tolerates malformed postcodes", () => {
      expect(nemRegionForLocation(loc({ postcode: " 2000 " }))).toBe("NSW1");
      expect(nemRegionForLocation(loc({ postcode: "abcd" }))).toBeNull();
      expect(nemRegionForLocation(loc({ postcode: "" }))).toBeNull();
    });
  });

  describe("state takes precedence over postcode", () => {
    it("uses state when both are present", () => {
      // VIC state with a NSW postcode → state wins.
      expect(
        nemRegionForLocation(loc({ state: "VIC", postcode: "2000" })),
      ).toBe("VIC1");
    });

    it("falls back to postcode when the state is unrecognised", () => {
      expect(
        nemRegionForLocation(loc({ state: "ZZZ", postcode: "3000" })),
      ).toBe("VIC1");
    });

    it("falls back to postcode when the state is empty", () => {
      expect(nemRegionForLocation(loc({ state: "", postcode: "4000" }))).toBe(
        "QLD1",
      );
    });
  });

  describe("missing / empty input", () => {
    it("returns null for null/undefined", () => {
      expect(nemRegionForLocation(null)).toBeNull();
      expect(nemRegionForLocation(undefined)).toBeNull();
    });

    it("returns null when neither state nor postcode is usable", () => {
      expect(nemRegionForLocation(loc({}))).toBeNull();
      expect(nemRegionForLocation(loc({ state: "WA" }))).toBeNull();
    });
  });
});

describe("nemRegionShortLabel", () => {
  it("strips the trailing 1 for every region", () => {
    expect(nemRegionShortLabel("NSW1")).toBe("NSW");
    expect(nemRegionShortLabel("QLD1")).toBe("QLD");
    expect(nemRegionShortLabel("VIC1")).toBe("VIC");
    expect(nemRegionShortLabel("SA1")).toBe("SA");
    expect(nemRegionShortLabel("TAS1")).toBe("TAS");
  });
});
