import { describe, it, expect } from "@jest/globals";
import { exportReceiptSeries } from "../tariff";

/**
 * What is left of tariff resolution: ONE series, read two ways.
 *
 * This file used to test `resolveExportPriceSeries`' three modes and a `ScheduleTariffProvider` with
 * effective-dated plans. Both are gone — an area's feed-in tariff is its bound `bidi.grid.export/rate`
 * point, so there are no modes to resolve and no schedule to synthesise. The one thing that survived
 * is the sign convention, because it is the only place the same numbers mean opposite things.
 */
describe("exportReceiptSeries", () => {
  it("negates the measured series, so being PAID reads as positive revenue", () => {
    // Amber's raw feedIn `perKwh` is negative when money comes in. The fold reads it raw; `revenueC`
    // reads it negated. Getting this backwards books every export as a charge.
    expect(exportReceiptSeries([-7.5, 2])).toEqual([7.5, -2]);
  });

  it("preserves null as null — no tariff is not a zero tariff", () => {
    expect(exportReceiptSeries([null, -3, null])).toEqual([null, 3, null]);
  });

  it("leaves an all-null series (an area with no export rate bound) untouched", () => {
    expect(exportReceiptSeries([null, null])).toEqual([null, null]);
  });
});
