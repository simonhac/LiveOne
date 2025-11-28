/**
 * Integration tests for point-to-point subscription registry
 * These tests require real Vercel KV credentials in .env.local
 *
 * Run with: npm run test:integration subscription-registry
 *
 * Prerequisites:
 * 1. KV_REST_API_URL and KV_REST_API_TOKEN in .env.local
 * 2. Tests use 'test' namespace to avoid polluting dev/prod
 * 3. Real database access for composite system metadata
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import {
  buildSubscriptionRegistry,
  updateLatestPointValue,
  getLatestPointValues,
} from "../kv-cache-manager";
import { kv, kvKey } from "../kv";
import { db } from "../db";
import { systems as systemsTable } from "../db/schema";
import { pointInfo as pointInfoTable } from "../db/schema-monitoring-points";
import { eq } from "drizzle-orm";

// Skip these tests if KV is not configured
const isKVConfigured = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

const describeIfKV = isKVConfigured ? describe : describe.skip;

describeIfKV("Subscription Registry (integration)", () => {
  // Use test system IDs that won't conflict with real data
  const testSourceSystemId = 99990;
  const testCompositeSystemId1 = 99991;
  const testCompositeSystemId2 = 99992;

  // Cleanup function to remove test data
  async function cleanup() {
    try {
      // Clean up KV keys
      await Promise.all([
        kv.del(kvKey(`latest:system:${testSourceSystemId}`)),
        kv.del(kvKey(`latest:system:${testCompositeSystemId1}`)),
        kv.del(kvKey(`latest:system:${testCompositeSystemId2}`)),
        kv.del(kvKey(`subscriptions:system:${testSourceSystemId}`)),
      ]);

      // Clean up database test systems (if they exist)
      await db
        .delete(systemsTable)
        .where(eq(systemsTable.id, testSourceSystemId));
      await db
        .delete(systemsTable)
        .where(eq(systemsTable.id, testCompositeSystemId1));
      await db
        .delete(systemsTable)
        .where(eq(systemsTable.id, testCompositeSystemId2));
    } catch (error) {
      console.error("Cleanup error:", error);
      // Ignore cleanup errors - keys/systems might not exist
    }
  }

  beforeAll(async () => {
    await cleanup();
  }, 15000); // 15 second timeout

  afterAll(async () => {
    await cleanup();
  }, 15000); // 15 second timeout

  describe("buildSubscriptionRegistry", () => {
    it("should create point-to-point mappings from composite metadata", async () => {
      // Create test source system with points
      await db.insert(systemsTable).values({
        id: testSourceSystemId,
        ownerClerkUserId: "test_user",
        displayName: "Test Source System",
        vendorType: "sungrow",
        vendorSiteId: "test-source",
        status: "active",
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Brisbane",
      });

      // Create test points on source system
      await db.insert(pointInfoTable).values([
        {
          systemId: testSourceSystemId,
          index: 1,
          physicalPathTail: "sungrow/solar_w",
          logicalPathStem: "source.solar",
          defaultName: "Solar Power",
          displayName: "Solar Power",
          metricType: "power",
          metricUnit: "W",
          subsystem: "solar",
          active: true,
          createdAtMs: Date.now(),
        },
        {
          systemId: testSourceSystemId,
          index: 2,
          physicalPathTail: "sungrow/battery_soc",
          logicalPathStem: "bidi.battery",
          defaultName: "Battery SoC",
          displayName: "Battery SoC",
          metricType: "soc",
          metricUnit: "%",
          subsystem: "battery",
          active: true,
          createdAtMs: Date.now(),
        },
      ]);

      // Create composite system 1 that subscribes to both points
      await db.insert(systemsTable).values({
        id: testCompositeSystemId1,
        ownerClerkUserId: "test_user",
        displayName: "Test Composite 1",
        vendorType: "composite",
        vendorSiteId: "test-composite-1",
        status: "active",
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Brisbane",
        metadata: {
          version: 2,
          mappings: {
            solar: [`${testSourceSystemId}.1`], // Subscribe to source point 1
            battery: [`${testSourceSystemId}.2`], // Subscribe to source point 2
          },
        },
      });

      // Create composite system 2 that subscribes only to solar
      await db.insert(systemsTable).values({
        id: testCompositeSystemId2,
        ownerClerkUserId: "test_user",
        displayName: "Test Composite 2",
        vendorType: "composite",
        vendorSiteId: "test-composite-2",
        status: "active",
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Brisbane",
        metadata: {
          version: 2,
          mappings: {
            solar: [`${testSourceSystemId}.1`], // Subscribe to source point 1 only
          },
        },
      });

      // Build the subscription registry
      await buildSubscriptionRegistry();

      // Verify the registry was created correctly
      const registryKey = kvKey(`subscriptions:system:${testSourceSystemId}`);
      const registry = await kv.get(registryKey);

      expect(registry).toBeDefined();
      expect(registry).toHaveProperty("pointSubscribers");
      expect(registry).toHaveProperty("lastUpdatedTimeMs");

      const pointSubscribers = (registry as any).pointSubscribers;

      // Point 1 should have 2 subscribers (both composites)
      expect(pointSubscribers["1"]).toBeDefined();
      expect(pointSubscribers["1"]).toHaveLength(2);
      expect(pointSubscribers["1"]).toContain(`${testCompositeSystemId1}.0`); // First point in composite 1
      expect(pointSubscribers["1"]).toContain(`${testCompositeSystemId2}.0`); // First point in composite 2

      // Point 2 should have 1 subscriber (only composite 1)
      expect(pointSubscribers["2"]).toBeDefined();
      expect(pointSubscribers["2"]).toHaveLength(1);
      expect(pointSubscribers["2"]).toContain(`${testCompositeSystemId1}.1`); // Second point in composite 1
    }, 30000);

    it("should handle composite systems with no valid mappings", async () => {
      // Create composite with invalid metadata
      const invalidCompositeId = 99993;
      await db.insert(systemsTable).values({
        id: invalidCompositeId,
        ownerClerkUserId: "test_user",
        displayName: "Invalid Composite",
        vendorType: "composite",
        vendorSiteId: "test-invalid",
        status: "active",
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Brisbane",
        metadata: {
          version: 1, // Wrong version
        },
      });

      // Should not throw
      await expect(buildSubscriptionRegistry()).resolves.not.toThrow();

      // Cleanup
      await db
        .delete(systemsTable)
        .where(eq(systemsTable.id, invalidCompositeId));
    }, 20000);

    afterAll(async () => {
      // Clean up systems created in this describe block
      await cleanup();
    }, 15000);
  });

  describe("updateLatestPointValue with subscriptions", () => {
    beforeAll(async () => {
      // Set up test systems and subscription registry
      await db.insert(systemsTable).values({
        id: testSourceSystemId,
        ownerClerkUserId: "test_user",
        displayName: "Test Source",
        vendorType: "sungrow",
        vendorSiteId: "test-source",
        status: "active",
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Brisbane",
      });

      await db.insert(pointInfoTable).values([
        {
          systemId: testSourceSystemId,
          index: 1,
          physicalPathTail: "sungrow/solar_w",
          logicalPathStem: "source.solar",
          defaultName: "Solar",
          displayName: "Solar",
          metricType: "power",
          metricUnit: "W",
          active: true,
          createdAtMs: Date.now(),
        },
        {
          systemId: testSourceSystemId,
          index: 2,
          physicalPathTail: "sungrow/battery_soc",
          logicalPathStem: "bidi.battery",
          defaultName: "Battery",
          displayName: "Battery",
          metricType: "soc",
          metricUnit: "%",
          active: true,
          createdAtMs: Date.now(),
        },
      ]);

      await db.insert(systemsTable).values({
        id: testCompositeSystemId1,
        ownerClerkUserId: "test_user",
        displayName: "Composite 1",
        vendorType: "composite",
        vendorSiteId: "comp1",
        status: "active",
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Brisbane",
        metadata: {
          version: 2,
          mappings: {
            solar: [`${testSourceSystemId}.1`],
            battery: [`${testSourceSystemId}.2`],
          },
        },
      });

      await db.insert(systemsTable).values({
        id: testCompositeSystemId2,
        ownerClerkUserId: "test_user",
        displayName: "Composite 2",
        vendorType: "composite",
        vendorSiteId: "comp2",
        status: "active",
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Brisbane",
        metadata: {
          version: 2,
          mappings: {
            solar: [`${testSourceSystemId}.1`], // Only solar, not battery
          },
        },
      });

      await buildSubscriptionRegistry();
    }, 30000);

    it("should only cache subscribed points to composite systems", async () => {
      const pointPath1 = "source.solar/power";
      const pointPath2 = "bidi.battery/soc";
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      // Update point 1 (subscribed by both composites)
      await updateLatestPointValue(
        testSourceSystemId,
        1, // Point index
        pointPath1,
        5000,
        Date.now(),
        receivedTimeMs,
        "W",
        "Solar",
      );

      // Update point 2 (subscribed by composite 1 only)
      await updateLatestPointValue(
        testSourceSystemId,
        2, // Point index
        pointPath2,
        85,
        Date.now(),
        receivedTimeMs,
        "%",
        "Battery",
      );

      // Verify source system has both values
      const sourceValues = await getLatestPointValues(testSourceSystemId);
      expect(sourceValues[pointPath1]).toBeDefined();
      expect(sourceValues[pointPath1].value).toBe(5000);
      expect(sourceValues[pointPath2]).toBeDefined();
      expect(sourceValues[pointPath2].value).toBe(85);

      // Composite 1 should have both points (it subscribes to both)
      const composite1Values = await getLatestPointValues(
        testCompositeSystemId1,
      );
      expect(composite1Values[pointPath1]).toBeDefined();
      expect(composite1Values[pointPath1].value).toBe(5000);
      expect(composite1Values[pointPath2]).toBeDefined();
      expect(composite1Values[pointPath2].value).toBe(85);

      // Composite 2 should only have point 1 (it doesn't subscribe to battery)
      const composite2Values = await getLatestPointValues(
        testCompositeSystemId2,
      );
      expect(composite2Values[pointPath1]).toBeDefined();
      expect(composite2Values[pointPath1].value).toBe(5000);
      expect(composite2Values[pointPath2]).toBeUndefined(); // Battery not subscribed!
    }, 20000);

    it("should batch updates per composite system efficiently", async () => {
      const pointPath1 = "source.solar/power";
      const pointPath2 = "bidi.battery/soc";
      const now = Date.now();
      const sessionStart = new Date();
      const receivedTimeMs = sessionStart.getTime();

      // Update both points quickly
      await Promise.all([
        updateLatestPointValue(
          testSourceSystemId,
          1,
          pointPath1,
          6000,
          now,
          receivedTimeMs,
          "W",
          "Solar",
        ),
        updateLatestPointValue(
          testSourceSystemId,
          2,
          pointPath2,
          90,
          now,
          receivedTimeMs,
          "%",
          "Battery",
        ),
      ]);

      // Both should be in composite 1
      const composite1Values = await getLatestPointValues(
        testCompositeSystemId1,
      );
      expect(composite1Values[pointPath1].value).toBe(6000);
      expect(composite1Values[pointPath2].value).toBe(90);

      // Only solar in composite 2
      const composite2Values = await getLatestPointValues(
        testCompositeSystemId2,
      );
      expect(composite2Values[pointPath1].value).toBe(6000);
      expect(composite2Values[pointPath2]).toBeUndefined();
    }, 20000);
  });

  describe("subscription registry updates", () => {
    it("should reflect changes when composite metadata is updated", async () => {
      // Initial state: composite 2 only subscribes to solar
      let registry = await kv.get(
        kvKey(`subscriptions:system:${testSourceSystemId}`),
      );
      let pointSubscribers = (registry as any).pointSubscribers;
      expect(pointSubscribers["2"]).toHaveLength(1); // Only composite 1 subscribes to battery

      // Update composite 2 to also subscribe to battery
      await db
        .update(systemsTable)
        .set({
          metadata: {
            version: 2,
            mappings: {
              solar: [`${testSourceSystemId}.1`],
              battery: [`${testSourceSystemId}.2`], // Now subscribe to battery too
            },
          },
        })
        .where(eq(systemsTable.id, testCompositeSystemId2));

      // Rebuild registry
      await buildSubscriptionRegistry();

      // Verify battery now has 2 subscribers
      registry = await kv.get(
        kvKey(`subscriptions:system:${testSourceSystemId}`),
      );
      pointSubscribers = (registry as any).pointSubscribers;
      expect(pointSubscribers["2"]).toHaveLength(2); // Now both composites subscribe to battery
      expect(pointSubscribers["2"]).toContain(`${testCompositeSystemId1}.1`);
      expect(pointSubscribers["2"]).toContain(`${testCompositeSystemId2}.1`);
    }, 20000);
  });
});
