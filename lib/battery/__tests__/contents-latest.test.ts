import { describe, it, expect } from "@jest/globals";
import {
  batteryContentsFromData,
  CONTENTS_LATEST_PATHS as P,
} from "../contents-latest";

const iso = "2026-07-13T02:00:00.000Z";
const e = (value: number, measurementTime: string | Date = iso) => ({
  value,
  measurementTime,
});

/** Build a `dashboardDataQuery`-shaped payload from a partial latest map. */
const data = (latest: Record<string, unknown>) => ({ latest });

describe("batteryContentsFromData", () => {
  it("computes derived totals as intensity × storedEnergy", () => {
    const v = batteryContentsFromData(
      data({
        [P.storedEnergy]: e(10),
        [P.carbonIntensity]: e(200),
        [P.renewableFraction]: e(80),
        [P.priceActual]: e(5),
        [P.priceOpportunity]: e(13),
        [P.exportRate]: e(7),
      }),
    );
    expect(v).not.toBeNull();
    expect(v!.storedEnergyKwh).toBe(10);
    expect(v!.totalCarbonG).toBeCloseTo(2000, 6); // 200 × 10
    expect(v!.totalCostActualC).toBeCloseTo(50, 6); // 5 × 10
    expect(v!.totalCostOpportunityC).toBeCloseTo(80, 6); // (13 − 5) × 10
    expect(v!.renewableKwh).toBeCloseTo(8, 6); // 80% × 10
    expect(v!.exportValueC).toBeCloseTo(70, 6); // 7 × 10
    expect(v!.measurementTime).toBe(iso);
  });

  it("gates export value on the presence of an export tariff", () => {
    const v = batteryContentsFromData(
      data({ [P.storedEnergy]: e(10), [P.carbonIntensity]: e(200) }),
    );
    expect(v!.exportRate).toBeNull();
    expect(v!.exportValueC).toBeNull();
  });

  it("degrades: intensities present but no stored-energy → totals null, raw kept", () => {
    const v = batteryContentsFromData(
      data({
        [P.carbonIntensity]: e(150),
        [P.priceActual]: e(4),
        [P.priceOpportunity]: e(4),
      }),
    );
    expect(v).not.toBeNull();
    expect(v!.storedEnergyKwh).toBeNull();
    expect(v!.carbonIntensity).toBe(150);
    expect(v!.totalCarbonG).toBeNull();
    expect(v!.totalCostActualC).toBeNull();
    expect(v!.totalCostOpportunityC).toBeNull();
  });

  it("returns null when no battery point is present (export rate alone is not enough)", () => {
    expect(batteryContentsFromData(data({ [P.exportRate]: e(7) }))).toBeNull();
    expect(batteryContentsFromData(data({}))).toBeNull();
    expect(batteryContentsFromData(null)).toBeNull();
    expect(batteryContentsFromData(undefined)).toBeNull();
  });

  it("accepts a revived Date measurementTime", () => {
    const v = batteryContentsFromData(
      data({ [P.storedEnergy]: e(5, new Date(iso)) }),
    );
    expect(v!.measurementTime).toBe(iso);
  });

  it("handles a signed (negative) actual price", () => {
    // Amber paid you to charge: actual price −2 c/kWh, opportunity still 6.
    const v = batteryContentsFromData(
      data({
        [P.storedEnergy]: e(4),
        [P.priceActual]: e(-2),
        [P.priceOpportunity]: e(6),
      }),
    );
    expect(v!.totalCostActualC).toBeCloseTo(-8, 6); // −2 × 4
    expect(v!.totalCostOpportunityC).toBeCloseTo(32, 6); // (6 − −2) × 4
  });
});
