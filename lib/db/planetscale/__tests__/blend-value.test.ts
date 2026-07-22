import { describe, it, expect } from "@jest/globals";
import { blendValue } from "../battery-provenance-pg";
import type { FoldStep } from "@/lib/battery-provenance/fold";

/** A FoldStep with inert defaults; the fold vends the actual basis + the forgone delta. */
function step(partial: Partial<FoldStep>): FoldStep {
  return {
    batteryEmissionsIntensity: null,
    batteryRenewableFraction: null,
    batterySelfRenewableFraction: null,
    batteryPrice: null,
    batteryPriceForgone: null,
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
 * The WRITTEN `price-opportunity` point is the forgone-revenue component Qf/E — the fold accumulates
 * the delta natively, so blendValue is a passthrough. The device page / Contents card present the pair
 * as "Battery Energy Cost" (out-of-pocket) + "Battery Opportunity Cost" (the extra), summing to the
 * full economic cost.
 */
describe("blendValue price-opportunity (forgone-revenue passthrough)", () => {
  it("vends the forgone component directly", () => {
    const s = step({ batteryPrice: 12, batteryPriceForgone: 7 });
    expect(blendValue(s, "price")).toBe(12);
    expect(blendValue(s, "price-opportunity")).toBe(7);
  });

  it("vends 0 when nothing was forgone (no solar under a positive feed-in price)", () => {
    const s = step({ batteryPrice: 19.15, batteryPriceForgone: 0 });
    expect(blendValue(s, "price-opportunity")).toBe(0);
  });

  it("passes negative ACTUAL prices through while the forgone component stays ≥ 0", () => {
    // Grid-charged at a negative import price: actual basis negative, nothing forgone.
    const s = step({ batteryPrice: -5, batteryPriceForgone: 0 });
    expect(blendValue(s, "price")).toBe(-5);
    expect(blendValue(s, "price-opportunity")).toBe(0);
  });

  it("is null when the store is empty (batteryPriceForgone null)", () => {
    expect(blendValue(step({}), "price-opportunity")).toBeNull();
    // The fold nulls batteryPrice and batteryPriceForgone together (same E-guard); the point
    // tracks the forgone field alone.
    expect(
      blendValue(step({ batteryPrice: 10 }), "price-opportunity"),
    ).toBeNull();
  });
});
