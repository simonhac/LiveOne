import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { PointManager } from "@/lib/point-manager";
import {
  resolveSystemFromIdentifier,
  buildSiteIdFromSystem,
} from "@/lib/series-path-utils";

/**
 * Generate a series path (pointPath/pointFlavour format) for a point
 */
function generateSeriesPath(
  point: {
    getPath: () => string | null;
    metricType: string;
    shortName: string | null;
    id: number;
  },
  interval: "5m" | "1d",
): string {
  const aggregationType =
    interval === "1d"
      ? point.metricType === "energy"
        ? "delta"
        : "avg"
      : point.metricType === "energy"
        ? "delta"
        : point.metricType === "soc"
          ? "last"
          : "avg";

  const pointPath = point.getPath();
  if (pointPath) {
    return `${pointPath}/${point.metricType}.${aggregationType}`;
  }

  if (point.shortName) {
    return point.shortName;
  }

  return `${point.id}/${point.metricType}.${aggregationType}`;
}

/**
 * GET /api/system/{systemIdentifier}/series
 *
 * Returns all available series for a system
 *
 * @param systemIdentifier - Numeric system ID (e.g., "3")
 *
 * Query params:
 *   - interval: "5m" | "1d" (optional, defaults to "5m") - Filter by interval type
 *
 * Response:
 * {
 *   "series": [
 *     {
 *       "id": "system.3/source.solar/power.avg",
 *       "label": "Solar Power",
 *       "unit": "W"
 *     }
 *   ]
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemIdentifier: string }> },
) {
  try {
    // Step 1: Authenticate
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Step 2: Resolve systemIdentifier to system
    const { systemIdentifier } = await params;
    const system = await resolveSystemFromIdentifier(systemIdentifier);

    if (!system) {
      return NextResponse.json(
        { error: `System not found: ${systemIdentifier}` },
        { status: 404 },
      );
    }

    // Step 3: Check authorization
    const isAdmin = userId === "user_2dP9S3dKAGMmc52ijrI9jwZLCGF";
    if (!isAdmin && system.ownerClerkUserId !== userId) {
      return NextResponse.json(
        { error: "Forbidden: You do not have access to this system" },
        { status: 403 },
      );
    }

    // Step 4: Parse optional interval filter
    const searchParams = request.nextUrl.searchParams;
    const intervalParam = searchParams.get("interval");
    const interval = intervalParam === "1d" ? "1d" : "5m";

    // Step 5: Get all active points for the system
    const pointManager = PointManager.getInstance();
    const allPoints = await pointManager.getPointsForSystem(system.id);

    // Filter to active points with type set
    const activePoints = allPoints.filter((p) => p.type && p.active);

    // Step 6: Build series list
    const systemId = buildSiteIdFromSystem(system);
    const seriesList = [];

    if (interval === "1d") {
      // For daily: include all points (including SOC with avg/min/max variants)
      for (const point of activePoints) {
        if (point.metricType === "soc") {
          // SOC gets three series for daily
          const pointPath = point.getPath();
          const basePath = pointPath || `${point.id}`;

          seriesList.push({
            id: `${systemId}/${basePath}/soc.avg`,
            label: `${point.name} (avg)`,
            unit: point.metricUnit,
          });
          seriesList.push({
            id: `${systemId}/${basePath}/soc.min`,
            label: `${point.name} (min)`,
            unit: point.metricUnit,
          });
          seriesList.push({
            id: `${systemId}/${basePath}/soc.max`,
            label: `${point.name} (max)`,
            unit: point.metricUnit,
          });
        } else {
          const seriesPath = generateSeriesPath(point, "1d");
          seriesList.push({
            id: `${systemId}/${seriesPath}`,
            label: point.name,
            unit: point.metricUnit,
          });
        }
      }
    } else {
      // For 5m: exclude SOC
      for (const point of activePoints) {
        if (point.metricType === "soc") continue;

        const seriesPath = generateSeriesPath(point, "5m");
        seriesList.push({
          id: `${systemId}/${seriesPath}`,
          label: point.name,
          unit: point.metricUnit,
        });
      }
    }

    // Sort by ID for consistent ordering
    seriesList.sort((a, b) => a.id.localeCompare(b.id));

    return NextResponse.json({ series: seriesList });
  } catch (error) {
    console.error("Error fetching series:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
