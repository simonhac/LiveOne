import { describe, it, expect } from "@jest/globals";
import {
  SIGENERGY_POINTS,
  buildSigenergyReadings,
  sigenergyFlowToData,
} from "../point-metadata";
import type { SigenergyEnergyFlow } from "../types";

// Snapshot captured from the live account (station 102026062300090): battery discharging 0.3 kW
// to cover a 0.3 kW load, PV/grid/EV idle, SOC ~69.7%.
const liveFlow: SigenergyEnergyFlow = {
  pvKw: 0,
  batteryKw: -0.3,
  gridKw: 0,
  loadKw: 0.3,
  evKw: 0,
  batterySoc: 69.7,
  raw: {},
};

describe("sigenergyFlowToData", () => {
  const ts = new Date("2026-07-06T12:00:00Z");

  it("converts kW to W (×1000, rounded) and preserves sign", () => {
    const data = sigenergyFlowToData(liveFlow, ts);
    expect(data.solarW).toBe(0);
    expect(data.batteryW).toBe(-300); // discharge stays negative
    expect(data.loadW).toBe(300);
    expect(data.gridW).toBe(0);
    expect(data.evW).toBe(0);
  });

  it("passes SOC through unchanged (percent, not scaled)", () => {
    expect(sigenergyFlowToData(liveFlow, ts).batterySOC).toBe(69.7);
  });

  it("rounds fractional watts", () => {
    const data = sigenergyFlowToData({ ...liveFlow, pvKw: 5.2345 }, ts);
    expect(data.solarW).toBe(5235);
  });

  it("keeps nulls as null (does not coerce to 0)", () => {
    const data = sigenergyFlowToData(
      {
        pvKw: null,
        batteryKw: null,
        gridKw: null,
        loadKw: null,
        evKw: null,
        batterySoc: null,
        raw: {},
      },
      ts,
    );
    expect(data.solarW).toBeNull();
    expect(data.batterySOC).toBeNull();
  });

  it("carries the provided timestamp", () => {
    expect(sigenergyFlowToData(liveFlow, ts).timestamp).toBe(ts);
  });
});

describe("buildSigenergyReadings", () => {
  const measurementTime = Date.parse("2026-07-06T12:00:00Z");

  it("emits one reading per non-null point with correct metadata", () => {
    const data = sigenergyFlowToData(liveFlow, new Date(measurementTime));
    const readings = buildSigenergyReadings(data, measurementTime);

    // All six points are present (0 is a real value, not skipped).
    expect(readings).toHaveLength(SIGENERGY_POINTS.length);

    const battery = readings.find(
      (r) => r.pointMetadata.physicalPathTail === "battery_w",
    );
    expect(battery?.rawValue).toBe(-300);
    expect(battery?.measurementTime).toBe(measurementTime);
    expect(battery?.dataQuality).toBe("good");

    const soc = readings.find(
      (r) => r.pointMetadata.physicalPathTail === "battery_soc",
    );
    expect(soc?.rawValue).toBe(69.7);
    expect(soc?.pointMetadata.metricUnit).toBe("%");
  });

  it("skips null-valued points", () => {
    const data = sigenergyFlowToData(
      { ...liveFlow, evKw: null, gridKw: null },
      new Date(measurementTime),
    );
    const readings = buildSigenergyReadings(data, measurementTime);
    expect(readings).toHaveLength(SIGENERGY_POINTS.length - 2);
    expect(
      readings.find((r) => r.pointMetadata.physicalPathTail === "ev_w"),
    ).toBeUndefined();
  });

  it("uses unique physical path tails (point_uid depends on this)", () => {
    const tails = SIGENERGY_POINTS.map((p) => p.metadata.physicalPathTail);
    expect(new Set(tails).size).toBe(tails.length);
  });
});
