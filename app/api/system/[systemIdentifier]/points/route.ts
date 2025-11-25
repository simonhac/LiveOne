import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SystemIdentifier } from "@/lib/identifiers";
import { resolveSystemFromIdentifier } from "@/lib/series-path-utils";
import { isUserAdmin } from "@/lib/auth-utils";
import { PointManager } from "@/lib/point/point-manager";

/**
 * GET /api/system/{systemIdentifier}/points
 *
 * Returns all points for a system with their PointPath identifiers
 *
 * @param systemIdentifier - System identifier (numeric ID like "3" or user.shortname like "simon.kinkora")
 * @param short - Optional boolean parameter. If "true", returns just an array of path strings
 *
 * Examples:
 * - GET /api/system/3/points
 *   Returns detailed point information:
 *   {
 *     "points": [
 *       {
 *         "path": "source.solar/power",
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
  { params }: { params: Promise<{ systemIdentifier: string }> },
) {
  try {
    // Step 1: Authenticate
    // In development, allow using X-CLAUDE header to bypass auth
    let userId: string;
    let isAdmin = false;

    if (
      process.env.NODE_ENV === "development" &&
      request.headers.get("x-claude") === "true"
    ) {
      userId = "claude-dev";
      isAdmin = true;
    } else {
      const authResult = await auth();
      if (!authResult.userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      userId = authResult.userId;
      // Check if user is admin using proper auth utils
      isAdmin = await isUserAdmin(userId);
    }

    // Step 2: Parse and validate systemIdentifier
    const { systemIdentifier: systemIdStr } = await params;

    // Parse system identifier
    const systemIdentifier = SystemIdentifier.parse(systemIdStr);

    if (!systemIdentifier) {
      return NextResponse.json(
        {
          error: "Invalid system identifier",
          details: `System identifier must be a numeric ID or user.shortname format, got "${systemIdStr}"`,
        },
        { status: 400 },
      );
    }

    // For now, only support numeric IDs (user.shortname requires additional lookup logic)
    if (systemIdentifier.type !== "id") {
      return NextResponse.json(
        {
          error: "User-scoped identifiers not yet supported",
          details: "Please use numeric system ID",
        },
        { status: 400 },
      );
    }

    const systemId = systemIdentifier.id!; // Safe because we checked type === "id"

    // Step 3: Resolve systemId to system and check it exists
    const system = await resolveSystemFromIdentifier(systemId.toString());

    if (!system) {
      return NextResponse.json(
        { error: `System not found: ${systemIdStr}` },
        { status: 404 },
      );
    }

    // Step 4: Check authorization
    if (!isAdmin && system.ownerClerkUserId !== userId) {
      return NextResponse.json(
        { error: "Forbidden: You do not have access to this system" },
        { status: 403 },
      );
    }

    // Step 5: Parse query parameters
    const { searchParams } = new URL(request.url);
    const shortMode = searchParams.get("short") === "true";

    // Step 6: Get all active points for the system using PointManager
    const pointManager = PointManager.getInstance();
    const points = await pointManager.getActivePointsForSystem(
      systemId,
      false, // typedOnly = false means include fallback paths
    );

    // Step 7: Serialize based on mode
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
