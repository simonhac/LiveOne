import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { PointManager } from "@/lib/point/point-manager";

/**
 * GET /api/system/{systemId}/points
 *
 * Returns all points for a system with their PointPath identifiers
 *
 * @param systemId - Numeric system ID
 * @param short - Optional boolean parameter. If "true", returns just an array of path strings
 *
 * Examples:
 * - GET /api/system/3/points
 *   Returns detailed point information:
 *   {
 *     "points": [
 *       {
 *         "logicalPath": "source.solar/power",
 *         "name": "Solar Power",
 *         "metricType": "power",
 *         "metricUnit": "W",
 *         "reference": "3.1",
 *         "active": true
 *       }
 *     ]
 *   }
 *
 * - GET /api/system/3/points?short=true
 *   Returns just the paths:
 *   [
 *     "source.solar/power",
 *     "load.hvac/power",
 *     "bidi.battery/power"
 *   ]
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    // Parse and validate systemId
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr, 10);

    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid system ID", details: "System ID must be numeric" },
        { status: 400 },
      );
    }

    // Authenticate and authorize
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const shortMode = searchParams.get("short") === "true";

    // Get all active points for the system using PointManager
    const pointManager = PointManager.getInstance();
    const points = await pointManager.getActivePointsForSystem(
      systemId,
      false, // typedOnly = false means include fallback paths
    );

    // Serialize based on mode
    if (shortMode) {
      // Return just the paths as an array of strings
      const paths = points.map((point) => point.getPath());
      return NextResponse.json(paths);
    } else {
      // Return detailed point information
      const pointsData = points.map((point) => ({
        logicalPath: point.getPath(),
        physicalPath: point.originSubId
          ? `${point.originId}.${point.originSubId}`
          : point.originId,
        name: point.name,
        metricType: point.metricType,
        metricUnit: point.metricUnit,
        reference: point.getReference().toString(),
        active: point.active,
      }));

      return NextResponse.json({ points: pointsData });
    }
  } catch (error) {
    console.error("Error fetching points:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 },
    );
  }
}
