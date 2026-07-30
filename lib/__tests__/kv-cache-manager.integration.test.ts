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

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { Area, Device } from "@/lib/ids";
import {
  updateLatestPointValue,
  getLatestValues,
  buildSubscriptionRegistry,
  invalidateSubscriptionRegistry,
} from "../kv-cache-manager";
import { kv } from "../kv";
import {
  areaSubject,
  deviceSubject,
  latestValuesKey,
  subscriptionsKey,
} from "../kv-keys";

const testUid = (n: number | string) =>
  `0199aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;

// config-v4 Phase 13 PR 3: the KV keyspace is TypeID-native, so a test handle needs an identity. These
// three fake handles have no `legacy_handles` row, so the real resolver (which reads that table) is
// mocked with a static map — the KV round trips below stay real, which is the point of this suite.
// The SOURCE is a device; the two subscribers are Areas, which is the only shape the fan-out produces.
const TEST_SOURCE_HANDLE = 99999;
const TEST_AREA1_HANDLE = 99998;
const TEST_AREA2_HANDLE = 99997;
const TEST_SOURCE_DEVICE = Device.encode(
  "0199f999-0000-7000-8000-000000099999",
);
const TEST_AREA1 = Area.encode("0199f999-0000-7000-8000-000000099998");
const TEST_AREA2 = Area.encode("0199f999-0000-7000-8000-000000099997");

const SUBJECTS: Record<
  number,
  ReturnType<typeof deviceSubject> | ReturnType<typeof areaSubject>
> = {
  [TEST_SOURCE_HANDLE]: deviceSubject(TEST_SOURCE_DEVICE),
  [TEST_AREA1_HANDLE]: areaSubject(TEST_AREA1),
  [TEST_AREA2_HANDLE]: areaSubject(TEST_AREA2),
};

jest.mock("../kv-subjects", () => ({
  kvSourceSubjectForHandle: jest.fn(async (h: number) => SUBJECTS[h] ?? null),
  kvDeviceSubjectForHandle: jest.fn(async (h: number) => {
    const s = SUBJECTS[h];
    return s && s.kind === "device" ? s : null;
  }),
  kvSubjectsForHandle: jest.fn(async (h: number) =>
    SUBJECTS[h] ? [SUBJECTS[h]] : [],
  ),
}));

// Skip these tests if KV is not configured
const isKVConfigured = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

const describeIfKV = isKVConfigured ? describe : describe.skip;

describeIfKV("kv-cache-manager (integration)", () => {
  // Use test system IDs that won't conflict with real data
  const testSystemId = TEST_SOURCE_HANDLE;
  const testCompositeId1 = TEST_AREA1_HANDLE;
  const testCompositeId2 = TEST_AREA2_HANDLE;

  // Cleanup function to remove test data. Keys come from `lib/kv-keys.ts` — the single owner — rather
  // than being interpolated here, which is exactly the duplication this PR removed.
  async function cleanup() {
    try {
      await Promise.all([
        kv.del(latestValuesKey(SUBJECTS[testSystemId])),
        kv.del(latestValuesKey(SUBJECTS[testCompositeId1])),
        kv.del(latestValuesKey(SUBJECTS[testCompositeId2])),
        kv.del(subscriptionsKey(TEST_SOURCE_DEVICE)),
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
        testUid(1), // point uid — the subscription-map key (slice E PR 2b)
        pointPath,
        value,
        measurementTimeMs,
        Date.now(), // receivedTimeMs
        "W",
        "Test Point",
      );

      // Verify it was stored
      const result = await getLatestValues(testSystemId);

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
        testUid(1), // point uid — the subscription-map key (slice E PR 2b)
        pointPath,
        firstValue,
        measurementTimeMs,
        Date.now(), // receivedTimeMs
        "W",
        "Test Point",
      );
      let result = await getLatestValues(testSystemId);
      expect(result[pointPath].value).toBe(firstValue);

      // Second update (should overwrite)
      await updateLatestPointValue(
        testSystemId,
        testUid(1), // point uid — the subscription-map key (slice E PR 2b)
        pointPath,
        secondValue,
        measurementTimeMs + 60000,
        Date.now(), // receivedTimeMs
        "W",
        "Test Point",
      );
      result = await getLatestValues(testSystemId);
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
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      // Update all points
      for (const point of points) {
        await updateLatestPointValue(
          testSystemId,
          testUid(point.id), // point uid — the subscription-map key (slice E PR 2b)
          point.path,
          point.value,
          measurementTimeMs,
          receivedTimeMs,
          point.unit,
          "Test Point",
        );
      }

      // Verify all were stored
      const result = await getLatestValues(testSystemId);

      for (const point of points) {
        expect(result[point.path]).toBeDefined();
        expect(result[point.path].value).toBe(point.value);
        expect(result[point.path].metricUnit).toBe(point.unit);
      }
    });
  });

  describe("getLatestValues", () => {
    it("should return empty object for non-existent system", async () => {
      const result = await getLatestValues(88888); // Non-existent test system
      expect(result).toEqual({});
    });

    it("should retrieve all points for a system", async () => {
      const pointPath1 = "source.solar.local/power";
      const pointPath2 = "load.hvac/power";
      const measurementTimeMs = Date.now();
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      await updateLatestPointValue(
        testSystemId,
        testUid(1), // point uid — the subscription-map key (slice E PR 2b)
        pointPath1,
        5000,
        measurementTimeMs,
        receivedTimeMs,
        "W",
        "Test Point",
      );
      await updateLatestPointValue(
        testSystemId,
        testUid(2), // point uid — the subscription-map key (slice E PR 2b)
        pointPath2,
        1200,
        measurementTimeMs,
        receivedTimeMs,
        "W",
        "Test Point",
      );

      const result = await getLatestValues(testSystemId);

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
          [testUid(1)]: [TEST_AREA1, TEST_AREA2],
        },
        lastUpdatedTimeMs: now,
      };
      await kv.set(subscriptionsKey(TEST_SOURCE_DEVICE), entry);

      // Verify entry was stored with timestamp
      const stored = await kv.get<{
        pointSubscribers: Record<string, string[]>;
        lastUpdatedTimeMs: number;
      }>(subscriptionsKey(TEST_SOURCE_DEVICE));
      expect(stored).toEqual(entry);
      expect(stored).toHaveProperty("lastUpdatedTimeMs");
      expect(stored!.lastUpdatedTimeMs).toBe(now);

      // Update a point - should propagate to composite systems
      const pointPath = "source.solar.remote/power";
      const value = 3000;
      const measurementTimeMs = Date.now();
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      await updateLatestPointValue(
        testSystemId,
        testUid(1), // point uid — the subscription-map key (slice E PR 2b)
        pointPath,
        value,
        measurementTimeMs,
        receivedTimeMs,
        "W",
        "Test Point",
      );

      // Verify source system has the value
      const sourceResult = await getLatestValues(testSystemId);
      expect(sourceResult[pointPath]).toBeDefined();
      expect(sourceResult[pointPath].value).toBe(value);

      // Verify composite systems also have the value
      const composite1Result = await getLatestValues(testCompositeId1);
      expect(composite1Result[pointPath]).toBeDefined();
      expect(composite1Result[pointPath].value).toBe(value);

      const composite2Result = await getLatestValues(testCompositeId2);
      expect(composite2Result[pointPath]).toBeDefined();
      expect(composite2Result[pointPath].value).toBe(value);
    }, 20000);

    it("should propagate updates to all subscriber systems", async () => {
      // Set up subscription
      const entry = {
        pointSubscribers: {
          // Inner keys are the SOURCE POINT UUIDs (slice E PR 2b). They were left as "1"/"2"/"3" when
          // that slice re-keyed the map, so these two propagation assertions had been failing silently
          // on `main` ever since — fixed here, because propagation is exactly what PR 3 re-routes.
          [testUid(1)]: [TEST_AREA1, TEST_AREA2],
          [testUid(2)]: [TEST_AREA1, TEST_AREA2],
          [testUid(3)]: [TEST_AREA1, TEST_AREA2],
        },
        lastUpdatedTimeMs: Date.now(),
      };
      await kv.set(subscriptionsKey(TEST_SOURCE_DEVICE), entry);

      // Update multiple points on source system
      const points = [
        { path: "source.solar.local/power", value: 5000, id: 1 },
        { path: "load.hvac/power", value: 1200, id: 2 },
        { path: "bidi.battery/soc", value: 85, id: 3 },
      ];
      const measurementTimeMs = Date.now();
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      for (const point of points) {
        await updateLatestPointValue(
          testSystemId,
          testUid(point.id), // point uid — the subscription-map key (slice E PR 2b)
          point.path,
          point.value,
          measurementTimeMs,
          receivedTimeMs,
          "W",
          "Test Point",
        );
      }

      // Verify all points are in both composite systems
      const composite1Result = await getLatestValues(testCompositeId1);
      const composite2Result = await getLatestValues(testCompositeId2);

      for (const point of points) {
        expect(composite1Result[point.path]).toBeDefined();
        expect(composite1Result[point.path].value).toBe(point.value);

        expect(composite2Result[point.path]).toBeDefined();
        expect(composite2Result[point.path].value).toBe(point.value);
      }
    }, 20000);

    it("should handle invalidateSubscriptionRegistry", async () => {
      // Set up a subscription
      await kv.set(subscriptionsKey(TEST_SOURCE_DEVICE), {
        pointSubscribers: {
          [testUid(1)]: [TEST_AREA1],
        },
        lastUpdatedTimeMs: Date.now(),
      });

      // Invalidate it
      await invalidateSubscriptionRegistry(testSystemId);

      // Verify it was deleted
      const subscribers = await kv.get(subscriptionsKey(TEST_SOURCE_DEVICE));
      expect(subscribers).toBeNull();
    });

    it("should not propagate updates if no subscribers", async () => {
      // Clear any existing subscriptions AND composite caches
      await kv.del(subscriptionsKey(TEST_SOURCE_DEVICE));
      await kv.del(latestValuesKey(SUBJECTS[testCompositeId1]));
      await kv.del(latestValuesKey(SUBJECTS[testCompositeId2]));

      // Update a point
      const pointPath = "source.solar.local/power";
      const value = 4000;
      const measurementTimeMs = Date.now();
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      await updateLatestPointValue(
        testSystemId,
        testUid(1), // point uid — the subscription-map key (slice E PR 2b)
        pointPath,
        value,
        measurementTimeMs,
        receivedTimeMs,
        "W",
        "Test Point",
      );

      // Verify source has the value
      const sourceResult = await getLatestValues(testSystemId);
      expect(sourceResult[pointPath]).toBeDefined();
      expect(sourceResult[pointPath].value).toBe(value);

      // Verify composites do NOT have the value (no subscription)
      const composite1Result = await getLatestValues(testCompositeId1);
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
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      // Write
      await updateLatestPointValue(
        testSystemId,
        testUid(1), // point uid — the subscription-map key (slice E PR 2b)
        pointPath,
        value,
        measurementTimeMs,
        receivedTimeMs,
        "W",
        "Test Point",
      );

      // Read multiple times
      const result1 = await getLatestValues(testSystemId);
      const result2 = await getLatestValues(testSystemId);
      const result3 = await getLatestValues(testSystemId);

      // All reads should return the same data
      expect(result1[pointPath]).toEqual(result2[pointPath]);
      expect(result2[pointPath]).toEqual(result3[pointPath]);
      expect(result1[pointPath].value).toBe(value);
    });
  });
});
