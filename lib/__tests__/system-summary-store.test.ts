import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  aggregateSummaryReadings,
  getSubscriberSystemIds,
  updateSubscriberSummary,
  updateSubscriberSummaries,
} from "../system-summary-store";

// Mock the KV client
jest.mock("../kv", () => ({
  kv: {
    hset: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    hget: jest.fn<() => Promise<any>>().mockResolvedValue(null),
    hgetall: jest
      .fn<() => Promise<Record<string, any>>>()
      .mockResolvedValue({}),
    hdel: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    get: jest.fn<() => Promise<any>>().mockResolvedValue(null),
    hscan: jest
      .fn<() => Promise<[number, (string | number)[]]>>()
      .mockResolvedValue([0, []]),
  },
  kvKey: jest.fn((pattern: string) => `test:${pattern}`),
}));

// Mock the latest-values-store
jest.mock("../latest-values-store", () => ({
  getLatestValues: jest
    .fn<() => Promise<Record<string, any>>>()
    .mockResolvedValue({}),
}));

describe("system-summary-store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  describe("getSubscriberSystemIds", () => {
    it("should return empty array when no subscriptions exist", async () => {
      const { kv } = await import("../kv");
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      const result = await getSubscriberSystemIds(10);

      expect(result).toEqual([]);
    });

    it("should extract unique subscriber system IDs from subscriptions", async () => {
      const { kv } = await import("../kv");

      // Mock subscription registry: source system 10 has subscribers
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: {
          "1": ["100.0", "101.0"], // Point 1 subscribed by systems 100 and 101
          "2": ["100.1", "102.0"], // Point 2 subscribed by systems 100 and 102
        },
        lastUpdatedTimeMs: Date.now(),
      });

      const result = await getSubscriberSystemIds(10);

      // Should return unique IDs: 100, 101, 102
      expect(result).toHaveLength(3);
      expect(result).toContain(100);
      expect(result).toContain(101);
      expect(result).toContain(102);
    });

    it("should use correct KV key for subscriptions", async () => {
      const { kv, kvKey } = await import("../kv");
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      await getSubscriberSystemIds(10);

      expect(kvKey).toHaveBeenCalledWith("subscriptions:system:10");
    });
  });

  describe("updateSubscriberSummary", () => {
    it("should update summary using latest values from KV", async () => {
      const { kv } = await import("../kv");
      const { getLatestValues } = await import("../latest-values-store");

      // Mock latest values for composite system 100
      (getLatestValues as jest.MockedFunction<any>).mockResolvedValueOnce({
        "source.solar/power": {
          logicalPath: "source.solar/power",
          value: 5000,
          measurementTimeMs: 1731627600000,
        },
        "load/power": {
          logicalPath: "load/power",
          value: 1500,
          measurementTimeMs: 1731627600000,
        },
        "bidi.battery/soc": {
          logicalPath: "bidi.battery/soc",
          value: 85,
          measurementTimeMs: 1731627600000,
        },
        "bidi.grid/power": {
          logicalPath: "bidi.grid/power",
          value: -500,
          measurementTimeMs: 1731627600000,
        },
      });

      await updateSubscriberSummary(100);

      // Should fetch latest values for system 100
      expect(getLatestValues).toHaveBeenCalledWith(100);

      // Should update the system-summaries hash
      expect(kv.hset).toHaveBeenCalledWith(
        "test:system-summaries",
        expect.objectContaining({
          "100": expect.objectContaining({
            measurementTimeMs: 1731627600000,
            readings: {
              "source.solar/power": 5000,
              "load/power": 1500,
              "bidi.battery/soc": 85,
              "bidi.grid/power": -500,
            },
          }),
        }),
      );
    });

    it("should not update when no latest values exist", async () => {
      const { kv } = await import("../kv");
      const { getLatestValues } = await import("../latest-values-store");

      (getLatestValues as jest.MockedFunction<any>).mockResolvedValueOnce({});

      await updateSubscriberSummary(100);

      expect(kv.hset).not.toHaveBeenCalled();
    });

    it("should skip non-numeric values", async () => {
      const { kv } = await import("../kv");
      const { getLatestValues } = await import("../latest-values-store");

      (getLatestValues as jest.MockedFunction<any>).mockResolvedValueOnce({
        "source.solar/power": {
          logicalPath: "source.solar/power",
          value: 5000,
          measurementTimeMs: 1731627600000,
        },
        "tariff/period": {
          logicalPath: "tariff/period",
          value: "pk", // string value - should be skipped
          measurementTimeMs: 1731627600000,
        },
      });

      await updateSubscriberSummary(100);

      expect(kv.hset).toHaveBeenCalledWith(
        "test:system-summaries",
        expect.objectContaining({
          "100": expect.objectContaining({
            readings: {
              "source.solar/power": 5000,
            },
          }),
        }),
      );
    });
  });

  describe("updateSubscriberSummaries", () => {
    it("should update summaries for all subscribers", async () => {
      const { kv } = await import("../kv");
      const { getLatestValues } = await import("../latest-values-store");

      // Mock subscriptions: source system 10 has subscribers 100 and 101
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: {
          "1": ["100.0", "101.0"],
        },
        lastUpdatedTimeMs: Date.now(),
      });

      // Mock latest values for both subscribers
      (getLatestValues as jest.MockedFunction<any>)
        .mockResolvedValueOnce({
          "source.solar/power": {
            logicalPath: "source.solar/power",
            value: 5000,
            measurementTimeMs: 1731627600000,
          },
        })
        .mockResolvedValueOnce({
          "load/power": {
            logicalPath: "load/power",
            value: 1500,
            measurementTimeMs: 1731627600000,
          },
        });

      await updateSubscriberSummaries(10);

      // Should fetch latest values for both subscribers
      expect(getLatestValues).toHaveBeenCalledWith(100);
      expect(getLatestValues).toHaveBeenCalledWith(101);

      // Should update summaries for both
      expect(kv.hset).toHaveBeenCalledTimes(2);
    });

    it("should not call getLatestValues when no subscribers exist", async () => {
      const { kv } = await import("../kv");
      const { getLatestValues } = await import("../latest-values-store");

      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      await updateSubscriberSummaries(10);

      expect(getLatestValues).not.toHaveBeenCalled();
      expect(kv.hset).not.toHaveBeenCalled();
    });

    it("should continue updating other subscribers if one fails", async () => {
      const { kv } = await import("../kv");
      const { getLatestValues } = await import("../latest-values-store");

      // Mock subscriptions with 3 subscribers
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: {
          "1": ["100.0", "101.0", "102.0"],
        },
        lastUpdatedTimeMs: Date.now(),
      });

      // First subscriber fails, second and third succeed
      (getLatestValues as jest.MockedFunction<any>)
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          "source.solar/power": {
            logicalPath: "source.solar/power",
            value: 5000,
            measurementTimeMs: 1731627600000,
          },
        })
        .mockResolvedValueOnce({
          "load/power": {
            logicalPath: "load/power",
            value: 1500,
            measurementTimeMs: 1731627600000,
          },
        });

      // Should not throw
      await expect(updateSubscriberSummaries(10)).resolves.not.toThrow();

      // Should still update the successful subscribers
      expect(kv.hset).toHaveBeenCalledTimes(2);
    });
  });
});
