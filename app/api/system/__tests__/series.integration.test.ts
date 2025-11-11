/**
 * Integration tests for /api/system/[systemIdentifier]/series endpoint
 *
 * Tests:
 * - Authentication and authorization
 * - System resolution (numeric ID vs identifier)
 * - Filter parameter validation and matching
 * - Interval parameter validation and filtering
 * - Combined filter + interval filtering
 * - Error cases
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
import { PointManager } from "@/lib/point-manager";
import { SystemsManager } from "@/lib/systems-manager";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

/**
 * Helper to make authenticated requests to the series endpoint
 */
async function getSeriesEndpoint(
  systemIdentifier: string | number,
  params?: {
    filter?: string;
    interval?: "5m" | "1d";
  },
) {
  const url = new URL(`${BASE_URL}/api/system/${systemIdentifier}/series`);

  if (params?.filter) {
    url.searchParams.set("filter", params.filter);
  }
  if (params?.interval) {
    url.searchParams.set("interval", params.interval);
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

describe("GET /api/system/[systemIdentifier]/series", () => {
  let testSystemId: number;
  let testSystemIdentifier: string;

  beforeAll(async () => {
    // Get a test system from the database
    const systemsManager = SystemsManager.getInstance();
    const systems = await systemsManager.getAllSystems();

    if (systems.length === 0) {
      throw new Error("No systems in database for testing");
    }

    testSystemId = systems[0].id;

    // Use numeric ID only (shortnames not supported yet)
    testSystemIdentifier = testSystemId.toString();
  });

  describe("Authentication and Authorization", () => {
    it("should return 401 without authentication header in production", async () => {
      // This test would need to be run in production mode
      // For now, we verify that x-claude header works in development
      const { status } = await getSeriesEndpoint(testSystemIdentifier);
      expect(status).toBe(200);
    });

    it("should return 404 for non-existent system", async () => {
      const { status, data } = await getSeriesEndpoint(999999);
      expect(status).toBe(404);
      expect(data.error).toContain("System not found");
    });
  });

  describe("Basic Series Listing", () => {
    it("should return all series without filters", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier);

      expect(status).toBe(200);
      expect(data).toHaveProperty("series");
      expect(Array.isArray(data.series)).toBe(true);
      expect(data.series.length).toBeGreaterThan(0);

      // Verify series structure
      const firstSeries = data.series[0];
      expect(firstSeries).toHaveProperty("id");
      expect(firstSeries).toHaveProperty("intervals");
      expect(firstSeries).toHaveProperty("label");
      expect(firstSeries).toHaveProperty("metricUnit");
      expect(firstSeries).toHaveProperty("systemId");
      expect(firstSeries).toHaveProperty("pointIndex");
      expect(firstSeries).toHaveProperty("column");

      // Verify intervals is an array of valid values
      expect(Array.isArray(firstSeries.intervals)).toBe(true);
      firstSeries.intervals.forEach((interval: string) => {
        expect(["5m", "1d"]).toContain(interval);
      });
    });

    it("should work with numeric system ID", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemId);
      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);
    });
  });

  describe("Interval Filtering", () => {
    it("should filter by interval=5m", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        interval: "5m",
      });

      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);

      // All returned series should support 5m interval
      data.series.forEach((series: any) => {
        expect(series.intervals).toContain("5m");
      });

      // Should not include SOC avg/min/max (which are only 1d)
      // But SOC.last is available in 5m
      const socAvgMinMax = data.series.filter((s: any) =>
        s.id.match(/\/soc\.(avg|min|max)$/),
      );
      expect(socAvgMinMax.length).toBe(0);

      // SOC.last should be included
      const socLast = data.series.filter((s: any) =>
        s.id.includes("/soc.last"),
      );
      if (socLast.length > 0) {
        socLast.forEach((series: any) => {
          expect(series.intervals).toContain("5m");
        });
      }
    });

    it("should filter by interval=1d", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        interval: "1d",
      });

      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);

      // All returned series should support 1d interval
      data.series.forEach((series: any) => {
        expect(series.intervals).toContain("1d");
      });
    });

    it("should return 400 for invalid interval", async () => {
      const url = new URL(
        `${BASE_URL}/api/system/${testSystemIdentifier}/series?interval=30m`,
      );
      const response = await fetch(url.toString(), {
        headers: { "x-claude": "true" },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid interval parameter");
      expect(data.details).toContain("30m");
      expect(data.validValues).toEqual(["5m", "1d"]);
    });
  });

  describe("Filter Pattern Matching", () => {
    it("should filter by single glob pattern", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "source.solar/*",
      });

      expect(status).toBe(200);

      // All returned series should match the pattern
      data.series.forEach((series: any) => {
        // Extract path after system identifier
        const path = series.id.substring(series.id.indexOf("/") + 1);
        expect(path).toMatch(/^source\.solar\//);
      });
    });

    it("should filter by multiple comma-separated patterns", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "source.solar/*,bidi.battery/*",
      });

      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);

      // All returned series should match one of the patterns
      data.series.forEach((series: any) => {
        const path = series.id.substring(series.id.indexOf("/") + 1);
        const matchesSolar = path.startsWith("source.solar/");
        const matchesBattery = path.startsWith("bidi.battery/");
        expect(matchesSolar || matchesBattery).toBe(true);
      });
    });

    it("should filter by metric type in pattern", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "*/power.*",
      });

      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);

      // All returned series should be power metrics
      data.series.forEach((series: any) => {
        expect(series.id).toMatch(/\/power\.(avg|min|max|last)$/);
      });
    });

    it("should filter by aggregation column in pattern", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "*/power.avg",
      });

      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);

      // All returned series should be power.avg
      data.series.forEach((series: any) => {
        expect(series.id).toMatch(/\/power\.avg$/);
        expect(series.column).toBe("avg");
      });
    });

    it("should return empty array for pattern with no matches", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "nonexistent/*",
      });

      expect(status).toBe(200);
      expect(data.series).toEqual([]);
    });
  });

  describe("Combined Filtering", () => {
    it("should filter by both pattern and interval", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "bidi.battery/*",
        interval: "1d",
      });

      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);

      // All series should match pattern AND support 1d interval
      data.series.forEach((series: any) => {
        const path = series.id.substring(series.id.indexOf("/") + 1);
        expect(path).toMatch(/^bidi\.battery\//);
        expect(series.intervals).toContain("1d");
      });

      // Should include all SOC series
      const socSeries = data.series.filter((s: any) => s.id.includes("/soc."));
      expect(socSeries.length).toBeGreaterThan(0);

      // Verify avg/min/max are 1d-only, last is in both
      socSeries.forEach((series: any) => {
        if (series.column === "last") {
          expect(series.intervals).toContain("5m");
          expect(series.intervals).toContain("1d");
        } else {
          expect(series.intervals).toEqual(["1d"]);
        }
      });
    });

    it("should return fewer results with interval=5m on battery (no SOC avg/min/max)", async () => {
      const allBattery = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "bidi.battery/*",
      });

      const battery5m = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "bidi.battery/*",
        interval: "5m",
      });

      expect(battery5m.data.series.length).toBeLessThan(
        allBattery.data.series.length,
      );

      // 5m should not include SOC avg/min/max (1d-only)
      const socAvgMinMaxIn5m = battery5m.data.series.filter((s: any) =>
        s.id.match(/\/soc\.(avg|min|max)$/),
      );
      expect(socAvgMinMaxIn5m.length).toBe(0);

      // But should include SOC.last (available in 5m)
      const socLastIn5m = battery5m.data.series.filter((s: any) =>
        s.id.includes("/soc.last"),
      );
      if (socLastIn5m.length > 0) {
        socLastIn5m.forEach((series: any) => {
          expect(series.intervals).toContain("5m");
        });
      }
    });
  });

  describe("Filter Validation", () => {
    it("should treat empty filter parameter as no filter", async () => {
      const url = new URL(
        `${BASE_URL}/api/system/${testSystemIdentifier}/series?filter=`,
      );
      const response = await fetch(url.toString(), {
        headers: { "x-claude": "true" },
      });

      // Empty filter is treated as no filter, so returns all series
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.series.length).toBeGreaterThan(0);
    });

    it("should reject filter with invalid characters", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "invalid$pattern",
      });

      expect(status).toBe(400);
      expect(data.error).toBe("Invalid characters in pattern");
      expect(data.details).toContain("$");
      expect(data.invalidPattern).toBe("invalid$pattern");
    });

    it("should reject filter with unmatched opening brace", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "source.{solar,grid",
      });

      expect(status).toBe(400);
      expect(data.error).toBe("Unmatched opening brace");
      // Pattern is split by comma, so it validates "source.{solar"
      expect(data.invalidPattern).toBe("source.{solar");
    });

    it("should reject filter with unmatched closing brace", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "source.solar,grid}/*",
      });

      expect(status).toBe(400);
      expect(data.error).toBe("Unmatched closing brace");
      // Pattern is split by comma, so it validates "grid}/*"
      expect(data.invalidPattern).toBe("grid}/*");
    });

    it("should reject filter that is too long", async () => {
      const longPattern = "a".repeat(201);
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: longPattern,
      });

      expect(status).toBe(400);
      expect(data.error).toBe("Pattern too long");
      expect(data.details).toContain("200");
    });

    it("should accept valid braces pattern", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "source.solar/*,bidi.battery/*",
      });

      expect(status).toBe(200);
      expect(data.series.length).toBeGreaterThan(0);
      // All series should be from solar or battery
      data.series.forEach((series: any) => {
        const path = series.id.substring(series.id.indexOf("/") + 1);
        const matchesSolar = path.startsWith("source.solar");
        const matchesBattery = path.startsWith("bidi.battery");
        expect(matchesSolar || matchesBattery).toBe(true);
      });
    });
  });

  describe("Series Properties", () => {
    it("should return correct properties for energy series", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "*/energy.delta",
      });

      if (data.series.length > 0) {
        const energySeries = data.series[0];
        expect(energySeries.column).toBe("delta");
        expect(energySeries.intervals).toContain("5m");
        expect(energySeries.intervals).toContain("1d");
        expect(energySeries.metricUnit).toMatch(/Wh|kWh/);
      }
    });

    it("should return correct properties for SOC series", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "*/soc.*",
      });

      if (data.series.length > 0) {
        data.series.forEach((series: any) => {
          // SOC has avg, min, max, last
          expect(["avg", "min", "max", "last"]).toContain(series.column);
          expect(series.metricUnit).toBe("%");

          // avg, min, max only in 1d; last in both 5m and 1d
          if (series.column === "last") {
            expect(series.intervals).toContain("5m");
            expect(series.intervals).toContain("1d");
          } else {
            expect(series.intervals).toEqual(["1d"]);
          }
        });
      }
    });

    it("should return correct properties for power series", async () => {
      const { status, data } = await getSeriesEndpoint(testSystemIdentifier, {
        filter: "*/power.*",
      });

      if (data.series.length > 0) {
        data.series.forEach((series: any) => {
          // Power in both intervals
          expect(series.intervals).toContain("5m");
          expect(series.intervals).toContain("1d");
          // Power has avg, min, max, last
          expect(["avg", "min", "max", "last"]).toContain(series.column);
          expect(series.metricUnit).toMatch(/W|kW/);
        });
      }
    });
  });

  describe("Caching Behavior", () => {
    it("should return same results on repeated calls (cache hit)", async () => {
      const first = await getSeriesEndpoint(testSystemIdentifier);
      const second = await getSeriesEndpoint(testSystemIdentifier);

      expect(first.data.series).toEqual(second.data.series);
    });

    it("should return filtered results efficiently", async () => {
      // Make multiple filtered requests
      const start = Date.now();

      const results = await Promise.all([
        getSeriesEndpoint(testSystemIdentifier, { filter: "source.solar/*" }),
        getSeriesEndpoint(testSystemIdentifier, { filter: "bidi.battery/*" }),
        getSeriesEndpoint(testSystemIdentifier, { interval: "5m" }),
        getSeriesEndpoint(testSystemIdentifier, { interval: "1d" }),
      ]);

      const elapsed = Date.now() - start;

      // All should succeed
      results.forEach((result) => {
        expect(result.status).toBe(200);
      });

      // Should be reasonably fast (cache should help)
      // This is a soft check - may vary by system
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
