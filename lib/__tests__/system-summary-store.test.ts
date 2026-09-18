import { describe, it, expect } from "@jest/globals";
import { aggregateSummaryReadings } from "../system-summary-store";

describe("system-summary-store", () => {
  describe("aggregateSummaryReadings", () => {
    it("should use master solar value when available", () => {
      const values = [
        { logicalPath: "source.solar/power", value: 5000 },
        { logicalPath: "source.solar.local/power", value: 3000 },
        { logicalPath: "source.solar.remote/power", value: 2000 },
      ];

      const result = aggregateSummaryReadings(values);

      expect(result["source.solar/power"]).toBe(5000);
    });

    it("should sum solar children when no master exists", () => {
      const values = [
        { logicalPath: "source.solar.local/power", value: 3000 },
        { logicalPath: "source.solar.remote/power", value: 2000 },
      ];

      const result = aggregateSummaryReadings(values);

      expect(result["source.solar/power"]).toBe(5000);
    });

    it("should use master load value when available", () => {
      const values = [
        { logicalPath: "load/power", value: 1500 },
        { logicalPath: "load.hvac/power", value: 800 },
        { logicalPath: "load.pool/power", value: 400 },
      ];

      const result = aggregateSummaryReadings(values);

      expect(result["load/power"]).toBe(1500);
    });

    it("should sum load children when no master exists", () => {
      const values = [
        { logicalPath: "load.hvac/power", value: 800 },
        { logicalPath: "load.pool/power", value: 400 },
        { logicalPath: "load.lights/power", value: 200 },
      ];

      const result = aggregateSummaryReadings(values);

      expect(result["load/power"]).toBe(1400);
    });

    it("should extract battery SOC directly", () => {
      const values = [{ logicalPath: "bidi.battery/soc", value: 85 }];

      const result = aggregateSummaryReadings(values);

      expect(result["bidi.battery/soc"]).toBe(85);
    });

    it("should extract grid power directly", () => {
      const values = [{ logicalPath: "bidi.grid/power", value: -500 }];

      const result = aggregateSummaryReadings(values);

      expect(result["bidi.grid/power"]).toBe(-500);
    });

    it("should omit fields with no matching data", () => {
      const values = [{ logicalPath: "some.other/path", value: 100 }];

      const result = aggregateSummaryReadings(values);

      expect(result["source.solar/power"]).toBeUndefined();
      expect(result["load/power"]).toBeUndefined();
      expect(result["bidi.battery/soc"]).toBeUndefined();
      expect(result["bidi.grid/power"]).toBeUndefined();
    });

    it("should handle mixed data correctly", () => {
      const values = [
        { logicalPath: "source.solar.local/power", value: 3000 },
        { logicalPath: "source.solar.remote/power", value: 2000 },
        { logicalPath: "load/power", value: 1500 },
        { logicalPath: "bidi.battery/soc", value: 90 },
        { logicalPath: "bidi.grid/power", value: 500 },
      ];

      const result = aggregateSummaryReadings(values);

      expect(result["source.solar/power"]).toBe(5000); // summed
      expect(result["load/power"]).toBe(1500); // master
      expect(result["bidi.battery/soc"]).toBe(90);
      expect(result["bidi.grid/power"]).toBe(500);
    });
  });
});
