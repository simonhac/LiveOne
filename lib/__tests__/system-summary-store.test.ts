import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Area, Device } from "@/lib/ids";
import {
  aggregateSummaryReadings,
  getSubscriberAreaIds,
  updateSubscriberSummary,
  updateSubscriberSummaries,
} from "../system-summary-store";

// config-v4 Phase 13 PR 3: the KV keyspace is TypeID-native, so the fixtures are real TypeIDs rather
// than integers. Minted once at module load — `Area.is()` rejects anything else, which is exactly the
// guard that makes a stale pre-PR-3 ref degrade to "no subscribers".
const SOURCE_HANDLE = 10;
const SOURCE_DEVICE = Device.generate();
const AREA_A = Area.generate();
const AREA_B = Area.generate();
const AREA_C = Area.generate();

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
  getLatestValuesForSubject: jest
    .fn<() => Promise<Record<string, any>>>()
    .mockResolvedValue({}),
}));

// Mock the handle -> KV subject resolver (it reads `legacy_handles`).
jest.mock("../kv-subjects", () => ({
  kvDeviceSubjectForHandle: jest.fn(async (handle: number) =>
    handle === 10 ? { kind: "device", id: SOURCE_DEVICE } : null,
  ),
  kvSourceSubjectForHandle: jest.fn(async (handle: number) =>
    handle === 10 ? { kind: "device", id: SOURCE_DEVICE } : null,
  ),
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

  describe("getSubscriberAreaIds", () => {
    it("should return empty array when no subscriptions exist", async () => {
      const { kv } = await import("../kv");
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      const result = await getSubscriberAreaIds(SOURCE_HANDLE);

      expect(result).toEqual([]);
    });

    it("should extract unique subscriber Area ids from subscriptions", async () => {
      const { kv } = await import("../kv");

      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: {
          "0199a1-1": [AREA_A, AREA_B],
          "0199a1-2": [AREA_A, AREA_C],
        },
        lastUpdatedTimeMs: Date.now(),
      });

      const result = await getSubscriberAreaIds(SOURCE_HANDLE);

      expect(result).toHaveLength(3);
      expect(result).toContain(AREA_A);
      expect(result).toContain(AREA_B);
      expect(result).toContain(AREA_C);
    });

    it("should ignore pre-PR-3 `{handle}.{ordinal}` refs rather than mis-route them", async () => {
      const { kv } = await import("../kv");

      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: { "0199a1-1": ["100.0", AREA_A, "101.2"] },
        lastUpdatedTimeMs: Date.now(),
      });

      const result = await getSubscriberAreaIds(SOURCE_HANDLE);

      expect(result).toEqual([AREA_A]);
    });

    it("should read the device-keyed subscriptions entry", async () => {
      const { kv, kvKey } = await import("../kv");
      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      await getSubscriberAreaIds(SOURCE_HANDLE);

      expect(kvKey).toHaveBeenCalledWith(
        `subscriptions:device:${SOURCE_DEVICE}`,
      );
    });
  });

  describe("updateSubscriberSummary", () => {
    it("should update summary using the Area's own latest values", async () => {
      const { kv } = await import("../kv");
      const { getLatestValuesForSubject } = await import(
        "../latest-values-store"
      );

      (
        getLatestValuesForSubject as jest.MockedFunction<any>
      ).mockResolvedValueOnce({
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

      await updateSubscriberSummary({ kind: "area", id: AREA_A });

      // Reads the AREA's own hash, not a handle union
      expect(getLatestValuesForSubject).toHaveBeenCalledWith({
        kind: "area",
        id: AREA_A,
      });

      // Should update the system-summaries hash, keyed by the Area TypeID
      expect(kv.hset).toHaveBeenCalledWith(
        "test:system-summaries",
        expect.objectContaining({
          [AREA_A]: expect.objectContaining({
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
      const { getLatestValuesForSubject } = await import(
        "../latest-values-store"
      );

      (
        getLatestValuesForSubject as jest.MockedFunction<any>
      ).mockResolvedValueOnce({});

      await updateSubscriberSummary({ kind: "area", id: AREA_A });

      expect(kv.hset).not.toHaveBeenCalled();
    });

    it("should skip non-numeric values", async () => {
      const { kv } = await import("../kv");
      const { getLatestValuesForSubject } = await import(
        "../latest-values-store"
      );

      (
        getLatestValuesForSubject as jest.MockedFunction<any>
      ).mockResolvedValueOnce({
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

      await updateSubscriberSummary({ kind: "area", id: AREA_A });

      expect(kv.hset).toHaveBeenCalledWith(
        "test:system-summaries",
        expect.objectContaining({
          [AREA_A]: expect.objectContaining({
            readings: {
              "source.solar/power": 5000,
            },
          }),
        }),
      );
    });
  });

  describe("updateSubscriberSummaries", () => {
    it("should update summaries for all subscriber Areas", async () => {
      const { kv } = await import("../kv");
      const { getLatestValuesForSubject } = await import(
        "../latest-values-store"
      );

      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: { "0199a1-1": [AREA_A, AREA_B] },
        lastUpdatedTimeMs: Date.now(),
      });

      (getLatestValuesForSubject as jest.MockedFunction<any>)
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

      await updateSubscriberSummaries(SOURCE_HANDLE);

      expect(getLatestValuesForSubject).toHaveBeenCalledWith({
        kind: "area",
        id: AREA_A,
      });
      expect(getLatestValuesForSubject).toHaveBeenCalledWith({
        kind: "area",
        id: AREA_B,
      });

      // Should update summaries for both
      expect(kv.hset).toHaveBeenCalledTimes(2);
    });

    it("should not read any latest values when no subscribers exist", async () => {
      const { kv } = await import("../kv");
      const { getLatestValuesForSubject } = await import(
        "../latest-values-store"
      );

      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce(null);

      await updateSubscriberSummaries(SOURCE_HANDLE);

      expect(getLatestValuesForSubject).not.toHaveBeenCalled();
      expect(kv.hset).not.toHaveBeenCalled();
    });

    it("should continue updating other subscribers if one fails", async () => {
      const { kv } = await import("../kv");
      const { getLatestValuesForSubject } = await import(
        "../latest-values-store"
      );

      (kv.get as jest.MockedFunction<any>).mockResolvedValueOnce({
        pointSubscribers: { "0199a1-1": [AREA_A, AREA_B, AREA_C] },
        lastUpdatedTimeMs: Date.now(),
      });

      // First subscriber fails, second and third succeed
      (getLatestValuesForSubject as jest.MockedFunction<any>)
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
      await expect(
        updateSubscriberSummaries(SOURCE_HANDLE),
      ).resolves.not.toThrow();

      // Should still update the successful subscribers
      expect(kv.hset).toHaveBeenCalledTimes(2);
    });
  });
});
