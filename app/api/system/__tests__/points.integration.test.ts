/**
 * Integration tests for /api/system/[systemIdentifier]/points endpoint
 *
 * Tests:
 * - Authentication and authorization
 * - System identifier validation (numeric ID)
 * - Short mode (array of paths)
 * - Full mode (detailed point information)
 * - PointPath formats (typed paths vs fallback numeric paths)
 * - Error cases
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
import { SystemsManager } from "@/lib/systems-manager";
import { PointPath } from "@/lib/identifiers";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

/**
 * Helper to make authenticated requests to the points endpoint
 */
async function getPointsEndpoint(
  systemIdentifier: string | number,
  short?: boolean,
) {
  const url = new URL(`${BASE_URL}/api/system/${systemIdentifier}/points`);

  if (short !== undefined) {
    url.searchParams.set("short", short.toString());
  }

  const response = await fetch(url.toString(), {
    headers: {
      "x-claude": "true", // Development auth bypass
    },
  });

  return {
    status: response.status,
    data: await response.json(),
  };
}

describe("GET /api/system/[systemIdentifier]/points", () => {
  let testSystemId: number;

  beforeAll(async () => {
    // Get a test system from the database
    const systemsManager = SystemsManager.getInstance();
    const systems = await systemsManager.getAllSystems();

    if (systems.length === 0) {
      throw new Error("No systems in database for testing");
    }

    testSystemId = systems[0].id;
  });

  describe("Authentication and Authorization", () => {
    it("should return 200 with x-claude header in development", async () => {
      const { status } = await getPointsEndpoint(testSystemId);
      expect(status).toBe(200);
    });

    it("should return 401 without x-claude header in development", async () => {
      const url = new URL(`${BASE_URL}/api/system/${testSystemId}/points`);

      const response = await fetch(url.toString(), {
        headers: {
          // No x-claude header
        },
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should return 404 for non-existent system", async () => {
      const { status, data } = await getPointsEndpoint(999999);
      expect(status).toBe(404);
      expect(data.error).toContain("System not found");
    });
  });

  describe("System Identifier Validation", () => {
    it("should accept numeric system ID", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId);
      expect(status).toBe(200);
      expect(data.points).toBeDefined();
      expect(Array.isArray(data.points)).toBe(true);
    });

    it("should accept numeric ID as string", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId.toString());
      expect(status).toBe(200);
      expect(data.points).toBeDefined();
    });

    it("should reject invalid system identifier format", async () => {
      const { status, data } = await getPointsEndpoint("invalid-format");
      expect(status).toBe(400);
      expect(data.error).toContain("Invalid system identifier");
    });

    it("should reject user.shortname format (not yet implemented)", async () => {
      const { status, data } = await getPointsEndpoint("user.system");
      expect(status).toBe(400);
      expect(data.error).toContain("User-scoped identifiers not yet supported");
    });
  });

  describe("Full Mode (default)", () => {
    it("should return detailed point information", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId);

      expect(status).toBe(200);
      expect(data.points).toBeDefined();
      expect(Array.isArray(data.points)).toBe(true);
      expect(data.points.length).toBeGreaterThan(0);

      // Check first point has expected structure
      const firstPoint = data.points[0];
      expect(firstPoint).toHaveProperty("path");
      expect(firstPoint).toHaveProperty("name");
      expect(firstPoint).toHaveProperty("metricType");
      expect(firstPoint).toHaveProperty("metricUnit");
      expect(firstPoint).toHaveProperty("reference");
      expect(firstPoint).toHaveProperty("active");

      // Validate types
      expect(typeof firstPoint.path).toBe("string");
      expect(typeof firstPoint.name).toBe("string");
      expect(typeof firstPoint.metricType).toBe("string");
      expect(typeof firstPoint.metricUnit).toBe("string");
      expect(typeof firstPoint.reference).toBe("string");
      expect(typeof firstPoint.active).toBe("boolean");
    });

    it("should return only active points", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId);

      expect(status).toBe(200);
      expect(data.points.every((p: any) => p.active === true)).toBe(true);
    });

    it("should have valid PointReference format (systemId.pointId)", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId);

      expect(status).toBe(200);
      const references = data.points.map((p: any) => p.reference);

      // All references should match systemId.pointId format
      references.forEach((ref: string) => {
        expect(ref).toMatch(/^\d+\.\d+$/);
        const [sysId] = ref.split(".");
        expect(parseInt(sysId)).toBe(testSystemId);
      });
    });
  });

  describe("Short Mode", () => {
    it("should return array of path strings with short=true", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId, true);

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      // All items should be strings
      data.forEach((path: any) => {
        expect(typeof path).toBe("string");
      });
    });

    it("should return detailed objects with short=false", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId, false);

      expect(status).toBe(200);
      expect(data.points).toBeDefined();
      expect(Array.isArray(data.points)).toBe(true);
      expect(data.points.length).toBeGreaterThan(0);
      expect(data.points[0]).toHaveProperty("path");
      expect(data.points[0]).toHaveProperty("name");
    });
  });

  describe("PointPath Format Validation", () => {
    it("should return valid PointPath strings that can be parsed", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId, true);

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);

      // All returned paths should be parseable by PointPath.parse()
      data.forEach((pathStr: string) => {
        const parsed = PointPath.parse(pathStr);
        expect(parsed).not.toBeNull();

        // Round-trip should match
        expect(parsed?.toString()).toBe(pathStr);
      });
    });

    it("should return typed paths in format type.subtype.extension/metricType", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId, true);

      expect(status).toBe(200);

      // Find a point with full type hierarchy (if exists)
      const typedPaths = data.filter((path: string) => {
        const parsed = PointPath.parse(path);
        return parsed && !parsed.isFallback;
      });

      if (typedPaths.length > 0) {
        typedPaths.forEach((pathStr: string) => {
          const parsed = PointPath.parse(pathStr);
          expect(parsed).not.toBeNull();
          expect(parsed?.isFallback).toBe(false);
          expect(parsed?.type).toBeTruthy();
          expect(parsed?.metricType).toBeTruthy();

          // Should match format: type[.subtype[.extension]]/metricType
          expect(pathStr).toMatch(/^[a-z]+(\.[a-z_]+)*\/[a-z]+$/);
        });
      }
    });

    it("should return fallback paths in format pointIndex/metricType", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId, true);

      expect(status).toBe(200);

      // Find fallback paths (numeric-only point identifier)
      const fallbackPaths = data.filter((path: string) => {
        const parsed = PointPath.parse(path);
        return parsed && parsed.isFallback;
      });

      if (fallbackPaths.length > 0) {
        fallbackPaths.forEach((pathStr: string) => {
          const parsed = PointPath.parse(pathStr);
          expect(parsed).not.toBeNull();
          expect(parsed?.isFallback).toBe(true);
          expect(parsed?.pointIndex).toBeGreaterThan(0);
          expect(parsed?.metricType).toBeTruthy();

          // Should match format: number/metricType
          expect(pathStr).toMatch(/^\d+\/[a-z]+$/);
        });
      }
    });

    it("should include metricType in all paths", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId, true);

      expect(status).toBe(200);

      // All paths must contain a slash and metric type
      data.forEach((pathStr: string) => {
        expect(pathStr).toContain("/");
        const [, metricType] = pathStr.split("/");
        expect(metricType).toBeTruthy();
        expect(metricType.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Data Consistency", () => {
    it("should return same points in both short and full mode", async () => {
      const shortResponse = await getPointsEndpoint(testSystemId, true);
      const fullResponse = await getPointsEndpoint(testSystemId, false);

      expect(shortResponse.status).toBe(200);
      expect(fullResponse.status).toBe(200);

      const shortPaths = shortResponse.data;
      const fullPaths = fullResponse.data.points.map((p: any) => p.path);

      expect(shortPaths.length).toBe(fullPaths.length);
      expect(shortPaths.sort()).toEqual(fullPaths.sort());
    });

    it("should have consistent reference format across all points", async () => {
      const { status, data } = await getPointsEndpoint(testSystemId, false);

      expect(status).toBe(200);

      // All references should follow systemId.pointId format
      const referencePattern = /^\d+\.\d+$/;
      data.points.forEach((point: any) => {
        expect(point.reference).toMatch(referencePattern);
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle system with no points gracefully", async () => {
      // Create or find a system with no active points
      // For now, just test that the endpoint returns an empty array
      const { status, data } = await getPointsEndpoint(10000, true);

      // Should either be 404 (system not found) or 200 with empty array
      if (status === 200) {
        expect(Array.isArray(data)).toBe(true);
      } else {
        expect(status).toBe(404);
      }
    });

    it("should reject zero as system ID", async () => {
      const { status, data } = await getPointsEndpoint(0);
      expect(status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it("should reject negative system ID", async () => {
      const { status, data } = await getPointsEndpoint(-1);
      expect(status).toBe(400);
      expect(data.error).toBeDefined();
    });
  });
});
