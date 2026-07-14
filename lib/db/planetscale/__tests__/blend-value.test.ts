import { describe, it, expect } from "@jest/globals";
import { blendValue } from "../battery-provenance-pg";
import type { FoldStep } from "@/lib/battery-provenance/fold";

/** A FoldStep with inert defaults; the fold vends FULL cost bases (actual + opportunity). */
function step(partial: Partial<FoldStep>): FoldStep {
  return {
    batteryEmissionsIntensity: null,
    batteryRenewableFraction: null,
    batteryPrice: null,
    batteryPriceOpportunity: null,
    storedKwh: 0,
    dischargedKwh: 0,
    resetHere: false,
    resetTrigger: null,
    estimatedFraction: 0,
    segmentIntervals: 0,
    syncKwh: 0,
    recalHere: false,
    ...partial,
  };
}

/**
 * The WRITTEN `price-opportunity` point is the ADDITIONAL opportunity component (forgone feed-in only),
 * not the fold's full opportunity basis — the device page / Contents card present the pair as
 * "Battery Energy Cost" (out-of-pocket) + "Battery Opportunity Cost" (the extra), summing to the
 * full economic cost.
 */
describe("blendValue price-opportunity (delta vs actual)", () => {
  it("vends full-opportunity minus actual", () => {
    const s = step({ batteryPrice: 12, batteryPriceOpportunity: 19 });
    expect(blendValue(s, "price")).toBe(12);
    expect(blendValue(s, "price-opportunity")).toBeCloseTo(7, 9);
  });

  it("vends 0 when the bases coincide (no solar under a positive feed-in price)", () => {
    const s = step({ batteryPrice: 19.15, batteryPriceOpportunity: 19.15 });
    expect(blendValue(s, "price-opportunity")).toBeCloseTo(0, 9);
  });

  it("passes negative ACTUAL prices through while the delta stays ≥ 0", () => {
    // Grid-charged at a negative import price: actual basis negative, opportunity basis equal.
    const s = step({ batteryPrice: -5, batteryPriceOpportunity: -5 });
    expect(blendValue(s, "price")).toBe(-5);
    expect(blendValue(s, "price-opportunity")).toBeCloseTo(0, 9);
  });

  it("is null when either basis is null (empty store)", () => {
    expect(blendValue(step({}), "price-opportunity")).toBeNull();
    expect(
      blendValue(step({ batteryPrice: 10 }), "price-opportunity"),
    ).toBeNull();
    expect(
      blendValue(step({ batteryPriceOpportunity: 10 }), "price-opportunity"),
    ).toBeNull();
  });
});
