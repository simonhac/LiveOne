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

  it("converts kW to W (×1000, rounded) and inverts the bidi channels to canonical signs", () => {
    const data = sigenergyFlowToData(liveFlow, ts);
    expect(data.solarW).toBe(0);
    // Vendor −0.3 kW = discharging; canonical convention is + for discharge.
    expect(data.batteryW).toBe(300);
    expect(data.loadW).toBe(300);
    expect(data.gridW).toBe(0);
    expect(data.evW).toBe(0);
  });

  // Real payload (2026-07-27 02:35): EV drawing 6.66 kW, house 0.73 kW, PV 2.0 kW, battery idle,
  // grid −5.39 (vendor sign) = IMPORTING 5.39 kW. The vendor identity pv = grid + battery + load + ev
  // closes exactly: 2.00 = −5.39 + 0 + 0.73 + 6.66.
  it("maps a live importing/EV-charging snapshot to canonical signs", () => {
    const data = sigenergyFlowToData(
      {
        pvKw: 2.0,
        batteryKw: 0,
        gridKw: -5.39,
        loadKw: 0.73,
        evKw: 6.66,
        batterySoc: 34.2,
        raw: {},
      },
      ts,
    );
    expect(data.solarW).toBe(2000);
    expect(data.gridW).toBe(5390); // import is POSITIVE canonically
    expect(data.loadW).toBe(730);
    expect(data.evW).toBe(6660);
    // Canonical balance: solar + import = load + ev  (battery idle)
    expect(data.solarW! + data.gridW!).toBe(data.loadW! + data.evW!);
  });

  it("maps vendor charging/exporting to negative canonical values", () => {
    const data = sigenergyFlowToData(
      { ...liveFlow, batteryKw: 6.4, gridKw: 1.25 },
      ts,
    );
    expect(data.batteryW).toBe(-6400); // charge is a load → negative
    expect(data.gridW).toBe(-1250); // export is a load → negative
  });

  it("does not emit negative zero", () => {
    expect(Object.is(sigenergyFlowToData(liveFlow, ts).gridW, -0)).toBe(false);
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
    // Canonical sign: the fixture's vendor −0.3 kW (discharging) normalises to +300 W.
    expect(battery?.rawValue).toBe(300);
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
