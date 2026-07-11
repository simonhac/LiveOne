import { describe, it, expect } from "@jest/globals";
import { FUSHER_MANIFEST } from "../fusher";
import { buildReadings } from "../../core/build";

/**
 * Guards Kinkora continuity: the fusher manifest MUST mirror the server-side FUSHER_POINTS
 * (lib/vendors/fusher/point-metadata.ts) exactly — same physicalPathTails/stems/units — so migrated
 * data reuses the existing point_info rows. Keep these in lock-step until /api/push/fusher is retired.
 */

// The exact set the legacy /api/push/fusher path maps (order-independent).
const EXPECTED = new Map<
  string,
  { logicalPathStem: string | null; metricType: string; metricUnit: string }
>([
  [
    "solarW",
    { logicalPathStem: "source.solar", metricType: "power", metricUnit: "W" },
  ],
  [
    "solarRemoteW",
    {
      logicalPathStem: "source.solar.remote",
      metricType: "power",
      metricUnit: "W",
    },
  ],
  [
    "solarLocalW",
    {
      logicalPathStem: "source.solar.local",
      metricType: "power",
      metricUnit: "W",
    },
  ],
  ["loadW", { logicalPathStem: "load", metricType: "power", metricUnit: "W" }],
  [
    "batteryW",
    { logicalPathStem: "bidi.battery", metricType: "power", metricUnit: "W" },
  ],
  [
    "gridW",
    { logicalPathStem: "bidi.grid", metricType: "power", metricUnit: "W" },
  ],
  [
    "batterySOC",
    { logicalPathStem: "bidi.battery", metricType: "soc", metricUnit: "%" },
  ],
  [
    "faultCode",
    { logicalPathStem: null, metricType: "diagnostic", metricUnit: "text" },
  ],
  [
    "faultTimestamp",
    { logicalPathStem: null, metricType: "diagnostic", metricUnit: "epochMs" },
  ],
  [
    "generatorStatus",
    { logicalPathStem: null, metricType: "status", metricUnit: "bool" },
  ],
  [
    "solarWhInterval",
    { logicalPathStem: "source.solar", metricType: "energy", metricUnit: "Wh" },
  ],
  [
    "loadWhInterval",
    { logicalPathStem: "load", metricType: "energy", metricUnit: "Wh" },
  ],
  [
    "batteryInWhInterval",
    {
      logicalPathStem: "bidi.battery.charge",
      metricType: "energy",
      metricUnit: "Wh",
    },
  ],
  [
    "batteryOutWhInterval",
    {
      logicalPathStem: "bidi.battery.discharge",
      metricType: "energy",
      metricUnit: "Wh",
    },
  ],
  [
    "gridInWhInterval",
    {
      logicalPathStem: "bidi.grid.import",
      metricType: "energy",
      metricUnit: "Wh",
    },
  ],
  [
    "gridOutWhInterval",
    {
      logicalPathStem: "bidi.grid.export",
      metricType: "energy",
      metricUnit: "Wh",
    },
  ],
]);

describe("FUSHER_MANIFEST", () => {
  it("mirrors FUSHER_POINTS exactly (tail = key, same stem/type/unit, all transform null)", () => {
    expect(FUSHER_MANIFEST).toHaveLength(EXPECTED.size);
    for (const def of FUSHER_MANIFEST) {
      const exp = EXPECTED.get(def.physicalPathTail);
      expect(exp).toBeDefined();
      expect(def.key).toBe(def.physicalPathTail); // read() keys the values by field name
      expect(def.logicalPathStem ?? null).toBe(exp!.logicalPathStem);
      expect(def.metricType).toBe(exp!.metricType);
      expect(def.metricUnit).toBe(exp!.metricUnit);
      expect(def.transform ?? null).toBeNull();
    }
  });

  it("buildReadings maps a full minutely report to 16 self-describing readings, dropping n/a", () => {
    // A typical minute: power + SOC + interval energy present; no fault, no generator (Fronius).
    const values = {
      solarW: 4200,
      solarRemoteW: 3000,
      solarLocalW: 1200,
      loadW: 900,
      batteryW: -1500,
      gridW: -1800,
      batterySOC: 87.5,
      faultCode: null, // dropped
      faultTimestamp: null, // dropped
      generatorStatus: null, // dropped (Fronius has no generator)
      solarWhInterval: 70,
      loadWhInterval: 15,
      batteryInWhInterval: 25,
      batteryOutWhInterval: 0,
      gridInWhInterval: 0,
      gridOutWhInterval: 30,
    };
    const readings = buildReadings(FUSHER_MANIFEST, values);
    // 16 manifest points − 3 nulls = 13 readings
    expect(readings).toHaveLength(13);

    const solar = readings.find((r) => r.physicalPathTail === "solarW");
    expect(solar).toMatchObject({
      value: 4200,
      metricType: "power",
      metricUnit: "W",
      logicalPathStem: "source.solar",
      subsystem: "solar",
    });
    // n/a fields are not emitted
    expect(readings.some((r) => r.physicalPathTail === "generatorStatus")).toBe(
      false,
    );
    expect(readings.some((r) => r.physicalPathTail === "faultCode")).toBe(
      false,
    );
  });
});
