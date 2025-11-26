/**
 * Integration tests for /api/system/[systemId]/point/[pointId] endpoint
 *
 * Tests:
 * - GET: Fetching point info
 * - PATCH: Updating point info
 * - Authentication and authorization
 * - Validation
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
import { SystemsManager } from "@/lib/systems-manager";
import { db } from "@/lib/db";
import { pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq, and } from "drizzle-orm";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

/**
 * Helper to make authenticated requests to the point endpoint
 */
async function getPointEndpoint(systemId: number, pointId: number) {
  const response = await fetch(
    `${BASE_URL}/api/system/${systemId}/point/${pointId}`,
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
    `${BASE_URL}/api/system/${systemId}/point/${pointId}`,
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

describe("GET /api/system/[systemId]/point/[pointId]", () => {
  let testSystemId: number;
  let testPointId: number;

  beforeAll(async () => {
    // Get a test system from the database
    const systemsManager = SystemsManager.getInstance();
    const systems = await systemsManager.getAllSystems();

    if (systems.length === 0) {
      throw new Error("No systems in database for testing");
    }

    testSystemId = systems[0].id;

    // Find a point for this system
    const [point] = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.systemId, testSystemId))
      .limit(1);

    if (!point) {
      throw new Error("No points found for test system");
    }

    testPointId = point.index;
  });

  describe("Authentication", () => {
    it("should return 200 with x-claude header in development", async () => {
      const { status } = await getPointEndpoint(testSystemId, testPointId);
      expect(status).toBe(200);
    });

    it("should return 401 without x-claude header", async () => {
      const response = await fetch(
        `${BASE_URL}/api/system/${testSystemId}/point/${testPointId}`,
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

describe("PATCH /api/system/[systemId]/point/[pointId]", () => {
  let testSystemId: number;
  let testPointId: number;
  let originalPointData: any;

  beforeAll(async () => {
    // Get a test system from the database
    const systemsManager = SystemsManager.getInstance();
    const systems = await systemsManager.getAllSystems();

    if (systems.length === 0) {
      throw new Error("No systems in database for testing");
    }

    testSystemId = systems[0].id;

    // Find a point for this system
    const [point] = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.systemId, testSystemId))
      .limit(1);

    if (!point) {
      throw new Error("No points found for test system");
    }

    testPointId = point.index;

    // Store original data to restore later
    originalPointData = {
      type: point.type,
      subtype: point.subtype,
      extension: point.extension,
      displayName: point.displayName,
      alias: point.alias,
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

    it("should update type, subtype, and extension", async () => {
      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        {
          type: "source",
          subtype: "test_subtype",
          extension: "test_ext",
        },
      );

      expect(status).toBe(200);
      expect(data.point.type).toBe("source");
      expect(data.point.subtype).toBe("test_subtype");
      expect(data.point.extension).toBe("test_ext");
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

    it("should update alias with valid format", async () => {
      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        { alias: "test_alias_123" },
      );

      expect(status).toBe(200);
      expect(data.point.alias).toBe("test_alias_123");

      // Clear alias
      await patchPointEndpoint(testSystemId, testPointId, { alias: null });
    });
  });

  describe("Validation", () => {
    it("should reject invalid alias format", async () => {
      const { status, data } = await patchPointEndpoint(
        testSystemId,
        testPointId,
        { alias: "invalid-alias!" },
      );

      expect(status).toBe(400);
      expect(data.error).toContain("Invalid alias");
    });

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
