import { describe, it, expect } from "@jest/globals";
import {
  helperSiteId,
  parentAreaIdFromHelperSiteId,
} from "@/lib/areas/helper-site-id";

const AREA_ID = "019f513a-52ab-7cde-8f01-23456789abcd";

describe("helper-site-id", () => {
  it("mints the canonical helper vendorSiteId", () => {
    expect(helperSiteId(AREA_ID)).toBe(`helper:area:${AREA_ID}`);
  });

  it("roundtrips mint → parse", () => {
    expect(parentAreaIdFromHelperSiteId(helperSiteId(AREA_ID))).toBe(AREA_ID);
  });

  it("accepts upper-case hex in the uuid", () => {
    const upper = AREA_ID.toUpperCase();
    expect(parentAreaIdFromHelperSiteId(`helper:area:${upper}`)).toBe(upper);
  });

  it("rejects garbage", () => {
    expect(parentAreaIdFromHelperSiteId("")).toBeNull();
    expect(parentAreaIdFromHelperSiteId("helper:area:")).toBeNull();
    expect(parentAreaIdFromHelperSiteId("helper:area:not-a-uuid")).toBeNull();
    // Right length, non-hex chars.
    expect(
      parentAreaIdFromHelperSiteId(`helper:area:${"z".repeat(36)}`),
    ).toBeNull();
    // Wrong prefix / scheme.
    expect(parentAreaIdFromHelperSiteId(`device:area:${AREA_ID}`)).toBeNull();
    expect(parentAreaIdFromHelperSiteId(`helper:${AREA_ID}`)).toBeNull();
    expect(parentAreaIdFromHelperSiteId(AREA_ID)).toBeNull();
    // Leading/trailing junk around an otherwise-valid id.
    expect(parentAreaIdFromHelperSiteId(`helper:area:${AREA_ID}x`)).toBeNull();
    expect(parentAreaIdFromHelperSiteId(` helper:area:${AREA_ID}`)).toBeNull();
  });
});
