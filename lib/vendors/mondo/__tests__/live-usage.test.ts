/**
 * Mondo's live-usage payload → the two readings `/subcircuit/` cannot produce.
 *
 * 🛑 The whole point of this file is that Mondo DOES publish battery state of charge and LiveOne
 * recorded `null` for it for as long as the adapter existed — because the poll reads
 * `/subcircuit/{id}`, which has no SoC field, and the comment "Not available from the subcircuit
 * endpoint" was read as "not available". Two of the cases below are the ones that would quietly
 * reintroduce a null: a falsy 0%, and a stale sample restamped as current.
 *
 * The sample payload is real, captured from the platform on 2026-09-11.
 */
import { describe, it, expect } from "@jest/globals";
import {
  batterySocReading,
  siteLoadReading,
  liveUsageReadings,
  type MondoLiveUsage,
} from "../live-usage";

const NOW = Date.parse("2026-09-11T04:00:00Z");

const LIVE: MondoLiveUsage = {
  demand: 4.35,
  lastRecordedUtc: "2026-09-11T03:50:00Z",
  liveUsageData: {
    battery: { deviceStatus: "Online", value: 7.52, stateOfCharge: 74 },
    generator: { deviceStatus: "Offline", value: 0 },
    grid: { deviceStatus: "Online", value: 2.3 },
    solar: { deviceStatus: "Online", value: 9.58 },
  },
};

describe("batterySocReading", () => {
  it("extracts the percentage the platform shows on its Live usage card", () => {
    const r = batterySocReading(LIVE, NOW);
    expect(r?.rawValue).toBe(74);
    expect(r?.pointMetadata).toMatchObject({
      physicalPathTail: "battery_soc",
      logicalPathStem: "bidi.battery",
      subsystem: "battery",
      metricType: "soc",
      metricUnit: "%",
      transform: null,
    });
  });

  it("keeps a genuine 0%", () => {
    // 🛑 The reading that matters most is the falsy one. `soc && …` or `soc ?` would drop a flat
    // battery and leave the series looking merely absent.
    const flat = {
      ...LIVE,
      liveUsageData: { battery: { stateOfCharge: 0 } },
    };
    expect(batterySocReading(flat, NOW)?.rawValue).toBe(0);
  });

  it("uses the VENDOR's timestamp, not the wall clock", () => {
    // 🛑 A stalled feed keeps returning its last value. Stamping that with `Date.now()` every
    // minute would render a dead battery monitor as a perfectly flat, perfectly current line —
    // erasing the one signal that would reveal the stall.
    expect(batterySocReading(LIVE, NOW)?.measurementTime).toBe(
      Date.parse("2026-09-11T03:50:00Z"),
    );
    expect(batterySocReading(LIVE, NOW)?.measurementTime).not.toBe(NOW);
  });

  it("falls back to now when the vendor timestamp is missing or unparseable", () => {
    const noTs = { ...LIVE, lastRecordedUtc: undefined };
    expect(batterySocReading(noTs, NOW)?.measurementTime).toBe(NOW);
    const badTs = { ...LIVE, lastRecordedUtc: "not a date" };
    expect(batterySocReading(badTs, NOW)?.measurementTime).toBe(NOW);
  });

  it("returns null for a site with no battery, rather than inventing a zero", () => {
    expect(
      batterySocReading(
        { ...LIVE, liveUsageData: { grid: { value: 2.3 } } },
        NOW,
      ),
    ).toBeNull();
    expect(batterySocReading({}, NOW)).toBeNull();
    expect(batterySocReading(null, NOW)).toBeNull();
    expect(batterySocReading(undefined, NOW)).toBeNull();
  });

  it("refuses a non-numeric or non-finite percentage", () => {
    // The vendor has been seen to answer "n/a" on other status endpoints for battery types it
    // does not understand; a string must not become a reading.
    const asString = {
      liveUsageData: { battery: { stateOfCharge: "74" } },
    } as unknown as MondoLiveUsage;
    expect(batterySocReading(asString, NOW)).toBeNull();
    const nan = {
      liveUsageData: { battery: { stateOfCharge: NaN } },
    } as MondoLiveUsage;
    expect(batterySocReading(nan, NOW)).toBeNull();
  });
});

describe("siteLoadReading", () => {
  // 🛑 `demand` is the vendor's own computed SITE LOAD, and it is NOT the sum of the subcircuits:
  // an unmonitored circuit contributes to demand and to no subcircuit. It is the only whole-of-site
  // load figure Mondo publishes, and device 6 had no `load/power` point at all without it.
  it("extracts demand and converts kW to W", () => {
    const r = siteLoadReading(LIVE, NOW);
    // 🛑 4.35 kW, stored as 4350 W. Every power point in LiveOne is watts; forgetting the ×1000
    // gives a number that is plausible and 1000× out.
    expect(r?.rawValue).toBe(4350);
    expect(r?.pointMetadata).toMatchObject({
      physicalPathTail: "site_load_w",
      logicalPathStem: "load",
      subsystem: "load",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    });
  });

  it("keeps a genuine 0 W", () => {
    // Falsy, and real: a fully-exporting or idle site reads zero demand. `demand && …` drops it.
    const r = siteLoadReading({ ...LIVE, demand: 0 }, NOW);
    expect(r?.rawValue).toBe(0);
  });

  it("uses the VENDOR's timestamp, not the wall clock", () => {
    // A stalled feed keeps returning its last value; restamping it `now` every minute turns the one
    // signal that would reveal the stall into a flat, plausible line.
    expect(siteLoadReading(LIVE, NOW)?.measurementTime).toBe(
      Date.parse("2026-09-11T03:50:00Z"),
    );
  });

  it("falls back to now when the vendor timestamp is missing", () => {
    const { lastRecordedUtc, ...noStamp } = LIVE;
    void lastRecordedUtc;
    expect(siteLoadReading(noStamp, NOW)?.measurementTime).toBe(NOW);
  });

  it("returns null when the payload carries no demand, rather than inventing a zero", () => {
    const { demand, ...noDemand } = LIVE;
    void demand;
    expect(siteLoadReading(noDemand, NOW)).toBeNull();
    expect(siteLoadReading(null, NOW)).toBeNull();
  });

  it("refuses a non-numeric or non-finite demand", () => {
    expect(siteLoadReading({ demand: NaN }, NOW)).toBeNull();
    expect(
      siteLoadReading({ demand: "4.35" } as unknown as MondoLiveUsage, NOW),
    ).toBeNull();
  });
});

describe("liveUsageReadings", () => {
  it("returns both readings from one payload", () => {
    const rs = liveUsageReadings(LIVE, NOW);
    expect(rs.map((r) => r.pointMetadata.physicalPathTail)).toEqual([
      "battery_soc",
      "site_load_w",
    ]);
  });

  it("keeps each independently optional", () => {
    // A battery-less site still reports demand; a payload with neither is empty, not a failure.
    const { liveUsageData, ...noBattery } = LIVE;
    void liveUsageData;
    expect(
      liveUsageReadings(noBattery, NOW).map(
        (r) => r.pointMetadata.physicalPathTail,
      ),
    ).toEqual(["site_load_w"]);
    expect(liveUsageReadings({}, NOW)).toEqual([]);
    expect(liveUsageReadings(null, NOW)).toEqual([]);
  });

  it("marks both good — they are the vendor's own live samples", () => {
    for (const r of liveUsageReadings(LIVE, NOW))
      expect(r.dataQuality).toBe("good");
  });
});
