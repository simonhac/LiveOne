import { describe, it, expect } from "@jest/globals";
import {
  helperSiteId,
  parentAreaIdFromHelperSiteId,
} from "@/lib/areas/helper-site-id";
import { areaRefToArId } from "@/lib/areas/ref";
import { Area } from "@/lib/ids";

const AREA_ID = "019f513a-52ab-7cde-8f01-23456789abcd";
const AR_ID = Area.encode(AREA_ID);

describe("helper-site-id", () => {
  it("mints the canonical helper vendorSiteId in `ar_` form", () => {
    expect(helperSiteId(AREA_ID)).toBe(`helper:area:${AR_ID}`);
    // No raw uuid anywhere in the minted string — the whole point of stage 17, since this value is
    // emitted verbatim to anonymous share-token viewers by `/api/data`.
    expect(helperSiteId(AREA_ID)).not.toContain(AREA_ID);
  });

  it("mints the same thing from an `ar_` id (idempotent under re-mint)", () => {
    expect(helperSiteId(AR_ID)).toBe(helperSiteId(AREA_ID));
  });

  it("roundtrips mint → parse", () => {
    expect(parentAreaIdFromHelperSiteId(helperSiteId(AREA_ID))).toBe(AR_ID);
  });

  // 🛑 The dual-accept leg. Migration 0053 rewrites the stored rows, but this code deploys FIRST and
  // must read the pre-0053 raw-uuid form for the whole window — and for any environment 0053 has not
  // reached yet. Deleting this leg before both environments are migrated re-breaks the card.
  it("still parses the pre-0053 raw-uuid form, to the SAME area id", () => {
    expect(parentAreaIdFromHelperSiteId(`helper:area:${AREA_ID}`)).toBe(AR_ID);
    expect(parentAreaIdFromHelperSiteId(`helper:area:${AREA_ID}`)).toBe(
      parentAreaIdFromHelperSiteId(`helper:area:${AR_ID}`),
    );
  });

  it("accepts upper-case hex in the legacy uuid, normalizing to the same `ar_`", () => {
    expect(
      parentAreaIdFromHelperSiteId(`helper:area:${AREA_ID.toUpperCase()}`),
    ).toBe(AR_ID);
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
    expect(parentAreaIdFromHelperSiteId(AR_ID)).toBeNull();
    // Another entity's TypeID is NOT an area ref.
    expect(
      parentAreaIdFromHelperSiteId(`helper:area:dv_${AR_ID.slice(3)}`),
    ).toBeNull();
    // Leading/trailing junk around an otherwise-valid id.
    expect(parentAreaIdFromHelperSiteId(`helper:area:${AREA_ID}x`)).toBeNull();
    expect(parentAreaIdFromHelperSiteId(`helper:area:${AR_ID}x`)).toBeNull();
    expect(parentAreaIdFromHelperSiteId(` helper:area:${AREA_ID}`)).toBeNull();
    expect(parentAreaIdFromHelperSiteId(` helper:area:${AR_ID}`)).toBeNull();
  });

  it("throws when asked to mint from something that is not an area id", () => {
    expect(() => helperSiteId("not-a-uuid")).toThrow(TypeError);
    expect(() => helperSiteId("")).toThrow(TypeError);
  });

  // The `battery-provenance-history` card is the ONLY consumer, and it composes these two helpers on
  // the `DeviceBlock.vendorSiteId` it gets from `/api/data`. Pinned HERE rather than in the card's own
  // file, which three open Phase 14 PRs also edit — the contract is what matters, not the call site.
  it("resolves the card's chain to one area id from BOTH stored forms", () => {
    const resolve = (vendorSiteId: string) => {
      const ref = parentAreaIdFromHelperSiteId(vendorSiteId);
      return ref ? areaRefToArId(ref) : null;
    };
    expect(resolve(`helper:area:${AREA_ID}`)).toBe(AR_ID); // pre-0053 row
    expect(resolve(`helper:area:${AR_ID}`)).toBe(AR_ID); // post-0053 row
    expect(resolve("selectronic-site-123")).toBeNull(); // a real device's site id
    expect(resolve("")).toBeNull();
  });
});
