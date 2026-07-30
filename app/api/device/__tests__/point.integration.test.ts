/**
 * Integration tests for /api/device/[systemId]/point/[pointId] endpoint
 *
 * Tests:
 * - GET: Fetching point info
 * - PATCH: Updating point info
 * - Authentication and authorization
 * - Validation
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
// Phase 5: the legacy store was decommissioned; the point lookup reads Postgres. config-v4 Phase 12
// terminal window: it reads `points ⋈ devices` — `point_info` was dropped by migration 0051. `points.rid`
// IS the `pointId` the route takes (`index` and `rid` are one column now), so the endpoint arguments are
// unchanged. See docs/deferred/postgres-integration-test-harness.md.
import { planetscaleDb } from "@/lib/db/planetscale";
import { devices, points } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

/**
 * Helper to make authenticated requests to the point endpoint
 */
async function getPointEndpoint(systemId: number, pointId: number) {
  const response = await fetch(
    `${BASE_URL}/api/device/${systemId}/point/${pointId}`,
    {
      headers: {
        "x-claude": "true", // Development auth bypass
      },
    },
  );

  return {
    status: response.status,
    data: await response.json(),
  };
}

async function patchPointEndpoint(
  systemId: number,
  pointId: number,
  updates: Record<string, any>,
) {
  const response = await fetch(
    `${BASE_URL}/api/device/${systemId}/point/${pointId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-claude": "true", // Development auth bypass
      },
      body: JSON.stringify(updates),
    },
  );

  return {
    status: response.status,
    data: await response.json(),
  };
}

describe("GET /api/device/[systemId]/point/[pointId]", () => {
  let testSystemId: number;
  let testPointId: number;

  beforeAll(async () => {
    // Get a test device from the database
    const deviceRows = await DeviceConfigRegistry.allDevices();

    if (deviceRows.length === 0) {
      throw new Error("No systems in database for testing");
    }

    testSystemId = deviceRows[0].id;

    if (!planetscaleDb) {
      throw new Error("Postgres not configured for integration test");
    }

    // Find a point for this device
    const [row] = await planetscaleDb
      .select({ points })
      .from(points)
      .innerJoin(devices, eq(devices.id, points.deviceId))
      .where(eq(devices.rid, testSystemId))
      .limit(1);

    if (!row) {
      throw new Error("No points found for test system");
    }

    const point = row.points;
    testPointId = point.rid;
  });

  describe("Authentication", () => {
    it("should return 200 with x-claude header in development", async () => {
      const { status } = await getPointEndpoint(testSystemId, testPointId);
      expect(status).toBe(200);
    });

    it("should return 401 without x-claude header", async () => {
      const response = await fetch(
        `${BASE_URL}/api/device/${testSystemId}/point/${testPointId}`,
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET point info", () => {
    it("should return point details", async () => {
      const { status, data } = await getPointEndpoint(
        testSystemId,
        testPointId,
      );

      expect(status).toBe(200);
      expect(data).toHaveProperty("systemId", testSystemId);
      expect(data).toHaveProperty("pointId", testPointId);
      expect(data).toHaveProperty("displayName");
      expect(data).toHaveProperty("metricType");
      expect(data).toHaveProperty("metricUnit");
      expect(data).toHaveProperty("active");
    });

    it("should return 404 for non-existent point", async () => {
      const { status, data } = await getPointEndpoint(testSystemId, 99999);
      expect(status).toBe(404);
      expect(data.error).toContain("not found");
    });

    it("should return 404 for non-existent system", async () => {
      const { status, data } = await getPointEndpoint(999999, 0);
      expect(status).toBe(404);
    });
  });
});

describe("PATCH /api/device/[systemId]/point/[pointId]", () => {
  let testSystemId: number;
  let testPointId: number;
  let originalPointData: any;

  beforeAll(async () => {
    // Get a test device from the database
    const deviceRows = await DeviceConfigRegistry.allDevices();

    if (deviceRows.length === 0) {
      throw new Error("No systems in database for testing");
    }

    testSystemId = deviceRows[0].id;

    if (!planetscaleDb) {
      throw new Error("Postgres not configured for integration test");
    }

    // Find a point for this device
    const [row] = await planetscaleDb
      .select({ points })
      .from(points)
      .innerJoin(devices, eq(devices.id, points.deviceId))
      .where(eq(devices.rid, testSystemId))
      .limit(1);

    if (!row) {
      throw new Error("No points found for test system");
    }

    const point = row.points;
    testPointId = point.rid;

    // Store original data to restore later
    originalPointData = {
      displayName: point.name,
      active: point.active,
      transform: point.transform,
    };
  });

  afterAll(async () => {
    // Restore original point data
    if (originalPointData) {
      await patchPointEndpoint(testSystemId, testPointId, originalPointData);
    }
  });

  describe("Update point info", () => {
    it("should update displayName", async () => {
      const newName = "Test Display Name " + Date.now();
      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        { displayName: newName },
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.point.displayName).toBe(newName);

      // Verify via GET
      const { data: getResult } = await getPointEndpoint(
        testSystemId,
        testPointId,
      );
      expect(getResult.displayName).toBe(newName);
    });

    it("should update active status", async () => {
      // Toggle active status
      const { data: before } = await getPointEndpoint(
        testSystemId,
        testPointId,
      );
      const newActive = !before.active;

      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        { active: newActive },
      );

      expect(status).toBe(200);
      expect(data.point.active).toBe(newActive);

      // Restore original
      await patchPointEndpoint(testSystemId, testPointId, {
        active: before.active,
      });
    });

    it("should update transform", async () => {
      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        { transform: "i" },
      );

      expect(status).toBe(200);
      expect(data.point.transform).toBe("i");

      // Reset transform
      await patchPointEndpoint(testSystemId, testPointId, { transform: null });
    });
  });

  describe("Validation", () => {
    it("should reject invalid transform value", async () => {
      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        { transform: "invalid" },
      );

      expect(status).toBe(400);
      expect(data.error).toContain("Invalid transform");
    });

    it("should reject empty updates", async () => {
      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        {},
      );

      expect(status).toBe(400);
      expect(data.error).toContain("No valid fields");
    });

    it("should return 404 for non-existent point", async () => {
      const { status, data } = await patchPointEndpoint(testSystemId, 99999, {
        active: true,
      });

      expect(status).toBe(404);
      expect(data.error).toContain("not found");
    });
  });
});
