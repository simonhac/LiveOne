/**
 * `/prices` records → the readings the sync stores (`buildPriceBatch`, the pure half of
 * `loadRemotePrices`): quality grading, Amber's own forecast as a second point, and channel ids.
 */
import { describe, expect, it } from "@jest/globals";
import { parseDate } from "@internationalized/date";
import { buildPriceBatch } from "../client";
import { NEM_TIME_MS, forecastRecord } from "./fixtures";
import type { Milliseconds } from "../types";

const DAY = parseDate("2026-08-14");
const at = NEM_TIME_MS as Milliseconds;
const band = { low: 30, predicted: 31.4, high: 40 };

describe("buildPriceBatch", () => {
  it.each([
    ["ForecastInterval", "f"],
    ["CurrentInterval", "e"],
    ["ActualInterval", "a"],
  ] as const)("grades a %s as %s", (type, quality) => {
    const batch = buildPriceBatch([forecastRecord({ type })], DAY, 1);
    expect(batch.get(at, "E1.perKwh")?.dataQuality).toBe(quality);
  });

  it("writes Amber's forecast as a second point beside perKwh, with the record's quality", () => {
    const batch = buildPriceBatch(
      [forecastRecord({ advancedPrice: band })],
      DAY,
      1,
    );
    expect(batch.get(at, "E1.perKwh")?.rawValue).toBe(32.5);
    const adv = batch.get(at, "E1.advPerKwh");
    expect(adv).toMatchObject({ rawValue: 31.4, dataQuality: "f" });
    expect(adv?.pointMetadata).toMatchObject({
      physicalPathTail: "E1/advPerKwh",
      logicalPathStem: "bidi.grid.import.forecast",
      metricType: "rate",
      metricUnit: "cents_kWh",
      defaultName: "Grid import (Amber forecast)",
    });
  });

  it("grades the CurrentInterval's forecast e as well", () => {
    const batch = buildPriceBatch(
      [forecastRecord({ type: "CurrentInterval", advancedPrice: band })],
      DAY,
      1,
    );
    expect(batch.get(at, "E1.advPerKwh")?.dataQuality).toBe("e");
  });

  it("writes no forecast point when Amber omits the band, or for an Actual", () => {
    const none = buildPriceBatch([forecastRecord()], DAY, 1);
    expect(none.get(at, "E1.advPerKwh")).toBeUndefined();
    const actual = buildPriceBatch(
      [forecastRecord({ type: "ActualInterval", advancedPrice: band })],
      DAY,
      1,
    );
    expect(actual.get(at, "E1.advPerKwh")).toBeUndefined();
  });

  it("maps channels to the usage endpoint's ids, controlled load included", () => {
    const batch = buildPriceBatch(
      [
        forecastRecord({ channelType: "feedIn", advancedPrice: band }),
        forecastRecord({ channelType: "controlledLoad", advancedPrice: band }),
      ],
      DAY,
      1,
    );
    expect(batch.get(at, "B1.perKwh")).toBeDefined();
    expect(batch.get(at, "B1.advPerKwh")?.pointMetadata.logicalPathStem).toBe(
      "bidi.grid.export.forecast",
    );
    expect(batch.get(at, "CL1.perKwh")).toBeDefined();
    expect(batch.get(at, "CL1.advPerKwh")?.pointMetadata.logicalPathStem).toBe(
      "bidi.grid.controlled.forecast",
    );
    expect(batch.get(at, "controlledLoad.perKwh")).toBeUndefined();
  });
});
