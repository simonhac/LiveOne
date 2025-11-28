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
 * @param showActive - Optional boolean. If "true", includes inactive points and adds "active" field
 *
 * Examples:
 * - GET /api/system/3/points
 *   Returns active points only (no "active" field):
 *   {
 *     "points": [
 *       {
 *         "logicalPath": "source.solar/power",
 *         "name": "Solar Power",
 *         "metricType": "power",
 *         "metricUnit": "W",
 *         "reference": "3.1"
 *       }
 *     ]
 *   }
 *
 * - GET /api/system/3/points?showActive=true
 *   Returns all points with "active" field:
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
 *   Returns just the paths (active only):
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

    // Extract system info for constructing full physical path
    const { system } = authResult;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const shortMode = searchParams.get("short") === "true";
    const showActive = searchParams.get("showActive") === "true";

    // Get points for the system using PointManager
    const pointManager = PointManager.getInstance();
    const points = await pointManager.getActivePointsForSystem(
      systemId,
      false, // typedOnly = false means include fallback paths
      showActive, // includeInactive = true when showActive is requested
    );

    // Filter to only include points with non-null logical path
    const validPoints = points.filter(
      (point) => point.getLogicalPath() != null,
    );

    // Serialize based on mode
    if (shortMode) {
      // Return just the paths as an array of strings
      const paths = validPoints.map((point) => point.getLogicalPath()!);
      return NextResponse.json(paths);
    } else {
      // Return detailed point information
      // Only include "active" field when showActive=true
      const pointsData = validPoints.map((point) => {
        // Construct full physical path: liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}
        const fullPhysicalPath = `liveone/${system.vendorType}/${system.vendorSiteId}/${point.physicalPathTail}`;
        const base = {
          logicalPath: point.getLogicalPath(),
          physicalPath: fullPhysicalPath,
          name: point.name,
          metricType: point.metricType,
          metricUnit: point.metricUnit,
          reference: point.getReference().toString(),
        };
        return showActive ? { ...base, active: point.active } : base;
      });

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
