/**
 * Integration tests for KV cache manager
 * These tests require real Vercel KV credentials in .env.local
 *
 * Run with: npm run test:integration kv-cache-manager.integration
 *
 * Prerequisites:
 * 1. Create Vercel KV database in dashboard
 * 2. Add KV_REST_API_URL and KV_REST_API_TOKEN to .env.local
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import {
  updateLatestPointValue,
  getLatestPointValues,
  buildSubscriptionRegistry,
  invalidateSubscriptionRegistry,
} from "../kv-cache-manager";
import { kv } from "../kv";

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
        kv.del(`latest:system:${testSystemId}`),
        kv.del(`latest:system:${testCompositeId1}`),
        kv.del(`latest:system:${testCompositeId2}`),
        kv.del(`subscriptions:system:${testSystemId}`),
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
        pointPath,
        value,
        measurementTimeMs,
        "W",
      );

      // Verify it was stored
      const result = await getLatestPointValues(testSystemId);

      expect(result[pointPath]).toBeDefined();
      expect(result[pointPath].value).toBe(value);
      expect(result[pointPath].measurementTimeMs).toBe(measurementTimeMs);
      expect(result[pointPath].receivedTimeMs).toBeGreaterThan(
        measurementTimeMs,
      );
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
        pointPath,
        firstValue,
        measurementTimeMs,
        "W",
      );
      let result = await getLatestPointValues(testSystemId);
      expect(result[pointPath].value).toBe(firstValue);

      // Second update (should overwrite)
      await updateLatestPointValue(
        testSystemId,
        pointPath,
        secondValue,
        measurementTimeMs + 60000,
        "W",
      );
      result = await getLatestPointValues(testSystemId);
      expect(result[pointPath].value).toBe(secondValue);
      expect(result[pointPath].measurementTimeMs).toBe(
        measurementTimeMs + 60000,
      );
    });

    it("should update multiple points independently", async () => {
      const points = [
        { path: "source.solar.local/power", value: 5000, unit: "W" },
        { path: "load.hvac/power", value: 1200, unit: "W" },
        { path: "bidi.battery/soc", value: 85, unit: "%" },
      ];
      const measurementTimeMs = Date.now();

      // Update all points
      for (const point of points) {
        await updateLatestPointValue(
          testSystemId,
          point.path,
          point.value,
          measurementTimeMs,
          point.unit,
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
        pointPath1,
        5000,
        measurementTimeMs,
        "W",
      );
      await updateLatestPointValue(
        testSystemId,
        pointPath2,
        1200,
        measurementTimeMs,
        "W",
      );

      const result = await getLatestPointValues(testSystemId);

      expect(Object.keys(result).length).toBeGreaterThanOrEqual(2);
      expect(result[pointPath1]).toBeDefined();
      expect(result[pointPath2]).toBeDefined();
    });
  });

  describe("subscription registry", () => {
    it("should store and retrieve subscription list", async () => {
      // Manually set up a subscription for testing
      const subscribers = [testCompositeId1, testCompositeId2];
      await kv.set(`subscriptions:system:${testSystemId}`, subscribers);

      // Update a point - should propagate to composite systems
      const pointPath = "source.solar.remote/power";
      const value = 3000;
      const measurementTimeMs = Date.now();

      await updateLatestPointValue(
        testSystemId,
        pointPath,
        value,
        measurementTimeMs,
        "W",
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
    });

    it("should handle invalidateSubscriptionRegistry", async () => {
      // Set up a subscription
      await kv.set(`subscriptions:system:${testSystemId}`, [testCompositeId1]);

      // Invalidate it
      await invalidateSubscriptionRegistry(testSystemId);

      // Verify it was deleted
      const subscribers = await kv.get(`subscriptions:system:${testSystemId}`);
      expect(subscribers).toBeNull();
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
        pointPath,
        value,
        measurementTimeMs,
        "W",
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
