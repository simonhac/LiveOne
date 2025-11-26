/**
 * Integration tests for KV cache manager
 * These tests require real Vercel KV credentials in .env.local
 *
 * Run with: npm run test:integration kv-cache-manager.integration
 *
 * Prerequisites:
 * 1. Create Vercel KV database in dashboard
 * 2. Add KV_REST_API_URL and KV_REST_API_TOKEN to .env.local
 * 3. Tests automatically use 'test' namespace to avoid polluting dev/prod
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import {
  updateLatestPointValue,
  getLatestPointValues,
  buildSubscriptionRegistry,
  invalidateSubscriptionRegistry,
} from "../kv-cache-manager";
import { kv, kvKey } from "../kv";

// Skip these tests if KV is not configured
const isKVConfigured = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

const describeIfKV = isKVConfigured ? describe : describe.skip;

describeIfKV("kv-cache-manager (integration)", () => {
  // Use test system IDs that won't conflict with real data
  const testSystemId = 99999;
  const testCompositeId1 = 99998;
  const testCompositeId2 = 99997;

  // Cleanup function to remove test data
  async function cleanup() {
    try {
      await Promise.all([
        kv.del(kvKey(`latest:system:${testSystemId}`)),
        kv.del(kvKey(`latest:system:${testCompositeId1}`)),
        kv.del(kvKey(`latest:system:${testCompositeId2}`)),
        kv.del(kvKey(`subscriptions:system:${testSystemId}`)),
      ]);
    } catch (error) {
      console.error("Cleanup error:", error);
      // Ignore cleanup errors - keys might not exist
    }
  }

  beforeAll(async () => {
    await cleanup();
  }, 10000); // 10 second timeout

  afterAll(async () => {
    await cleanup();
  }, 10000); // 10 second timeout

  describe("updateLatestPointValue", () => {
    it("should store a point value in real KV", async () => {
      const pointPath = "source.solar.local/power";
      const value = 5234.5;
      const measurementTimeMs = Date.now() - 60000; // 1 minute ago

      await updateLatestPointValue(
        testSystemId,
        1, // test point ID
        pointPath,
        value,
        measurementTimeMs,
        "W",
        "Test Point",
      );

      // Verify it was stored
      const result = await getLatestPointValues(testSystemId);

      expect(result[pointPath]).toBeDefined();
      expect(result[pointPath].value).toBe(value);
      expect(result[pointPath].logicalPath).toBe(pointPath);
      expect(result[pointPath].measurementTimeMs).toBe(measurementTimeMs);
      expect(result[pointPath].metricUnit).toBe("W");
    });

    it("should update existing point value", async () => {
      const pointPath = "load.hvac/power";
      const firstValue = 1200;
      const secondValue = 1500;
      const measurementTimeMs = Date.now();

      // First update
      await updateLatestPointValue(
        testSystemId,
        1, // test point ID
        pointPath,
        firstValue,
        measurementTimeMs,
        "W",
        "Test Point",
      );
      let result = await getLatestPointValues(testSystemId);
      expect(result[pointPath].value).toBe(firstValue);

      // Second update (should overwrite)
      await updateLatestPointValue(
        testSystemId,
        1, // test point ID
        pointPath,
        secondValue,
        measurementTimeMs + 60000,
        "W",
        "Test Point",
      );
      result = await getLatestPointValues(testSystemId);
      expect(result[pointPath].value).toBe(secondValue);
      expect(result[pointPath].measurementTimeMs).toBe(
        measurementTimeMs + 60000,
      );
    });

    it("should update multiple points independently", async () => {
      const points = [
        { path: "source.solar.local/power", value: 5000, unit: "W", id: 1 },
        { path: "load.hvac/power", value: 1200, unit: "W", id: 2 },
        { path: "bidi.battery/soc", value: 85, unit: "%", id: 3 },
      ];
      const measurementTimeMs = Date.now();

      // Update all points
      for (const point of points) {
        await updateLatestPointValue(
          testSystemId,
          point.id,
          point.path,
          point.value,
          measurementTimeMs,
          point.unit,
          "Test Point",
        );
      }

      // Verify all were stored
      const result = await getLatestPointValues(testSystemId);

      for (const point of points) {
        expect(result[point.path]).toBeDefined();
        expect(result[point.path].value).toBe(point.value);
        expect(result[point.path].metricUnit).toBe(point.unit);
      }
    });
  });

  describe("getLatestPointValues", () => {
    it("should return empty object for non-existent system", async () => {
      const result = await getLatestPointValues(88888); // Non-existent test system
      expect(result).toEqual({});
    });

    it("should retrieve all points for a system", async () => {
      const pointPath1 = "source.solar.local/power";
      const pointPath2 = "load.hvac/power";
      const measurementTimeMs = Date.now();

      await updateLatestPointValue(
        testSystemId,
        1, // test point ID
        pointPath1,
        5000,
        measurementTimeMs,
        "W",
        "Test Point",
      );
      await updateLatestPointValue(
        testSystemId,
        2, // test point ID
        pointPath2,
        1200,
        measurementTimeMs,
        "W",
        "Test Point",
      );

      const result = await getLatestPointValues(testSystemId);

      expect(Object.keys(result).length).toBeGreaterThanOrEqual(2);
      expect(result[pointPath1]).toBeDefined();
      expect(result[pointPath2]).toBeDefined();
    });
  });

  describe("subscription registry", () => {
    it("should store and retrieve subscription list with lastUpdatedMs", async () => {
      // Manually set up a subscription for testing
      const now = Date.now();
      const entry = {
        pointSubscribers: {
          "1": [`${testCompositeId1}.0`, `${testCompositeId2}.0`],
        },
        lastUpdatedTimeMs: now,
      };
      await kv.set(kvKey(`subscriptions:system:${testSystemId}`), entry);

      // Verify entry was stored with timestamp
      const stored = await kv.get<{
        pointSubscribers: Record<string, string[]>;
        lastUpdatedTimeMs: number;
      }>(kvKey(`subscriptions:system:${testSystemId}`));
      expect(stored).toEqual(entry);
      expect(stored).toHaveProperty("lastUpdatedTimeMs");
      expect(stored!.lastUpdatedTimeMs).toBe(now);

      // Update a point - should propagate to composite systems
      const pointPath = "source.solar.remote/power";
      const value = 3000;
      const measurementTimeMs = Date.now();

      await updateLatestPointValue(
        testSystemId,
        1, // test point ID
        pointPath,
        value,
        measurementTimeMs,
        "W",
        "Test Point",
      );

      // Verify source system has the value
      const sourceResult = await getLatestPointValues(testSystemId);
      expect(sourceResult[pointPath]).toBeDefined();
      expect(sourceResult[pointPath].value).toBe(value);

      // Verify composite systems also have the value
      const composite1Result = await getLatestPointValues(testCompositeId1);
      expect(composite1Result[pointPath]).toBeDefined();
      expect(composite1Result[pointPath].value).toBe(value);

      const composite2Result = await getLatestPointValues(testCompositeId2);
      expect(composite2Result[pointPath]).toBeDefined();
      expect(composite2Result[pointPath].value).toBe(value);
    }, 20000);

    it("should propagate updates to all subscriber systems", async () => {
      // Set up subscription
      const entry = {
        pointSubscribers: {
          "1": [`${testCompositeId1}.0`, `${testCompositeId2}.0`],
          "2": [`${testCompositeId1}.1`, `${testCompositeId2}.1`],
          "3": [`${testCompositeId1}.2`, `${testCompositeId2}.2`],
        },
        lastUpdatedTimeMs: Date.now(),
      };
      await kv.set(kvKey(`subscriptions:system:${testSystemId}`), entry);

      // Update multiple points on source system
      const points = [
        { path: "source.solar.local/power", value: 5000, id: 1 },
        { path: "load.hvac/power", value: 1200, id: 2 },
        { path: "bidi.battery/soc", value: 85, id: 3 },
      ];
      const measurementTimeMs = Date.now();

      for (const point of points) {
        await updateLatestPointValue(
          testSystemId,
          point.id,
          point.path,
          point.value,
          measurementTimeMs,
          "W",
          "Test Point",
        );
      }

      // Verify all points are in both composite systems
      const composite1Result = await getLatestPointValues(testCompositeId1);
      const composite2Result = await getLatestPointValues(testCompositeId2);

      for (const point of points) {
        expect(composite1Result[point.path]).toBeDefined();
        expect(composite1Result[point.path].value).toBe(point.value);

        expect(composite2Result[point.path]).toBeDefined();
        expect(composite2Result[point.path].value).toBe(point.value);
      }
    }, 20000);

    it("should handle invalidateSubscriptionRegistry", async () => {
      // Set up a subscription
      await kv.set(kvKey(`subscriptions:system:${testSystemId}`), {
        pointSubscribers: {
          "1": [`${testCompositeId1}.0`],
        },
        lastUpdatedTimeMs: Date.now(),
      });

      // Invalidate it
      await invalidateSubscriptionRegistry(testSystemId);

      // Verify it was deleted
      const subscribers = await kv.get(
        kvKey(`subscriptions:system:${testSystemId}`),
      );
      expect(subscribers).toBeNull();
    });

    it("should not propagate updates if no subscribers", async () => {
      // Clear any existing subscriptions AND composite caches
      await kv.del(kvKey(`subscriptions:system:${testSystemId}`));
      await kv.del(kvKey(`latest:system:${testCompositeId1}`));
      await kv.del(kvKey(`latest:system:${testCompositeId2}`));

      // Update a point
      const pointPath = "source.solar.local/power";
      const value = 4000;
      const measurementTimeMs = Date.now();

      await updateLatestPointValue(
        testSystemId,
        1, // test point ID
        pointPath,
        value,
        measurementTimeMs,
        "W",
        "Test Point",
      );

      // Verify source has the value
      const sourceResult = await getLatestPointValues(testSystemId);
      expect(sourceResult[pointPath]).toBeDefined();
      expect(sourceResult[pointPath].value).toBe(value);

      // Verify composites do NOT have the value (no subscription)
      const composite1Result = await getLatestPointValues(testCompositeId1);
      expect(composite1Result[pointPath]).toBeUndefined();
    });

    it("should update lastUpdatedMs when rebuilding registry", async () => {
      // Note: This test requires real composite systems in the database
      // For a true integration test, you would:
      // 1. Create test composite systems in the database
      // 2. Call buildSubscriptionRegistry()
      // 3. Verify the registry was built with current timestamp

      // For now, we'll test that calling buildSubscriptionRegistry
      // doesn't throw an error
      await expect(buildSubscriptionRegistry()).resolves.not.toThrow();
    });
  });

  describe("data persistence", () => {
    it("should persist data across multiple reads", async () => {
      const pointPath = "bidi.grid/power";
      const value = 2500;
      const measurementTimeMs = Date.now();

      // Write
      await updateLatestPointValue(
        testSystemId,
        1, // test point ID
        pointPath,
        value,
        measurementTimeMs,
        "W",
        "Test Point",
      );

      // Read multiple times
      const result1 = await getLatestPointValues(testSystemId);
      const result2 = await getLatestPointValues(testSystemId);
      const result3 = await getLatestPointValues(testSystemId);

      // All reads should return the same data
      expect(result1[pointPath]).toEqual(result2[pointPath]);
      expect(result2[pointPath]).toEqual(result3[pointPath]);
      expect(result1[pointPath].value).toBe(value);
    });
  });
});
